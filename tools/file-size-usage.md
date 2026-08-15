# FileSize tool usage

## Purpose

Return the size of a file in bytes. `Read` requires this value as its
`file_size` parameter, so call `FileSize` immediately before reading a file.

## When to use

Use `FileSize` before every `Read` call. Use it on its own when you need to
know whether a file exists or how large it is without reading its content.
Never use it to read `data.json`.

## Required parameters

- `path` (string): filesystem path of the file to inspect.

## Result

- `size` (number): file size in bytes.
- `error` (unknown, optional): present only when the size could not be
  determined.

## Error handling

- Missing file, non-regular-file path, or I/O error: returns
  `{ size: 0, error: "<serialized error>" }`.
- Invalid path: returns `{ size: 0, error: "path must be a non-empty string." }`
  or `{ size: 0, error: "path cannot contain NUL characters." }`.

## Critical operating constraints

- Never inspect `data.json`; the runtime forbids reading it with any tool.
- Pass the returned `size` unchanged as `file_size` to `Read`.
- If the file changes between `FileSize` and `Read`, `Read` detects the size
  mismatch and asks you to call `FileSize` again.

## Examples

1. Get a file's size before reading it:

   ```js
   const sizeResult = await FileSize({ path: "CLAUDE.md" });
   // sizeResult.size, for example 1234
   ```
