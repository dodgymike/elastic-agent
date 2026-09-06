# Git tool usage

## Purpose

Inspect a Git repository with read-only modes (`status`, `log`, `diff`,
`ls-files`, `show`, `rev-parse`, `check-ignore`, `branch`, `remote`, `config`
get, `cat-file`, `clean --dry-run`), manage linked worktrees with a strict
`worktree` mode (`list`, `add`, `remove`, `move`, `prune`), stage selected
changes, commit, checkout, restore, stash, create/delete branches, and set
workspace-local config. Git is invoked directly (never through a shell), so
paths, revisions, messages, and config values are passed as literal arguments
and cannot alter the command being run.

## When to use

Use a read-only `mode` to inspect repository state. Use `mode: "worktree"` to
inspect or manage linked worktrees through the whitelisted subcommands. Use the
mutating `action`s for staging, committing, checkout, restore, stash, branch
create/delete, and workspace-local config set. Use `ExecuteCommand` only for
git operations outside these modes and actions (for example tag or push).

## Required parameters

Exactly one of these is required:

- `mode` (string): one of `status`, `log`, `diff`, `ls-files`, `worktree`,
  `show`, `rev-parse`, `check-ignore`, `branch`, `remote`, `config`,
  `cat-file`, or `clean`.
- `action` (string): one of `stage`, `commit`, `checkout`, `restore`, `stash`,
  `branch-create`, `branch-delete`, or `config-set`.

When `mode: "worktree"` is selected, `subcommand` is also required and must be
one of `list`, `add`, `remove`, `move`, or `prune`. When `action: "stash"` is
selected, `subcommand` is required and must be `push`, `pop`, or `list`.

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
`git status --porcelain=v1 --branch`.

### `mode: "log"`

Lists commit history.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `oneline` | boolean | Use `--oneline`; defaults to `true`. |
| `stat` | boolean | Append `--stat`. |
| `maxCount` | number | Limit to `-N` commits; positive integer. |
| `all` | boolean | Include commits reachable from all refs (`--all`). |
| `revision` | string | Revision or range; defaults to `HEAD` when omitted. |
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
| `revision` | string | Revision or range to diff. |
| `paths` | string[] | Optional repo-relative path filters. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "ls-files"`

Lists files known to the index.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `others` | boolean | List untracked files (`--others`). |
| `excludeStandard` | boolean | Honor standard ignore rules (`--exclude-standard`). |
| `paths` | string[] | Optional repo-relative path filters. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "show"`

Shows a commit or object.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `revision` | string | Revision or object to show; defaults to `HEAD`. |
| `path` | string | Convenience single path filter. |
| `paths` | string[] | Optional repo-relative path filters. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "rev-parse"`

Resolves a revision expression.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `revision` | string | Required revision expression (for example `HEAD`). |
| `abbrevRef` | boolean | Append `--abbrev-ref`. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "check-ignore"`

Tests paths against ignore rules.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `paths` | string[] | Required repo-relative paths to test. |
| `verbose` | boolean | Append `--verbose`. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "branch"`

Lists branches.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `all` | boolean | List remote-tracking and local branches (`--all`). |
| `remotes` | boolean | List remote-tracking branches (`--remotes`). |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "remote"`

Lists remotes with their URLs (`git remote -v`).

| Parameter | Type | Meaning |
| --- | --- | --- |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "config"`

Gets a config value (`git config --get <key>`) read-only.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `key` | string | Required config key, for example `user.name`. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "cat-file"`

