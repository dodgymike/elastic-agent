# Edit tool usage

## Purpose

Edit a file in place, guarded by the `read_hash` returned by the last `Read`
(or `Write`/`Edit`) of the file so an edit applies only when the file is
unchanged. Two mutually exclusive modes are supported: string replacement
(`old_string`/`new_string` or an ordered `edits` array) and line-range
replacement (`line_range` plus `content`).

## When to use

Use `Edit` for surgical, in-place changes to an existing file. Prefer it over
`Write` when changing only part of a file; use `Write` for a new file or a full
rewrite. Always obtain `read_hash` from a fresh `Read` first. Use line-range
mode when you know the 1-based lines to replace (for example lines 100-200)
rather than the exact old text.

## Required parameters

- `path` (string): filesystem path of the file to edit.
- `read_hash` (string): SHA-256 (64 hexadecimal characters) of the file version
  last read. Edit validates this against the current full file content before
  applying any change.

## Optional parameters

Choose exactly one edit mode.

String-replacement mode (at least one replacement must be supplied; a single
`old_string`/`new_string` pair is applied after the `edits` array):

- `old_string` (string): exact text that must appear exactly once in the
  current file content; used together with `new_string`.
- `new_string` (string): replacement text for `old_string`.
- `edits` (array): an ordered list of `{ old_string, new_string }` objects
  applied in sequence.

Line-range mode (the two parameters must be supplied together):

- `line_range` (string): inclusive 1-based line range such as `"100-200"`, or a
  single line such as `"100"`. Edit replaces exactly those lines with
  `content`.
- `content` (string): replacement text for the selected lines. Use `""` to
  delete the selected lines.

`line_range` cannot be combined with `old_string`/`new_string`/`edits`, and
`content` is valid only together with `line_range`.

## Result

- `content` (string): full edited file content.
- `read_hash` (string): SHA-256 of the new content; pass to the next
  `Read`/`Write`/`Edit`.
- `applied` (number): count of replacements applied (`1` in line-range mode).
- `previous_content` (string, non-enumerable): full file content before the
  edit, available to terminal diff rendering; it is not included in
  JSON-serialized tool results for the model.

On success the terminal renders a unified diff view: `---`/`+++` file headers, a
`@@` range header, and change lines with `+` for additions, `-` for deletions,
and neutral context lines. In no-color/non-TTY contexts the same markers render
as plain text.

## Error handling

Edit rejects invalid calls by throwing (it does not return an `error` field).

- Missing/malformed `read_hash`: `TypeError` (hash required, 64 hex chars).
- File changed since read: throws
  `File has changed since it was read; refusing to edit it. Re-read the file with Read to obtain its current read_hash.`
- `old_string` occurrence count not exactly 1: throws
  `old_string must appear exactly once in the file but was found N times; ... Re-read the file with Read first.`
- Empty edit list or malformed edit entries: `TypeError`.
- Invalid `line_range` format or ordering (for example start greater than end):
  `TypeError` explaining the expected `"100-200"` format.
- `line_range` end exceeds the total line count: `Error` reporting the file's
  total line count.
- `line_range` combined with string-replacement parameters, or `content` used
  without `line_range`: `TypeError`.
- Read/write I/O errors: thrown with the path and underlying message.

## Critical operating constraints

- `read_hash` must be the current full-file hash; stale hashes are rejected
  before anything is written.
- String mode: each `old_string` must appear **exactly once** in the current
  file content; 0 or more than 1 occurrences is rejected to protect against
  ambiguity. `old_string` must be non-empty and `edits` must be a non-empty
  array of valid `{ old_string, new_string }` objects.
- Line-range mode: `line_range` is inclusive and 1-based; `content` is required
  and may be empty to delete the selected lines. Only one edit mode may be
  used per call.
- After a successful edit, use the returned `read_hash` for the next operation
  on the same file.

## Safe use

**Allowed**
- Surgical in-place edits to workspace files using a fresh `read_hash`.
- String-replacement edits where each `old_string` appears exactly once, or
  line-range replacement of known lines.

**Denied**
- Editing any `data.json`, especially the repo-root `data.json`.
- Editing credential stores, secret files, private keys, tokens, or enrollment
  recipes in the repository.
- Editing outside the workspace or into system directories.
- Applying edits with a stale or malformed `read_hash`, or with ambiguous
  `old_string` matches.

**Dangerous examples (do not run)**
- `Edit({ path: "data.json", read_hash: "<hash>", old_string: "...", new_string: "..." })`
- Editing `.spec.local.json` or another secret store.
- Deleting a large line range outside the workspace or in sensitive files
  without re-reading first.

**Required permissions**
- The current full-file `read_hash` from the most recent `Read`/`Write`/`Edit`
  of the target file.
- Exactly one valid edit mode per call.

## Examples

1. Single string replacement:

   ```js
   await Edit({ path: "main.ts", read_hash: "<hash>", old_string: "const x = 1;", new_string: "const x = 2;" });
   ```

2. Replace lines 100-200 in one operation:

   ```js
   const sizeResult = await FileSize({ path: "large-notes.md" });
   const r = await Read({ path: "large-notes.md", file_size: sizeResult.size, line_range: "100-200" });
   const e = await Edit({
     path: "large-notes.md",
     read_hash: r.read_hash,
     line_range: "100-200",
     content: "# Replacement section\n\nNew lines 100-200 go here.",
   });
   // e.read_hash is the hash after the replacement. Pass content: "" to delete the lines instead.
   ```

3. Chain edits with the returned hash:

   ```js
   const sizeResult = await FileSize({ path: "notes.md" });
   const r = await Read({ path: "notes.md", file_size: sizeResult.size, read_offset: 0, read_length: sizeResult.size });
   const e = await Edit({ path: "notes.md", read_hash: r.read_hash, old_string: "A", new_string: "B" });
   await Edit({ path: "notes.md", read_hash: e.read_hash, old_string: "C", new_string: "D" });
   ```
