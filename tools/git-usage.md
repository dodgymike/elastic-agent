# Git tool usage

## Purpose

Inspect a Git repository with four read-only modes (`status`, `log`, `diff`,
`ls-files`), stage selected changes, or commit staged changes. Git is invoked
directly (never through a shell), so paths, revisions, and commit messages are
passed as literal arguments and cannot alter the command being run.

## When to use

Use a read-only `mode` to inspect repository state. Use `action: "stage"` or
`action: "commit"` for the two mutating operations, following the runtime's
commit instruction for the current step. Use `ExecuteCommand` only for git
operations outside these modes and actions.

## Required parameters

Exactly one of these is required:

- `mode` (string): one of `status`, `log`, `diff`, or `ls-files`.
- `action` (string): one of `stage` or `commit`.

The legacy `action: "list"` is still accepted as an alias for
`mode: "status"`.

## Read-only modes

### `mode: "status"`

Lists working-tree changes.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `format` | string | `short` (`--short`), `porcelain` (`--porcelain=v1`), or `branch` (`--branch`). |
| `branch` | boolean | Append `--branch` when `format` is `short` or `porcelain`. |
| `paths` | string[] | Optional repo-relative path filters. |
| `cwd` | string | Repository directory; defaults to the current directory. |

When neither `format` nor `branch` is supplied, the tool runs
`git status --porcelain=v1 --branch` (the stable machine-readable format).

### `mode: "log"`

Lists commit history.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `oneline` | boolean | Use `--oneline`; defaults to `true`. |
| `stat` | boolean | Append `--stat` for a per-commit diffstat. |
| `maxCount` | number | Limit to `-N` commits; must be a positive integer. |
| `all` | boolean | Include commits reachable from all refs (`--all`). |
| `revision` | string | Revision or range (for example `HEAD` or `main..HEAD`); defaults to `HEAD` when omitted. |
| `path` | string | Convenience single path filter. |
| `paths` | string[] | Optional repo-relative path filters. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "diff"`

Shows worktree, index, or revision diffs.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `staged` | boolean | Diff the index against HEAD (`--cached`). |
| `stat` | boolean | Show only a diffstat (`--stat`). |
| `check` | boolean | Check for whitespace errors (`--check`). |
| `revision` | string | Revision or range to diff. When omitted, diffs the unstaged worktree; pass `HEAD` to compare the worktree against HEAD. |
| `paths` | string[] | Optional repo-relative path filters. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "ls-files"`

Lists files known to the index.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `others` | boolean | List untracked files (`--others`). |
| `excludeStandard` | boolean | Honor standard ignore rules (`--exclude-standard`); implied by `others`. |
| `paths` | string[] | Optional repo-relative path filters. |
| `cwd` | string | Repository directory; defaults to the current directory. |

## Mutating actions

### `action: "stage"`

- `paths` (string[]): repo-relative paths to add to the index.
- `all` (boolean): stage all tracked and untracked changes, including
  deletions.

`stage` requires either one or more `paths` **or** `all: true`; specifying both
is an error. It never stages the whole repository by accident.

### `action: "commit"`

- `message` (string): commit message passed to `git commit -m`; required and
  non-empty.

## Result

Every call resolves with a structured result object:

- `command` (string[]): the git arguments that were run, excluding the `git`
  executable itself.
- `exitCode` (number): git's exit status; `0` means success.
- `stdout` (string): git standard output.
- `stderr` (string): git standard error.

## Formatted terminal output

The runtime first announces the call as `Git('mode')` (or `Git('action')`).
While git runs, an in-place timer line ticks on the same terminal line (for
example `⏱ 0.50s` in color mode, or `elapsed 0.50s` in non-TTY logs) and is
finalized with the total elapsed time when the command completes or fails.
Terminal state is cleaned up on exit.

For `mode: "status"` success, the terminal renders a formatted status view with
sections for the branch, staged changes, unstaged changes, and untracked files.
Section headers and status codes use colors/icons in TTY mode and degrade to
plain text otherwise. A clean working tree renders an explicit
`working tree clean` empty-state.

