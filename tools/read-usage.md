# Read tool usage

## Purpose

Read a UTF-8 file and return its text content together with the SHA-256 hash of
the bytes read. The returned `read_hash` proves the exact version that was read
and must be passed back to `Edit` or `Write` so later edits apply only when the
file is unchanged.

## Required parameters

- `path` (string): filesystem path of the file to read.

## Optional parameters

- `read_hash` (string): expected SHA-256 (64 hexadecimal characters). When
  supplied, a mismatch is returned as an error instead of unchecked content.
  Omit it to read the file unconditionally.

## Result

- `content` (string): the file text.
- `read_hash` (string): SHA-256 of the bytes read. Save this and pass it to the
  next `Edit` or `Write` for the same file.
- `error` (unknown, optional): present only when the read failed.

## Constraints

- Always re-`Read` a file before `Edit`/`Write` when its content may have
  changed since the last read.
- Never read `data.json`; the runtime forbids it.
- When `read_hash` is supplied it must match the actual content, otherwise the
  read fails closed rather than returning possibly stale content.

## Error handling

- Missing file or I/O error: returns `{ content: "", read_hash: "", error: "<serialized error>" }`.
- Supplied hash mismatch or malformed hash: returns
  `{ content: "", read_hash: "<actual hash>", error: "File has changed since it was read; refusing to return unchecked content." }`.

## Examples

1. Read a file and keep its hash:

   ```js
   const r = await Read({ path: "CLAUDE.md" });
   // r.content, r.read_hash
   ```

2. Verify a file is still at a known version:

   ```js
   const r = await Read({ path: "main.ts", read_hash: "0123456789abcdef..." });
   ```

3. Read then edit:

   ```js
   const r = await Read({ path: "notes.md" });
   await Edit({ path: "notes.md", read_hash: r.read_hash, old_string: "A", new_string: "B" });
   ```
