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

## Formatted terminal output

The runtime first announces the call as `FileSize({...})`. While the call
runs, an in-place timer line ticks on the same terminal line (for example
`⏱ 0.50s` in color mode, or `elapsed 0.50s` in non-TTY logs) and is finalized
with the total elapsed time when the call completes or fails. Terminal state
is cleaned up on exit.

On completion the terminal renders `FileSize({...})` followed by a green circle
and a short result summary on success, or a red circle and the error message on
failure. In no-color/non-TTY contexts the circle degrades to plain text while
the status and summary are still shown. No `[SUCCESS]` or `[ERROR]` text
prefix is ever emitted for a tool call.

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

## Safe use

**Allowed**
- Stat workspace files to obtain their size before `Read`.

**Denied**
- Inspecting any `data.json`, especially the repo-root `data.json`.
- Inspecting credential stores, secret files, private keys, or enrollment
  recipes.

**Dangerous examples (do not run)**
- `FileSize({ path: "data.json" })`
- `FileSize({ path: ".spec.local.json" })`

**Required permissions**
- Stat permission on the target file only; no secret or `data.json` access.

## Examples

1. Get a file's size before reading it:

   ```js
   const sizeResult = await FileSize({ path: "CLAUDE.md" });
   // sizeResult.size, for example 1234
   ```