For `log`, `diff`, and `ls-files` success, the terminal renders the
`Git('mode') ●` label followed by captured stdout and any non-empty stderr. A
non-zero git exit renders a red circle with `exit N` followed by stderr then
stdout diagnostics. For `stage` and `commit`, success renders `Git('stage')` or
`Git('commit')` followed by a green circle and captured stdout; stderr is
included only when non-empty. In no-color/non-TTY contexts the circles and
colors degrade to plain text while statuses and streams are still shown. No
`[SUCCESS]` or `[ERROR]` text prefix is ever emitted for a tool call.

## Redaction

The runtime redacts secret-shaped argument fields and error messages before
displaying them. Raw git stdout is shown as captured, so never diff or log a
file that may contain credentials, tokens, enrollment recipes, or other
secrets. `data.json` must never be read, staged, committed, or diffed.

## Error handling

- The tool validates the selected mode/action and its options. Validation
  `TypeError`s include: options that are not an object, a `cwd` that is not a
  non-empty string, an unknown `mode` or `action`, an invalid `format`, a
  `maxCount` that is not a positive integer, a non-string `revision`, `paths` +
  `all` conflict, `stage` without `paths` or `all`, a path that is empty or
  contains NUL, or an empty commit message.
- A non-zero `exitCode` is returned in the result rather than thrown; inspect
  `stdout`/`stderr` for the cause.
- Spawn error or termination by signal rejects the promise.

## Critical operating constraints

- `stage` requires either one or more `paths` **or** `all: true`; specifying
  both is an error. It never stages the whole repository by accident.
- `paths` must be non-empty, non-NUL strings; a `--` separator prevents a path
  such as `--intent-to-add` from being interpreted as an option.
- In `--review` mode during the execution phase, `commit` is rejected by the
  runtime (work is staged in a worktree; only the review step commits when
  satisfied).
- Stage only intended files and never commit secrets.

## Safe use

**Allowed**

- `mode: "status"`, `mode: "log"`, `mode: "diff"`, or `mode: "ls-files"` to
  inspect repository state with read-only commands.
- `action: "stage"` with explicit `paths` or `all: true` for intended files.
- `action: "commit"` of staged, reviewed work following the current step's
  commit instruction.

**Denied**

- Reading, staging, committing, or diffing `data.json`, credential stores,
  secret files, private keys, tokens, or enrollment recipes.
- Staging both `paths` and `all: true` in one call.
- Committing without a message, or committing in `--review` mode when the
  runtime rejects it.
- Force-pushing or rewriting remote history through shell commands.

**Dangerous examples (do not run)**

- `Git({ mode: "diff", paths: ["data.json"] })`
- `Git({ mode: "log", paths: ["data.json"] })`
- `Git({ action: "stage", all: true })` while secrets or `data.json` are
  untracked or modified.
- `Git({ action: "commit", message: "..." })` with a secret file staged.
- `Git({ action: "stage", paths: ["data.json"] })`

**Required permissions**

- `stage`: at least one non-empty `path` or `all: true`.
- `commit`: a non-empty `message` and staged work.

## Examples

1. Inspect working-tree state (stable machine-readable format):

   ```js
   await Git({ mode: "status" });
   ```

2. Short status with branch info:

   ```js
   await Git({ mode: "status", format: "short", branch: true });
   ```

3. Recent commit history:

   ```js
   await Git({ mode: "log", maxCount: 10, oneline: true });
   ```

4. Log one path across all refs:

   ```js
   await Git({ mode: "log", all: true, paths: ["tools/Git.tsx"] });
   ```

5. Unstaged worktree diff for one directory:

   ```js
   await Git({ mode: "diff", paths: ["tools"] });
   ```

6. Staged diff against HEAD:

   ```js
   await Git({ mode: "diff", staged: true, revision: "HEAD" });
   ```

7. Untracked files honoring ignore rules:

   ```js
   await Git({ mode: "ls-files", others: true, excludeStandard: true });
   ```

8. Stage one file:

   ```js
   await Git({ action: "stage", paths: ["tools/read-usage.md"] });
   ```

9. Stage everything:

   ```js
   await Git({ action: "stage", all: true });
   ```

10. Commit staged changes:

    ```js
    await Git({ action: "commit", message: "Add per-tool usage prompt files" });
    ```
