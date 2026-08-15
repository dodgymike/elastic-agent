# Read tool usage

## Purpose

Read a UTF-8 file and return text content together with the SHA-256 hash of
the **complete file bytes**. The returned `read_hash` proves the exact file
version that was read and must be passed back to `Edit` or `Write` so later
edits apply only when the file is unchanged.

`Read` supports two selection modes:

- **Byte-window paging** (default): supply `read_offset` and `read_length` to
  read a byte range. Use this for large files or when you need a specific byte
  window.
- **Line range**: supply an optional `line_range` such as `"100-200"` to read
  only those 1-based lines. Use this when you know the lines you need and do
  not want to page through the whole file.

## When to use

Use `Read` to inspect repository files, to load a per-tool usage prompt file
before using a tool, and to obtain the current `read_hash` before editing or
overwriting a file. Always call `FileSize` first; `Read` requires the size that
`FileSize` returns. Never read `data.json`.

Prefer `line_range` when you want specific lines (for example lines 100-200).
Prefer byte-window paging when you need the raw bytes around a known offset or
when paging through a file larger than 50k.

## Required parameters

- `path` (string): filesystem path of the file to read.
- `file_size` (number): size of the file in bytes. Obtain this from the
  `FileSize` tool before calling `Read`.

`file_size` is always required. For byte-window reads (the default, when
`line_range` is not supplied), these two are also required and must be
supplied together:

- `read_length` (number): maximum number of bytes to return in this page.
- `read_offset` (number): zero-based byte offset at which to start reading.

When `line_range` is supplied, `read_offset` and `read_length` are optional; if
you provide them, provide both, and their byte window must cover the requested
lines.

## Optional parameters

- `line_range` (string): inclusive 1-based line range such as `"100-200"`, or a
  single line such as `"100"`. When supplied, `Read` returns only those lines
  instead of the byte window. `file_size` must still match the current file
  size. Either omit `read_offset`/`read_length` or pass both with a byte window
  that covers the requested lines (for example `read_offset: 0` and
  `read_length: file_size`).
- `read_hash` (string): optional expected SHA-256 of the complete file. When
  supplied, a mismatch is returned as an error instead of returning unchecked
  content. The returned `read_hash` is always the full-file hash.

## Result

- `content` (string): the requested content, decoded as UTF-8.
  - Byte-window mode: the requested byte window. When the requested window cuts
    through a multi-byte UTF-8 character, the returned content is snapped
    outward just enough to keep whole characters.
  - Line-range mode: the requested lines, joined with `\n` (no trailing
    newline is added).
- `read_hash` (string): SHA-256 of the complete file bytes, not just the page
  or lines. Save this and pass it to the next `Edit` or `Write` for the same
  file.
- `error` (unknown, optional): present only when the read failed.

## Formatted terminal output

The runtime first announces the call as `Read({...})`. While the call runs, an
in-place timer line ticks on the same terminal line (for example `⏱ 0.50s` in
color mode, or `elapsed 0.50s` in non-TTY logs) and is finalized with the
total elapsed time when the call completes or fails. Terminal state is cleaned
up on exit.

On completion the terminal renders `Read({...})` followed by a green circle
and a short result summary on success, or a red circle and the error message on
failure. In no-color/non-TTY contexts the circle degrades to plain text while
the status and summary are still shown. No `[SUCCESS]` or `[ERROR]` text
prefix is ever emitted for a tool call.

## Error handling

- Missing file, non-regular-file path, or I/O error: returns
  `{ content: "", read_hash: "", error: "<serialized error>" }`.
- Missing or invalid `file_size`, `read_length`, or `read_offset`: returns an
  error object; call `FileSize` and supply valid values.
- `file_size` does not match the actual file size: returns an error object;
  call `FileSize` again and retry.
- File larger than 500,000 bytes (500k): `Read` refuses to read it and returns
  an error object. Do not retry `Read` on that file.
- Invalid `line_range`: returns an error object explaining the expected format
  (for example `"100-200"` or `"100"`).
- `line_range` end exceeds the total line count: returns an error object that
  reports the file's total line count.
- `line_range` plus only one of `read_offset`/`read_length`: returns an error
  object; supply both together or omit both.
- `line_range` plus a byte window that does not cover the requested lines:
  returns an error object; pass `read_offset: 0` and `read_length: file_size`
  to use line mode, or omit the byte window entirely.
- Optional `read_hash` mismatch: returns an error object with the actual hash;
  re-`Read` the file and confirm its identity before trusting content.

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
  even when you only read one page or a line range.
- Always re-`Read` a file before `Edit`/`Write` when its content may have
  changed since the last read.
- When using `line_range`, either omit `read_offset`/`read_length` or pass
  `read_offset: 0` and `read_length: file_size` so the byte window covers the
  requested lines.

## Safe use

**Allowed**
- Read UTF-8 files inside the workspace after obtaining their size with
  `FileSize`.
- Read per-tool usage docs before using a tool for the first time.
- Use `line_range` or byte-window paging for large files (≤500,000 bytes).

**Denied**
- Reading any `data.json`, especially the repo-root `data.json`. The runtime's
  own `/tmp/data.json` is internal state and is never a tool target.
- Reading files outside the workspace, other users' files, or system files such
  as `/etc/passwd`.
- Reading credential stores, secret files, private keys, or enrollment recipes.
- Reading files larger than 500,000 bytes, or reading without a fresh
  `FileSize`.

**Dangerous examples (do not run)**
- `Read({ path: "data.json", file_size: N, read_offset: 0, read_length: N })`
- `Read({ path: "../outside/secret.env", file_size: N, read_offset: 0, read_length: N })`
- `Read({ path: ".spec.local.json", file_size: N, read_offset: 0, read_length: N })`

**Required permissions**
- Read permission on the target file. No secret or `data.json` access is ever
  permitted, regardless of filesystem permissions.

## Examples

1. Read a small file completely:

   ```js
   const sizeResult = await FileSize({ path: "CLAUDE.md" });
   const r = await Read({ path: "CLAUDE.md", file_size: sizeResult.size, read_offset: 0, read_length: sizeResult.size });
   // r.content, r.read_hash
   ```

2. Read lines 100-200 without paging:

   ```js
   const sizeResult = await FileSize({ path: "large-notes.md" });
   const r = await Read({ path: "large-notes.md", file_size: sizeResult.size, line_range: "100-200" });
   // r.content contains lines 100 through 200; r.read_hash is the full-file hash.
   ```

3. Page through a file larger than 50k:

   ```js
   const sizeResult = await FileSize({ path: "large-notes.md" });
   const page1 = await Read({ path: "large-notes.md", file_size: sizeResult.size, read_offset: 0, read_length: 50000 });
   const page2 = await Read({ path: "large-notes.md", file_size: sizeResult.size, read_offset: 50000, read_length: 50000 });
   ```
