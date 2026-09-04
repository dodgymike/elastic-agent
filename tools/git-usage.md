# Git tool usage

## Purpose

Inspect a Git repository with four read-only modes (`status`, `log`, `diff`,
`ls-files`), manage linked worktrees with a strict `worktree` mode (`list`,
`add`, `remove`, `move`, `prune`), stage selected changes, or commit staged
changes. Git is invoked directly (never through a shell), so paths, revisions,
and commit messages are passed as literal arguments and cannot alter the
command being run.

## When to use

Use a read-only `mode` to inspect repository state. Use `mode: "worktree"` to
inspect or manage linked worktrees through the whitelisted `list`, `add`,
`remove`, `move`, and `prune` subcommands. Use `action: "stage"` or
`action: "commit"` for staging and committing, following the runtime's commit
instruction for the current step. Use `ExecuteCommand` only for git operations
outside these modes and actions.

## Required parameters

Exactly one of these is required:

- `mode` (string): one of `status`, `log`, `diff`, `ls-files`, or `worktree`.
- `action` (string): one of `stage` or `commit`.

When `mode: "worktree"` is selected, `subcommand` (string) is also required and
must be one of `list`, `add`, `remove`, `move`, or `prune`.

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

### `mode: "worktree"`

Inspect or manage linked worktrees through exactly five whitelisted
subcommands. `list` is read-only; `add`, `remove`, `move`, and `prune` are
mutating and are validated before any git process runs. Only the parameters
listed below are accepted for each subcommand; every other option, flag, or
field is rejected.

#### `subcommand: "list"` (read-only)

Lists linked worktrees.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `porcelain` | boolean | Append `--porcelain` for the stable machine-readable format. |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### `subcommand: "add"` (mutating)

