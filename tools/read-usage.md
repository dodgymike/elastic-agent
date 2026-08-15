# Read tool usage

## Purpose

Read a page of a UTF-8 file and return its text content together with the
SHA-256 hash of the **complete file bytes**. The returned `read_hash` proves
the exact file version that was read and must be passed back to `Edit` or
`Write` so later edits apply only when the file is unchanged.

## When to use

Use `Read` to inspect repository files, to load a per-tool usage prompt file
before using a tool, and to obtain the current `read_hash` before editing or
overwriting a file. Always call `FileSize` first; `Read` requires the size that
`FileSize` returns. Never read `data.json`.

## Required parameters

- `path` (string): filesystem path of the file to read.
- `file_size` (number): size of the file in bytes. Obtain this from the
  `FileSize` tool before calling `Read`.
- `read_length` (number): maximum number of bytes to return in this page.
- `read_offset` (number): zero-based byte offset at which to start reading.

## Result

- `content` (string): the requested byte window, decoded as UTF-8. When the
  requested window cuts through a multi-byte UTF-8 character, the returned
  content is snapped outward just enough to keep whole characters.
- `read_hash` (string): SHA-256 of the complete file bytes, not just the page.
  Save this and pass it to the next `Edit` or `Write` for the same file.
- `error` (unknown, optional): present only when the read failed.

## Error handling

- Missing file, non-regular-file path, or I/O error: returns
  `{ content: "", read_hash: "", error: "<serialized error>" }`.
- Missing or invalid `file_size`, `read_length`, or `read_offset`: returns an
  error object; call `FileSize` and supply valid values.
- `file_size` does not match the actual file size: returns an error object;
  call `FileSize` again and retry.
- File larger than 500,000 bytes (500k): `Read` refuses to read it and returns
  an error object. Do not retry `Read` on that file.

## Critical operating constraints

- Never read `data.json`; the runtime forbids it.
- **Always call `FileSize` first** and pass its returned `size` as
  `file_size`.
- **Be careful with large files.** If the file is larger than 50,000 bytes
  (50k), page through it with `read_offset` and `read_length` rather than
  reading it in one call.
- **`Read` will not read a very large file.** It refuses any file larger than
  500,000 bytes (500k).
- `read_hash` is the hash of the full file, so it is valid for `Edit`/`Write`
  even when you only read one page.
- Always re-`Read` a file before `Edit`/`Write` when its content may have
  changed since the last read.

## Examples

1. Read a small file completely:

   ```js
   const sizeResult = await FileSize({ path: "CLAUDE.md" });
   const r = await Read({ path: "CLAUDE.md", file_size: sizeResult.size, read_offset: 0, read_length: sizeResult.size });
   // r.content, r.read_hash
   ```

2. Page through a file larger than 50k:

   ```js
   const sizeResult = await FileSize({ path: "large-notes.md" });
   const page1 = await Read({ path: "large-notes.md", file_size: sizeResult.size, read_offset: 0, read_length: 50000 });
   const page2 = await Read({ path: "large-notes.md", file_size: sizeResult.size, read_offset: 50000, read_length: 50000 });
   ```
