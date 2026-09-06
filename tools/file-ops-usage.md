# FileOps tool usage

## Purpose

Perform simple, validated file operations without a shell: `copy`, `move`,
`touch`, `chmod`, and `symlink`. Every path goes through the same boundary and
protected-path checks as Write/Delete.

## When to use

Use `FileOps` for simple file operations. Use `Delete`/`Rmdir` for removal,
`Mkdir` for directory creation, and `Edit` for in-place content edits.

## Required parameters

- `action` (string): `copy`, `move`, `touch`, `chmod`, or `symlink`.

## Optional parameters

- `source` (string): source path for `copy`, `move`, and `symlink` (link
  target).
- `destination` (string): destination path for `copy`, `move`, and `symlink`
  (link path).
- `path` (string): target path for `touch` and `chmod`.
- `mode` (string): octal string (e.g. `"755"`) or executable-bit symbolic mode
  (e.g. `"+x"`, `"u+x"`, `"a-x"`) for `chmod`.

## Result

- `action` (string): the action that ran.
- `source` / `destination` (string): the paths used when applicable.
- `path` / `mode` (string): the path and mode used when applicable.

## Formatted terminal output

The runtime announces the call as `FileOps({...})`. On success it renders a
green circle plus a short result summary; on failure a red circle and the error
message. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Unknown `action`, missing required path fields, invalid `mode`, or NUL
  characters: `TypeError`.
- Symlink destinations, hardlinked targets, and filesystem failures reject with
  an actionable error.

## Critical operating constraints

- Mutating actions require `--allow-agent-source-modifications` or a declared
  `--safe-dir` directory.
- `move`/`copy` never follow a symlink destination.
- `touch` uses `O_NOFOLLOW`, so an existing symlink target is refused.
- `chmod` refuses symlink targets and supports only octal or executable-bit
  symbolic modes.

## Safe use

**Allowed**
- Copying, moving, touching, chmodding, or symlinking workspace paths within
  the configured editable boundary.

**Denied**
- Operating on `data.json`, credential stores, private keys, or paths outside
  the workspace.
- Following symlink destinations or chmodding through a symlink.

**Dangerous examples (do not run)**
- `FileOps({ action: "copy", source: "data.json", destination: "copy.json" })`
- `FileOps({ action: "symlink", source: "/etc", destination: "escape" })`
- `FileOps({ action: "chmod", path: "data.json", mode: "777" })`

**Required permissions**
- Write permission within the configured editable boundary.

## Examples

1. Touch a file:

   ```js
   await FileOps({ action: "touch", path: "tmp/marker.txt" });
   ```

2. Make a script executable:

   ```js
   await FileOps({ action: "chmod", path: "scripts/run.sh", mode: "+x" });
   ```

3. Copy a file:

   ```js
   await FileOps({ action: "copy", source: "README.md", destination: "README.copy.md" });
   ```

4. Move a file:

   ```js
   await FileOps({ action: "move", source: "tmp/a.txt", destination: "tmp/b.txt" });
   ```

5. Create a symlink:

   ```js
   await FileOps({ action: "symlink", source: "README.md", destination: "tmp/readme-link" });
   ```