Adds a new linked worktree.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `path` | string | Required. Worktree directory path; must resolve inside the managed `.worktrees` root. |
| `newBranch` | string | Create a new branch with `-b <newBranch>`. Must be a safe branch name (no whitespace/control characters, no leading `-`, no `..`, `@{`, `\`, `~`, `^`, `:`, `?`, `*`, or `[`, and no leading or trailing `/`). |
| `detach` | boolean | Detach HEAD with `--detach`. |
| `commitish` | string | Optional `<commit-ish>` positional to check out. Must be a non-empty string that does not contain NUL and does not start with `-`. |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### `subcommand: "remove"` (mutating)

Removes a linked worktree.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `path` | string | Required. Worktree path to remove. |
| `force` | boolean | Append `--force`. |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### `subcommand: "move"` (mutating)

Moves a linked worktree to a new path.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `oldPath` | string | Required. Source worktree path. |
| `newPath` | string | Required. Destination worktree path. |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### `subcommand: "prune"` (mutating)

Prunes stale worktree metadata. No extra parameters are accepted; the plain
safe form is the only accepted form.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### Worktree path policy

For every mutating worktree path (`add.path`, `remove.path`,
`move.oldPath`, `move.newPath`):

- The path must be a non-empty string with no NUL bytes and must not contain a
  `..` segment (path traversal is rejected after normalizing both `/` and `\`
  separators).
- The path must not start with `-`, which prevents a positional path from being
  interpreted as a git option.
- The path must not target `data.json` or any other protected/secret file:
  `.env*`, SSH private keys (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`),
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.netrc`, `.npmrc`, `.pypirc`,
  `.git-credentials`, `.htpasswd`, or basenames whose stem ends in a
  token/password/secret/credential variant.
- The canonical path (symlink-resolved when it already exists) must stay inside
  the workspace root (`cwd` when supplied, otherwise the current working
  directory).
- `add.path` is additionally required to be inside the managed worktrees root
  `<workspaceRoot>/.worktrees`, so the tool never creates a worktree outside
  the managed root.

Unsupported worktree options remain refused: for example `lock`, `unlock`,
`repair`, `--force` on `add`, `--expire` or `--dry-run` on `prune`, and every
other flag or field not listed above is rejected before any git process runs.

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

Every call that lets git run to a normal exit resolves with a structured
result object:

- `command` (string[]): the git arguments that were run, excluding the `git`
  executable itself.
- `exitCode` (number): git's exit status; `0` means success. A nonzero exit is
  returned here rather than thrown.
- `stdout` (string): git standard output, captured up to the 1 MiB per-stream
  limit.
- `stderr` (string): git standard error, captured up to the 1 MiB per-stream
  limit.

Abnormal execution (startup failure, stream error, the 60-second timeout,
signal termination, or output-limit overflow) does not resolve; it rejects
with a `GitProcessError` (see Error handling).

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

For `log`, `diff`, `ls-files`, and `worktree` success, the terminal renders the
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
- Invalid `mode: "worktree"` calls reject synchronously with a
  `GitWorktreeError` (an `instanceof TypeError`) whose `kind` is one of:
  `unknown_subcommand`, `unexpected_option`, `invalid_option_type`,
  `missing_required_field`, `invalid_path`, `path_traversal`,
  `path_option_like`, `protected_path`, `out_of_workspace`,
  `outside_worktrees_root`, `invalid_branch_name`, or `invalid_commitish`.
  The error also carries the `subcommand` when one is known, and its message
  starts with `Git worktree <subcommand>` (or `Git worktree`).
- A non-zero `exitCode` is returned in the result rather than thrown; inspect
  `stdout`/`stderr` for the cause.
- Abnormal git execution rejects with a `GitProcessError` whose `kind` is one
  of `spawn`, `stream`, `timeout`, `signal`, or `output_overflow`. The
  underlying `cause` is preserved when available, and captured stdout/stderr is
  attached only up to the per-stream capture limit.
- The default git process timeout is 60 seconds. git stdout and stderr are each
  captured up to 1 MiB (1,048,576 bytes) per stream; exceeding that limit
  rejects with `GitProcessError` of kind `output_overflow` rather than
  accumulating unbounded output in memory.

## Critical operating constraints

- `stage` requires either one or more `paths` **or** `all: true`; specifying
  both is an error. It never stages the whole repository by accident.
- `paths` must be non-empty, non-NUL strings; a `--` separator prevents a path
  such as `--intent-to-add` from being interpreted as an option.
- `mode: "worktree"` accepts only the five whitelisted subcommands and their
  listed parameters. Mutating worktree paths must stay inside the workspace
  (and, for `add`, inside `.worktrees`), never target secret files, and never
  traverse outside the root.
- In `--review` mode during the execution phase, `commit` is rejected by the
  runtime (work is staged in a worktree; only the review step commits when
  satisfied).
- Stage only intended files and never commit secrets.

## Safe use

**Allowed**

- `mode: "status"`, `mode: "log"`, `mode: "diff"`, or `mode: "ls-files"` to
  inspect repository state with read-only commands.
- `mode: "worktree"` with a whitelisted `subcommand` (`list` is read-only;
  `add`, `remove`, `move`, and `prune` are mutating and path-validated).
- `action: "stage"` with explicit `paths` or `all: true` for intended files.
- `action: "commit"` of staged, reviewed work following the current step's
  commit instruction.

**Denied**

- Reading, staging, committing, or diffing `data.json`, credential stores,
  secret files, private keys, tokens, or enrollment recipes.
- Creating, removing, or moving a worktree outside the workspace root, outside
  the managed `.worktrees` root (for `add`), or at a protected/secret path.
- Any `mode: "worktree"` option or subcommand not explicitly whitelisted (for
  example `lock`, `unlock`, `repair`, `--force` on `add`, `--expire` on
  `prune`).
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
- `Git({ mode: "worktree", subcommand: "add", path: "../outside" })`
- `Git({ mode: "worktree", subcommand: "add", path: "data.json" })`
- `Git({ mode: "worktree", subcommand: "remove", path: "/etc" })`

**Required permissions**

- `stage`: at least one non-empty `path` or `all: true`.
- `commit`: a non-empty `message` and staged work.
- `worktree add` / `worktree remove`: a non-empty `path` that satisfies the
  path policy.
- `worktree move`: non-empty `oldPath` and `newPath` that satisfy the path
  policy.

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

11. List linked worktrees in the stable format:

    ```js
    await Git({ mode: "worktree", subcommand: "list", porcelain: true });
    ```

12. Add a worktree under the managed root on a new branch:

    ```js
    await Git({ mode: "worktree", subcommand: "add", path: ".worktrees/topic", newBranch: "topic" });
    ```

13. Add a detached worktree at a specific commit:

    ```js
    await Git({ mode: "worktree", subcommand: "add", path: ".worktrees/hotfix", detach: true, commitish: "HEAD~1" });
    ```

14. Remove a worktree:

    ```js
    await Git({ mode: "worktree", subcommand: "remove", path: ".worktrees/topic", force: true });
    ```

15. Move a worktree to a new path inside the workspace:

    ```js
    await Git({ mode: "worktree", subcommand: "move", oldPath: ".worktrees/topic", newPath: ".worktrees/topic-renamed" });
    ```

16. Prune stale worktree metadata:

    ```js
    await Git({ mode: "worktree", subcommand: "prune" });
    ```
