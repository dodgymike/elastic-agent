# ListDirectory tool usage

## Purpose

List the entries of a directory non-recursively, returning the listed
directory, its symlink-resolved real path, and each entry's name, joined path,
and type.

## When to use

Use `ListDirectory` to list the immediate children of a directory and
distinguish files, directories, and symlinks. Use `Find` when you need
recursive listing; use `GetWorkingDirectory` when you only need `pwd` plus the
real path.

## Required parameters

- `directory` (string): filesystem path of the directory to list.

## Result

An object with:

- `directory` (string): the directory that was listed, as supplied after
  validation.
- `realDirectory` (string): the symlink-resolved real path of that directory.
- `entries` (array): immediate children, each with:
  - `name` (string): entry name.
  - `path` (string): `directory/name`.
  - `type` (string): `file`, `directory`, `symlink`, or `other`.

## Formatted terminal output

The runtime first announces the call as `ListDirectory({...})`. While the call
runs, an in-place timer line ticks on the same terminal line and is finalized
with the total elapsed time when the call completes or fails.

On completion the terminal renders `ListDirectory({...})` followed by a green
circle and a short result summary on success, or a red circle and the error
message on failure. In no-color/non-TTY contexts the circle degrades to plain
text while the status and summary are still shown. No `[SUCCESS]` or
`[ERROR]` text prefix is ever emitted for a tool call.

## Error handling

- Invalid `directory` value: `TypeError`.
- `realpath` or `readdir` I/O errors (e.g. missing directory, permissions)
  propagate.

## Critical operating constraints

- `directory` must be a non-empty string without NUL characters.
- Non-recursive: only direct children are returned.
- The `type` field distinguishes files, directories, symlinks, and other
  special entries, so `ls -la` is not needed for that distinction.

## Safe use

**Allowed**
- List immediate children of workspace directories.

**Denied**
- Listing directories outside the workspace, user home directories, or system
  directories to map secrets.
- Listing secret-store or credential directories without an approved reason.

**Dangerous examples (do not run)**
- `ListDirectory({ directory: "/root" })`
- `ListDirectory({ directory: "~/.ssh" })`
- `ListDirectory({ directory: "../outside" })`

**Required permissions**
- Read permission on the listed directory only.

## Examples

1. List the tools directory:

   ```js
   await ListDirectory({ directory: "tools" });
   ```

2. List repository root:

   ```js
   await ListDirectory({ directory: "." });
   ```
