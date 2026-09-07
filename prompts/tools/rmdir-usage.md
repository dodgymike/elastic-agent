# Rmdir tool usage

## Purpose

Remove a directory at `path`. Without `recursive`, only an *empty* directory is
removed and a non-empty directory rejects with a clear safety error. With
`recursive: true`, the directory tree (and its contents) is removed explicitly.
`Rmdir` never removes a regular file; use `Delete` for files.

## When to use

Use `Rmdir` to remove a directory inside the workspace. Prefer the
non-recursive form so no contents are deleted by accident; only pass
`recursive: true` when you intend to remove an entire tree.

## Required parameters

- `path` (string): filesystem path of the directory to remove.

## Optional parameters

- `recursive` (boolean, default `false`): when true, remove the directory tree
  and its contents. Without it, only an empty directory can be removed.

## Result

- `{ removed: true, path: "<path>" }` for an empty-directory removal.
- `{ removed: true, path: "<path>", entriesRemoved: <number> }` when
  `recursive: true` removed a tree (number of entries removed).

## Formatted terminal output

The runtime announces the call as `Rmdir({...})`, runs an in-place timer, and
renders a green circle with a short summary on success or a red circle with the
error message on failure. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid path (blank or NUL characters): `TypeError`.
- Missing directory or unreadable path: actionable error with cause.
- Path is not a directory (it is a regular file): rejects — use `Delete`.
- Non-empty directory without `recursive: true`: rejects with "not empty; pass
  recursive:true".

## Critical operating constraints

- **Data safety**: without `recursive`, a non-empty directory is never removed.
  Recursive removal requires the explicit `recursive: true` flag.
- The classifier confines `Rmdir` to the workspace (or the container in Docker
  mode) and denies `data.json` and protected/credential paths.
- Never remove `data.json` or any protected/secret store.

## Safe use

**Allowed**
- Remove an empty directory.
- Remove a directory tree inside the workspace with explicit `recursive: true`.

**Denied**
- Removing a non-empty directory without `recursive: true`.
- Targeting `data.json` or protected/credential paths.
- Removing directories outside the workspace (blocked by the classifier).

**Dangerous examples (do not run)**
- `Rmdir({ path: "data.json" })`
- `Rmdir({ path: "../outside" })`

## Examples

1. Remove an empty directory:

   ```js
   const result = await Rmdir({ path: "tmp/build" });
   // { removed: true, path: "tmp/build" }
   ```

2. Remove a directory tree (explicit):

   ```js
   await Rmdir({ path: "tmp/build", recursive: true });
   // { removed: true, path: "tmp/build", entriesRemoved: 12 }
   ```
