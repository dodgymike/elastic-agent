# GetWorkingDirectory tool usage

## Purpose

Return the current working directory and its symlink-resolved real path. This
replaces the common `pwd` shell call with a typed, read-only tool.

## When to use

Use `GetWorkingDirectory` when the model only needs the logical cwd and real
path. Use `ListDirectory` when the next step is listing directory entries.

## Required parameters

None.

## Optional parameters

- `resolve` (boolean): resolve the symlink-free real path; defaults to `true`.
  When `false`, `realCwd` is the same as `cwd`.

## Result

- `cwd` (string): the current working directory.
- `realCwd` (string): the symlink-resolved real path of that directory.

## Formatted terminal output

The runtime announces the call as `GetWorkingDirectory({...})`. On success it
renders a green circle plus a short result summary; on failure a red circle and
the error message. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid `resolve` type: `TypeError`.
- Failure to resolve the real path rejects with an actionable error.

## Critical operating constraints

- Read-only; never changes the working directory and never touches files.

## Safe use

**Allowed**
- Reading the current working directory and its real path.

**Denied**
- No filesystem mutation is possible.

**Dangerous examples (do not run)**
- None.

**Required permissions**
- Read access to the current directory.

## Examples

1. Get the current and real working directory:

   ```js
   await GetWorkingDirectory({});
   ```

2. Get only the logical cwd:

   ```js
   await GetWorkingDirectory({ resolve: false });
   ```
