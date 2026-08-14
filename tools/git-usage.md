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
- `stdout` (string): git standard output.
- `stderr` (string): git standard error.

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
