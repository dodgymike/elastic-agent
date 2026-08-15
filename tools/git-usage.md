# Git tool usage

## Purpose

List working-tree changes, stage selected changes, or commit staged changes.
Git is invoked directly (never through a shell), so paths and commit messages
are passed as literal arguments and cannot alter the command being run.

## When to use

Use `Git` to list repository changes, stage selected paths, or commit staged
work. Follow the runtime's commit instruction for the current step. Use
`ExecuteCommand` for git operations outside `list`/`stage`/`commit`.

## Required parameters

- `action` (string): one of `list`, `stage`, or `commit`.

## Optional parameters

- `cwd` (string): repository directory; defaults to the current directory.
- `paths` (array of strings): repo-relative paths to stage. Only valid with
  `action: "stage"`.
- `all` (boolean): stage all tracked and untracked changes, including
  deletions. Only valid with `action: "stage"`.
- `message` (string): commit message. Required with `action: "commit"`.

## Result

- `command` (string[]): the git arguments that were run.
- `exitCode` (number): git's exit status; `0` means success.
- `stdout` (string): git standard output. For `action: "list"` this is the
  stable `git status --porcelain=v1 --branch` output.
- `stderr` (string): git standard error.

## Formatted terminal output

The runtime first announces the call as `Git('action')`. While git runs, an
in-place timer line ticks on the same terminal line (for example `⏱ 0.50s` in
color mode, or `elapsed 0.50s` in non-TTY logs) and is finalized with the
total elapsed time when the command completes or fails. Terminal state is
cleaned up on exit.

For `action: "list"`, success renders a formatted status view with sections for
the branch, staged changes, unstaged changes, and untracked files. Section
headers and status codes use colors/icons in TTY mode and degrade to plain
text otherwise. A clean working tree renders an explicit
`working tree clean` empty-state. A non-zero git exit renders a red circle
with `git status failed (exit N)` followed by any stderr then stdout
diagnostics; a successful status command still appends any non-empty stderr
after the status sections.

For `stage` and `commit`, success renders `Git('stage')` or `Git('commit')`
followed by a green circle and captured stdout; stderr is included only when
non-empty. Failure renders a red circle with the error message or `exit N`,
followed by stderr and stdout diagnostics when present. In no-color/non-TTY
contexts the circles and colors degrade to plain text while statuses and
streams are still shown. No `[SUCCESS]` or `[ERROR]` text prefix is ever
emitted for a tool call.

## Error handling

- The `action` value is constrained by the tool schema to `list`, `stage`, or
  `commit`; the tool validates the options for the selected action.
- Validation `TypeError`s: a `cwd` that is not a non-empty string, `paths` +
  `all` conflict, no `paths` and no `all`, a path that is empty or contains
  NUL, or an empty commit message.
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
- `action: "list"` to inspect working-tree state.
- `action: "stage"` with explicit `paths` or `all: true` for intended files.
- `action: "commit"` of staged, reviewed work following the current step's
  commit instruction.

**Denied**
- Staging or committing `data.json`, credential stores, secret files, private
  keys, tokens, or enrollment recipes.
- Staging both `paths` and `all: true` in one call.
- Committing without a message, or committing in `--review` mode when the
  runtime rejects it.
- Force-pushing or rewriting remote history through shell commands.

**Dangerous examples (do not run)**
- `Git({ action: "stage", all: true })` while secrets or `data.json` are
  untracked or modified.
- `Git({ action: "commit", message: "..." })` with a secret file staged.
- `Git({ action: "stage", paths: ["data.json"] })`

**Required permissions**
- `stage`: at least one non-empty `path` or `all: true`.
- `commit`: a non-empty `message` and staged work.

## Examples

1. List changes:

   ```js
   await Git({ action: "list", cwd: "." });
   ```

2. Stage one file:

   ```js
   await Git({ action: "stage", paths: ["tools/read-usage.md"] });
   ```

3. Stage everything:

   ```js
   await Git({ action: "stage", all: true });
   ```

4. Commit staged changes:

   ```js
   await Git({ action: "commit", message: "Add per-tool usage prompt files" });
   ```
