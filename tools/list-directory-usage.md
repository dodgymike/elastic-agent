# ListDirectory tool usage

## Purpose

List the entries of a directory non-recursively, returning each entry's name,
parent path, and joined path.

## Required parameters

- `directory` (string): filesystem path of the directory to list.

## Result

An array of entries, each with:

- `name` (string): entry name.
- `parentPath` (string): the directory that was listed.
- `path` (string): `parentPath/name`.

## Constraints

- `directory` must be a non-empty string without NUL characters.
- Non-recursive: only direct children are returned.
- The response does not include whether an entry is a file or directory; use
  `Read`, `ExecuteCommand`, or additional calls to distinguish or recurse.

## Error handling

- Invalid `directory` value: `TypeError`.
- `readdir` I/O errors (e.g. missing directory, permissions) propagate.

## Examples

1. List the tools directory:

   ```js
   await ListDirectory({ directory: "tools" });
   ```

2. List repository root:

   ```js
   await ListDirectory({ directory: "." });
   ```
