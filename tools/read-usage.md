# Read tool usage

## Purpose

Read a UTF-8 file and return its text content together with the SHA-256 hash of
the bytes read. The returned `read_hash` proves the exact version that was read
and must be passed back to `Edit` or `Write` so later edits apply only when the
file is unchanged.

## When to use

Use `Read` to inspect repository files, to load a per-tool usage prompt file
before using a tool, and to obtain the current `read_hash` before editing or
overwriting a file. Always re-read a file immediately before `Edit`/`Write` when
its content may have changed. Never read `data.json`.

## Required parameters

- `path` (string): filesystem path of the file to read.

## Result

- `content` (string): the file text.
- `read_hash` (string): SHA-256 of the bytes read. Save this and pass it to the
  next `Edit` or `Write` for the same file.
- `error` (unknown, optional): present only when the read failed.

## Error handling

- Missing file or I/O error: returns
  `{ content: "", read_hash: "", error: "<serialized error>" }`.

## Critical operating constraints

- Never read `data.json`; the runtime forbids it.
- Always re-`Read` a file before `Edit`/`Write` when its content may have
  changed since the last read.
- Treat the returned `read_hash` as the file's current version; pass it
  unchanged to the next `Edit` or `Write`.

## Examples

1. Read a file and keep its hash:

   ```js
   const r = await Read({ path: "CLAUDE.md" });
   // r.content, r.read_hash
   ```

2. Read then edit:

   ```js
   const r = await Read({ path: "notes.md" });
   await Edit({ path: "notes.md", read_hash: r.read_hash, old_string: "A", new_string: "B" });
   ```
