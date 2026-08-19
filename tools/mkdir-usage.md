# Mkdir tool usage

## Purpose

Create a directory at `path`. When `recursive` is true, any missing parent
directories are created as well (like `mkdir -p`); otherwise a missing parent
directory rejects. Creating an already-existing directory is a no-op.

## When to use

Use `Mkdir` to create directories inside the workspace, including parent
directory trees with `recursive: true`. Never use shell `mkdir` when you could
use this dedicated tool.

## Required parameters

- `path` (string): filesystem path of the directory to create.

## Optional parameters

- `recursive` (boolean, default `false`): when true, create missing parent
  directories as needed. Without it, the immediate parent must already exist or
  the call rejects.

## Result

- `{ created: true, path: "<path>" }` on success.

## Formatted terminal output

The runtime announces the call as `Mkdir({...})`, runs an in-place timer, and
renders a green circle with a short summary on success or a red circle with the
error message on failure. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid path (blank or containing NUL characters): rejects with a
  `TypeError`.
- Missing parent (without `recursive`), permission error, or a path whose parent
  is a regular file: rejects with an actionable error carrying the underlying
  cause.

## Critical operating constraints

- The classifier confines `Mkdir` to the workspace (or the container in Docker
  mode) and denies `data.json` and protected/credential paths.
- Never create a directory named `data.json` or any protected/secret path.

## Safe use

**Allowed**
- Create directories (and parent trees with `recursive: true`) inside the
  workspace.

**Denied**
- Creating `data.json` (never a valid target, including `/tmp/data.json`).
- Creating credential stores, private keys, or secret files.
- Creating directories outside the workspace (blocked by the classifier).

**Dangerous examples (do not run)**
- `Mkdir({ path: "data.json" })`
- `Mkdir({ path: "../outside/tmp" })`

## Examples

1. Create a single directory:

   ```js
   const result = await Mkdir({ path: "tmp/build" });
   // { created: true, path: "tmp/build" }
   ```

2. Create a directory and its missing parents:

   ```js
   await Mkdir({ path: "tmp/a/b/c", recursive: true });
   ```
