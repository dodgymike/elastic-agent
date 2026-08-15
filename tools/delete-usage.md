# Delete tool usage

## Purpose

Permanently delete a regular file, but only after verifying that the file at
`path` currently has exactly the caller-supplied SHA-256 `file_hash` AND
`file_size`. If either value is missing, malformed, or does not match the file
on disk, the tool aborts and leaves the file untouched. Both guards must pass
before anything is removed.

## When to use

Use `Delete` to remove a file that must no longer exist, always after first
reading it with `Read` (which returns its `read_hash`) and sizing it with
`FileSize`. The mandatory hash + size pair prevents deleting the wrong file:
if the file changed since you last looked at it, the tool refuses to delete.
Never use shell `rm` through `ExecuteCommand` for an in-workspace file
deletion — use this tool instead.

## Required parameters

- `path` (string): filesystem path of the file to delete.
- `file_hash` (string): SHA-256 of the file's current bytes, encoded as exactly
  64 lowercase hexadecimal characters (for example the `read_hash` returned by
  `Read`).
- `file_size` (number): exact size of the file in bytes (for example the `size`
  returned by `FileSize`). Must be a non-negative safe integer.

## Result

On success the promise resolves with `{ deleted: true, path }` and the file at
`path` no longer exists. On any failed guard the tool throws and the file is
left unchanged.

## Formatted terminal output

The runtime announces the call as `Delete({...})` and runs an in-place elapsed
timer that ticks on the same line and is finalized with the total time. On
success the terminal renders a green circle with the resolved value; on failure
a red circle with the error message. Delete aborts (red circle) rather than
partially deleting.

## Error handling

Delete throws on every abort condition, so a failed guard never removes the
file:

- `file_hash` missing/blank: throws `file_hash is required`.
- `file_hash` malformed: throws
  `file_hash must be a SHA-256 hash encoded as 64 hexadecimal characters`.
- `file_size` missing/not a non-negative integer: throws
  `file_size is required and must be a non-negative integer`.
- File size mismatch: throws
  `file size changed (expected N bytes, found M bytes)`.
- File hash mismatch: throws `file hash changed since it was read`.
- Path cannot be statted / is not a regular file: throws and aborts.
- I/O errors (unlink failure, permissions) propagate.

On any mismatch, re-`Read` and re-`FileSize` the file to get fresh values, then
retry.

## Critical operating constraints

- `path`, `file_hash`, and `file_size` are all required; Delete aborts if any
  is missing.
- The actual on-disk size must equal `file_size` AND the actual on-disk SHA-256
  must equal `file_hash` before the file is deleted.
- Only regular files can be deleted; directories are refused.
- Never delete `data.json`, secret stores, credential files, or anything
  outside the workspace.

## Safe use

**Allowed**
- Delete a workspace file after `Read` (for `file_hash`) and `FileSize` (for
  `file_size`) return values that match the current bytes.

**Denied**
- Deleting `data.json` or any protected/secret file.
- Deleting a file without first verifying its current hash and size.
- Passing a `file_hash`/`file_size` you did not obtain from the current file.
- Deleting outside the workspace or deleting directories.

**Dangerous examples (do not run)**
- `Delete({ path: "data.json", file_hash: "...", file_size: 123 })`
- `Delete({ path: "notes.md" })` (missing hash/size — aborts)
- `Delete({ path: "notes.md", file_hash: "badhash", file_size: 5 })`
- `Delete({ path: "../outside.txt", file_hash: "...", file_size: 10 })`

**Required permissions**
- The current `file_hash` (64 hex chars) and `file_size` (bytes) of the exact
  file being deleted, matching the file on disk at call time.

## Examples

1. Read and size a file, then delete it with matching hash and size:

   ```js
   const fsr = await FileSize({ path: "scratch.txt" });
   const r = await Read({ path: "scratch.txt", file_size: fsr.size, read_offset: 0, read_length: fsr.size });
   await Delete({ path: "scratch.txt", file_hash: r.read_hash, file_size: fsr.size });
   ```
