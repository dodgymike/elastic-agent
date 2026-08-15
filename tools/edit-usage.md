# Edit tool usage

## Purpose

Edit a file in place using replacement operations. Every edit is guarded by the
`read_hash` returned by the last `Read` (or `Write`/`Edit`) of the file, so an
edit only applies when the file is unchanged since it was read.

## When to use

Use `Edit` for surgical, in-place changes to an existing file. Prefer it over
`Write` when changing only part of a file; use `Write` for a new file or a full
rewrite. Always obtain `read_hash` from a fresh `Read` first.

## Required parameters

- `path` (string): filesystem path of the file to edit.
- `read_hash` (string): SHA-256 (64 hexadecimal characters) of the file version
  last read.

## Optional parameters

At least one replacement form must be supplied (both may be combined; the
single pair is applied after the `edits` array):

- `old_string` (string): exact text that must appear exactly once in the
  current file content; used together with `new_string`.
- `new_string` (string): replacement text for `old_string`.
- `edits` (array): an ordered list of `{ old_string, new_string }` objects
  applied in sequence.

## Result

- `content` (string): full edited file content.
- `read_hash` (string): SHA-256 of the new content; pass to the next
  `Read`/`Write`/`Edit`.
- `applied` (number): count of replacements applied.

## Error handling

- Missing/malformed `read_hash`: `TypeError` (hash required, 64 hex chars).
- File changed since read: throws
  `File has changed since it was read; refusing to edit it. Re-read the file with Read to obtain its current read_hash.`
- `old_string` occurrence count not exactly 1: throws
  `old_string must appear exactly once in the file but was found N times; ... Re-read the file with Read first.`
- Empty edit list or malformed edit entries: `TypeError`.
- Read/write I/O errors: thrown with the path and underlying message.

## Critical operating constraints

- Each `old_string` must appear **exactly once** in the current file content;
  0 or more than 1 occurrences is rejected to protect against ambiguity.
- `old_string` must be non-empty.
- `edits` must be a non-empty array of valid `{ old_string, new_string }`
  objects.
- `read_hash` must be the current file hash; edits are applied in order and the
  result is written atomically.

## Examples

1. Single replacement:

   ```js
   await Edit({ path: "main.ts", read_hash: "<hash>", old_string: "const x = 1;", new_string: "const x = 2;" });
   ```

2. Ordered multiple replacements:

   ```js
   await Edit({
     path: "README.md",
     read_hash: "<hash>",
     edits: [
       { old_string: "## Old title", new_string: "## New title" },
       { old_string: "old link", new_string: "new link" },
     ],
   });
   ```

3. Chain edits with the returned hash:

   ```js
   const sizeResult = await FileSize({ path: "notes.md" });
   const r = await Read({ path: "notes.md", file_size: sizeResult.size, read_offset: 0, read_length: sizeResult.size });
   const e = await Edit({ path: "notes.md", read_hash: r.read_hash, old_string: "A", new_string: "B" });
   await Edit({ path: "notes.md", read_hash: e.read_hash, old_string: "C", new_string: "D" });
   ```
