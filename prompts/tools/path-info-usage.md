# PathInfo tool usage

## Purpose

Inspect filesystem metadata and resolve paths. Replaces `stat`, `readlink`,
`realpath`, `file`, `which`, and `ls -ld`.

## When to use

Use `PathInfo` for path metadata and resolution. Use `Read` to read file
contents, `FileSize` for just a byte size, and `FileHash` for a digest.

## Required parameters

- `path` (string): the path to inspect.

## Optional parameters

- `action` (string): `stat` (default), `lstat`, `realpath`, `readlink`,
  `which`, or `type`.

## Result

- `exists` (boolean): false when the path does not exist.
- `type` (string): `file`, `directory`, `symlink`, or `other`.
- `size` (number): byte size when applicable.
- `mode` (string): file mode as an octal string, for example `"100644"`.
- `mtime` (string): ISO-8601 modification time when applicable.
- `symlinkTarget` (string): link target for `readlink`.
- `resolvedPath` (string): resolved path for `realpath`/`which`.
- `executable` (boolean): whether `which` found an executable file.

## Formatted terminal output

The runtime announces the call as `PathInfo({...})`. On success it renders a
green circle plus a short result summary; on failure a red circle and the error
message. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid `path` or unknown `action`: `TypeError`.
- Permission or filesystem errors (other than a missing leaf) reject with an
  actionable error. A missing path returns `{ exists: false }`.

## Critical operating constraints

- Read-only; never creates, modifies, or removes anything.
- Protected-path policy applies: `data.json`, credential stores, and private
  keys are refused.

## Safe use

**Allowed**
- Inspecting metadata for workspace paths.

**Denied**
- Inspecting `data.json`, credential stores, private keys, or paths outside
  the workspace.

**Dangerous examples (do not run)**
- `PathInfo({ path: "data.json" })`
- `PathInfo({ path: "/etc/shadow" })`

**Required permissions**
- Read/lstat permission on the inspected path.

## Examples

1. Stat a file:

   ```js
   await PathInfo({ path: "src/tools/Read.ts", action: "stat" });
   ```

2. Resolve a real path:

   ```js
   await PathInfo({ path: "tools", action: "realpath" });
   ```

3. Locate an executable on PATH:

   ```js
   await PathInfo({ path: "node", action: "which" });
   ```