Pretty-prints an object.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `object` | string | Required object name (commit, tree, blob, or tag). |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "clean"`

Runs `git clean --dry-run` only (read-only).

| Parameter | Type | Meaning |
| --- | --- | --- |
| `paths` | string[] | Optional repo-relative path filters. |
| `cwd` | string | Repository directory; defaults to the current directory. |

### `mode: "worktree"`

Inspect or manage linked worktrees through exactly five whitelisted
subcommands. `list` is read-only; `add`, `remove`, `move`, and `prune` are
mutating and validated before any git process runs.

#### `subcommand: "list"` (read-only)

| Parameter | Type | Meaning |
| --- | --- | --- |
| `porcelain` | boolean | Append `--porcelain`. |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### `subcommand: "add"` (mutating)

| Parameter | Type | Meaning |
| --- | --- | --- |
| `path` | string | Required. Must resolve inside the managed `.worktrees` root. |
| `newBranch` | string | Create a new branch with `-b <newBranch>`. |
| `detach` | boolean | Detach HEAD with `--detach`. |
| `commitish` | string | Optional `<commit-ish>` to check out. |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### `subcommand: "remove"` (mutating)

| Parameter | Type | Meaning |
| --- | --- | --- |
| `path` | string | Required. Worktree path to remove. |
| `force` | boolean | Append `--force`. |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### `subcommand: "move"` (mutating)

| Parameter | Type | Meaning |
| --- | --- | --- |
| `oldPath` | string | Required. Source worktree path. |
| `newPath` | string | Required. Destination worktree path. |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### `subcommand: "prune"` (mutating)

| Parameter | Type | Meaning |
| --- | --- | --- |
| `cwd` | string | Repository directory; defaults to the current directory. |

#### Worktree path policy

For every mutating worktree path (`add.path`, `remove.path`,
`move.oldPath`, `move.newPath`):

- Non-empty, no NUL bytes, no `..` segment after normalizing `/` and `\\`.
- Must not start with `-`.
- Must not target `data.json` or any protected/secret file.
- Must resolve inside the workspace root (`cwd` or the current directory).
- `add.path` must also be inside the managed `.worktrees` root.

## Mutating actions

### `action: "stage"`

- `paths` (string[]): repo-relative paths to add to the index.
- `all` (boolean): stage all tracked and untracked changes.

`stage` requires either one or more `paths` **or** `all: true`; specifying both
is an error.

### `action: "commit"`

- `message` (string): commit message passed to `git commit -m`; required and
  non-empty.

### `action: "checkout"`

- `target` (string): branch, tag, or commit to check out; required and must not
  start with `-`.

### `action: "restore"`

- `paths` (string[]): repo-relative paths to restore; required.
- `staged` (boolean): restore the index instead of the worktree (`--staged`).

### `action: "stash"`

- `subcommand` (string): required `push`, `pop`, or `list`.

### `action: "branch-create"`

- `name` (string): required new branch name.
- `startPoint` (string): optional start point.

### `action: "branch-delete"`

- `name` (string): required branch name.
- `force` (boolean): use `-D` instead of the safe `-d` delete.

### `action: "config-set"`

- `key` (string): required config key.
- `value` (string): required non-empty value. Writes `git config --local`.

## Result

Every call that lets git run to a normal exit resolves with:

- `command` (string[]): the git arguments that were run, excluding `git`.
- `exitCode` (number): git's exit status; `0` means success.
- `stdout` (string): git standard output, captured up to the 1 MiB per-stream
  limit.
- `stderr` (string): git standard error, captured up to the 1 MiB per-stream
  limit.

Abnormal execution (startup failure, stream error, the 60-second timeout,
signal termination, or output-limit overflow) rejects with `GitProcessError`.

## Formatted terminal output

The runtime first announces the call as `Git('mode')` (or `Git('action')`).
While git runs, an in-place timer line ticks and is finalized with the total
elapsed time.

For `mode: "status"` success, the terminal renders a formatted status view with
sections for branch, staged, unstaged, and untracked files. For all other
modes and actions, the terminal renders `Git('mode'|'action')` plus captured
stdout/stderr using the shared command renderer. A non-zero exit renders a red
circle with `exit N` followed by stderr then stdout diagnostics. In no-color/
non-TTY contexts circles and colors degrade to plain text. No `[SUCCESS]` or
`[ERROR]` text prefix is ever emitted.

## Redaction

The runtime redacts secret-shaped argument fields and error messages before
displaying them. Raw git stdout is shown as captured, so never diff or log a
file that may contain credentials, tokens, enrollment recipes, or other
secrets. `data.json` must never be read, staged, committed, or diffed.

## Error handling

- Validation `TypeError`s include: options that are not an object, invalid
  `cwd`, unknown `mode`/`action`/`subcommand`, invalid `format`/`maxCount`,
  missing required fields, `paths` + `all` conflict, invalid branch names, and
  invalid keys/values.
- Invalid `mode: "worktree"` calls reject synchronously with `GitWorktreeError`
  (an `instanceof TypeError`) whose `kind` identifies the failure category.
- A non-zero `exitCode` is returned in the result rather than thrown.
- Abnormal git execution rejects with `GitProcessError` whose `kind` is one of
  `spawn`, `stream`, `timeout`, `signal`, or `output_overflow`.
- The default git process timeout is 60 seconds. Each stream is captured up to
  1 MiB.

## Critical operating constraints

- `stage` requires one or more `paths` **or** `all: true`; never both.
- `paths` must be non-empty, non-NUL strings.
- `mode: "worktree"` accepts only the five whitelisted subcommands and their
  listed parameters.
- `restore` requires at least one path.
- `checkout`/`branch-create`/`branch-delete` names/targets must not start with
  `-` or contain branch-name metacharacters.
- In `--review` mode during the execution phase, `commit` is rejected by the
  runtime.
- Stage only intended files and never commit secrets.

## Safe use

**Allowed**
- Read-only modes listed above.
- `mode: "worktree"` with a whitelisted `subcommand`.
- `action: "stage"` with explicit `paths` or `all: true` for intended files.
- `action: "commit"` of staged, reviewed work following the current step's
  commit instruction.
- `checkout`, `restore`, `stash`, `branch-create`/`branch-delete`, and
  `config-set` within the workspace.

**Denied**
- Reading, staging, committing, or diffing `data.json`, credential stores,
  secret files, private keys, tokens, or enrollment recipes.
- Worktree paths outside the workspace or outside the managed `.worktrees`
  root for `add`.
- Force-pushing or rewriting remote history through shell commands.
- Free-form git argument strings; every subcommand uses whitelisted
  parameters.

**Dangerous examples (do not run)**
- `Git({ mode: "diff", paths: ["data.json"] })`
- `Git({ mode: "cat-file", object: "data.json" })`
- `Git({ action: "stage", paths: ["data.json"] })`
- `Git({ action: "stage", all: true })` while secrets are untracked.
- `Git({ mode: "worktree", subcommand: "add", path: "../outside" })`
- `Git({ action: "branch-create", name: "-bad" })`

**Required permissions**
- `stage`: at least one non-empty `path` or `all: true`.
- `commit`: a non-empty `message` and staged work.
- `worktree add`/`remove`/`move`: path(s) satisfying the path policy.
- `restore`: at least one `path`.
- `stash`: a valid `subcommand`.
- `branch-create`/`branch-delete`: a non-empty, safe `name`.
- `config-set`: non-empty `key` and `value`.

## Examples

1. Inspect working-tree state:

   ```js
   await Git({ mode: "status" });
   ```

2. Recent commit history:

   ```js
   await Git({ mode: "log", maxCount: 10, oneline: true });
   ```

3. Whitespace check:

   ```js
   await Git({ mode: "diff", check: true });
   ```

4. Show HEAD:

   ```js
   await Git({ mode: "show" });
   ```

5. Resolve the current branch name:

   ```js
   await Git({ mode: "rev-parse", revision: "HEAD", abbrevRef: true });
   ```

6. Check whether a file is ignored:

   ```js
   await Git({ mode: "check-ignore", paths: ["dist/main.js"] });
   ```

7. List branches:

   ```js
   await Git({ mode: "branch" });
   ```

8. Read a config value:

   ```js
   await Git({ mode: "config", key: "user.name" });
   ```

9. Pretty-print an object:

   ```js
   await Git({ mode: "cat-file", object: "HEAD:README.md" });
   ```

10. Stage one file:

    ```js
    await Git({ action: "stage", paths: ["tools/read-usage.md"] });
    ```

11. Commit staged changes:

    ```js
    await Git({ action: "commit", message: "Add per-tool usage prompt files" });
    ```

12. Checkout a branch:

    ```js
    await Git({ action: "checkout", target: "main" });
    ```

13. Restore a file:

    ```js
    await Git({ action: "restore", paths: ["README.md"] });
    ```

14. Stash changes:

    ```js
    await Git({ action: "stash", subcommand: "push" });
    ```

15. Create and delete a branch:

    ```js
    await Git({ action: "branch-create", name: "topic" });
    await Git({ action: "branch-delete", name: "topic" });
    ```

16. Set a workspace-local config value:

    ```js
    await Git({ action: "config-set", key: "user.name", value: "Elastic Agent" });
    ```

17. Add a worktree under the managed root:

    ```js
    await Git({ mode: "worktree", subcommand: "add", path: ".worktrees/topic", newBranch: "topic" });
    ```
