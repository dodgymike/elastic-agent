# ListDirectory tool usage

## Purpose

List the entries of a directory non-recursively, returning each entry's name,
parent path, and joined path.

## When to use

Use `ListDirectory` to list the immediate children of a directory. Use
`ExecuteCommand` (for example `find` or `ls -la`) when you need recursive
listing or must distinguish files from directories.

## Required parameters

- `directory` (string): filesystem path of the directory to list.

## Result

An array of entries, each with:

- `name` (string): entry name.
- `parentPath` (string): the directory that was listed.
- `path` (string): `parentPath/name`.

## Formatted terminal output

The runtime first announces the call as `ListDirectory({...})`. While the call
runs, an in-place timer line ticks on the same terminal line (for example
`⏱ 0.50s` in color mode, or `elapsed 0.50s` in non-TTY logs) and is finalized
with the total elapsed time when the call completes or fails. Terminal state
is cleaned up on exit.

On completion the terminal renders `ListDirectory({...})` followed by a green
circle and a short result summary on success, or a red circle and the error
message on failure. In no-color/non-TTY contexts the circle degrades to plain
text while the status and summary are still shown. No `[SUCCESS]` or `[ERROR]`
text prefix is ever emitted for a tool call.

## Error handling

- Invalid `directory` value: `TypeError`.
- `readdir` I/O errors (e.g. missing directory, permissions) propagate.

## Critical operating constraints

- `directory` must be a non-empty string without NUL characters.
- Non-recursive: only direct children are returned.
- The response does not include whether an entry is a file or directory; use
  `ExecuteCommand` (for example `ls -la` or `find`) to distinguish files from
  directories or to recurse.

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
