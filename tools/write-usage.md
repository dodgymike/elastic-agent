# Write tool usage

## Purpose

Create a new file or overwrite an existing file with the supplied UTF-8
content. Large content is written in fixed 64 KiB chunks so no single write
buffers an unbounded region, while multi-byte UTF-8 sequences stay intact
across chunk boundaries.

## When to use

Use `Write` to create a brand-new file or to replace an entire existing file.
Prefer `Edit` for small, in-place changes. When the target already exists,
`Read` it first and pass the returned `read_hash` together with
`overwrite: true`.

## Required parameters

- `path` (string): filesystem path of the target file.
- `content` (string): full text to write.
- `read_hash` (string): SHA-256 (64 hexadecimal characters) of the file version
  last read. For a brand-new file an empty string is accepted; when the file
  already exists it must be the exact current hash.

## Optional parameters

- `overwrite` (boolean): required in practice whenever the file already exists.
  Set `true` to allow replacing an existing file; the tool rejects an
  existing-file write without `overwrite: true`.

## Result

On success the promise resolves with no return value (`undefined`). The file at
`path` then contains exactly `content` (UTF-8).

## Error handling

- File exists and `overwrite` is not `true`: throws `overwrite must be true`.
- File exists and `read_hash` is missing/blank: throws `read_hash is required`.
- `read_hash` malformed: throws
  `read_hash must be a SHA-256 hash encoded as 64 hexadecimal characters`.
- Hash mismatch: throws
  `File has changed since it was read; refusing to overwrite it`.
  Re-`Read` the file, then retry with the fresh hash.
- I/O errors (missing parent directory, permissions, etc.) propagate.

## Critical operating constraints

- The parent directory must already exist.
- To overwrite an existing file: `overwrite` must be `true` AND `read_hash`
  must be the exact SHA-256 (64 hex characters) from the most recent `Read` or
  `Edit` of that file.
- New files: `read_hash` may be `""`; the file is created/truncated and written.
- Never write credentials, secrets, or `data.json`.

## Examples

1. Create a new file:

   ```js
   await Write({ path: "notes.md", content: "# Notes\n\n...", read_hash: "" });
   ```

2. Overwrite after reading:

   ```js
   const r = await Read({ path: "notes.md" });
   await Write({ path: "notes.md", content: "updated text", overwrite: true, read_hash: r.read_hash });
   ```

3. Overwrite after an edit (use the edit's returned hash):

   ```js
   const r = await Read({ path: "notes.md" });
   const e = await Edit({ path: "notes.md", read_hash: r.read_hash, old_string: "a", new_string: "b" });
   await Write({ path: "notes.md", content: "full rewrite", overwrite: true, read_hash: e.read_hash });
   ```
