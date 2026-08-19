# Find tool usage

## Purpose

Search a directory (`path`) for entries matching an optional `name` glob and
`type` filter, recursing up to an optional `maxdepth`. Returns the matching
entry paths in depth-first order.

## When to use

Use `Find` to locate files or directories inside the workspace by name/pattern,
entry type, and depth. It is a read-only tool and never modifies the filesystem.

## Required parameters

- `path` (string): filesystem directory in which to search. It must resolve to a
  directory.

## Optional parameters

- `name` (string): basename filter. May be an exact name or a glob using `*`
  (any run of characters), `?` (exactly one character), or `**` (any number of
  path segments). When omitted, every entry under `path` is a candidate.
- `type` (`"file"` | `"directory"`): only match entries of this type.
- `maxdepth` (number): maximum recursion depth below `path`. `0` matches only
  the entries directly inside `path`; omitted means unlimited.

## Result

- `{ matches: string[], count: number }` on success, where `matches` lists the
  full path of each matching entry (in depth-first order) and `count` is the
  number of matches.

## Formatted terminal output

The runtime announces the call as `Find({...})`, runs an in-place timer, and
renders a green circle with a short summary on success or a red circle with the
error message on failure. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid `path` (blank or NUL): `TypeError`.
- `name` provided but blank: `TypeError`.
- `type` not `"file"`/`"directory"`: `TypeError`.
- `maxdepth` not a non-negative integer: `TypeError`.
- `path` does not exist or is not a directory: actionable error with cause.
- Unreadable subdirectory during recursion: actionable error with cause.

## Critical operating constraints

- `Find` is read-only; it never creates, modifies, or removes anything.
- The classifier confines the search `path` to the workspace (or the container
  in Docker mode).
- Searching for `data.json` is denied: `data.json` is never a valid target,
  including `/tmp/data.json`.

## Safe use

**Allowed**
- Search the workspace by name glob, type, and depth.

**Denied**
- Searching `data.json` (never a valid target).
- Searching protected/credential paths.
- Searching outside the workspace (blocked by the classifier).

**Dangerous examples (do not run)**
- `Find({ path: ".", name: "data.json" })`
- `Find({ path: "../outside" })`

## Examples

1. Find all TypeScript source files under `tools`:

   ```js
   const result = await Find({ path: "tools", name: "*.ts", type: "file" });
   // result.matches is an array of paths; result.count is the length
   ```

2. Find directories directly inside the workspace (no recursion):

   ```js
   const result = await Find({ path: ".", type: "directory", maxdepth: 1 });
   ```

3. Find a file by exact name:

   ```js
   const result = await Find({ path: ".", name: "package.json" });
   ```
