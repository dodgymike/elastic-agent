# Git tool usage

## Purpose

List working-tree changes, stage selected changes, or commit staged changes.
Git is invoked directly (never through a shell), so paths and commit messages
are passed as literal arguments and cannot alter the command being run.

## Required parameters

- `action` (string): one of `list`, `stage`, or `commit`.

## Parameters by action

- `list`: optional `cwd` (repository directory, defaults to current directory).
  Runs `git status --short --branch`.
- `stage`: optional `cwd`; either `paths` (array of repo-relative paths) or
  `all: true`. Runs `git add -- <paths>` or `git add --all`.
- `commit`: required `message` (non-empty string); optional `cwd`.
  Runs `git commit -m <message>`.

## Result

- `command` (string[]): the git arguments that were run.
- `exitCode` (number): git's exit status; `0` means success.
- `stdout` (string): git standard output.
- `stderr` (string): git standard error.

## Constraints

- `stage` requires either one or more `paths` **or** `all: true`; specifying
  both is an error. It never stages the whole repository by accident.
- `paths` must be non-empty, non-NUL strings; a `--` separator prevents a path
  such as `--intent-to-add` from being interpreted as an option.
- In `--review` mode during the execution phase, `commit` is rejected by the
  runtime (work is staged in a worktree; only the review step commits when
  satisfied).
- Stage only intended files and never commit secrets.

## Error handling

- Validation `TypeError`s: missing/invalid action, `paths` + `all` conflict,
  no paths and no `all`, or empty commit message.
- A non-zero `exitCode` is returned in the result rather than thrown; inspect
  `stdout`/`stderr` for the cause.
- Spawn error or termination by signal rejects the promise.

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
