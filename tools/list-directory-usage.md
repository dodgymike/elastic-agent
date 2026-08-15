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
