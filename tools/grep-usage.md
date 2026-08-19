# Grep tool usage

## Purpose

Search a single file or a directory for contents matching a literal text or
regular expression, returning each match as a `path:line:text` tuple along
with the set of matching files. When `path` is a directory the search descends
recursively by default; pass `recursive: false` to search only the directory's
direct child files.

## When to use

Use `Grep` when you need to find text *inside* files (code identifiers, error
strings, configuration values, symbol references) rather than locating entries
by name. It is the native read-only replacement for shelling out to
`grep`/`grep -r`/`grep -rl` through ExecuteCommand, which can be blocked or
tangled by shell quoting and workspace-boundary classifiers. Use `Find` when
you only need file/directory names, and `Read` to inspect a specific file's
contents. To search a single file, pass that file as `path`.

## Required parameters

- `pattern` (string): literal text or regular expression to search for within
  file contents. When `literal` is false it is compiled as a regular
  expression; a pattern with no regex metacharacters behaves as a plain
  substring either way.
- `path` (string): the file or directory to search. A single regular file is
  grepped directly. A directory's child files are searched, descending into
  subdirectories when `recursive` is true (the default).

## Optional parameters

- `name` (string): basename glob filter (same semantics as `Find`'s `name`):
  `*` (any run), `?` (one char), `**` (any number of path segments), or an
  exact name. When omitted, every regular file under a directory `path` that is
  small enough to inspect is a candidate. Ignored when `path` is a single file.
- `recursive` (boolean): when true (the default), a directory search descends
  into subdirectories; when false, only the directory's direct child files are
  inspected (like `grep` without `-r`). Ignored when `path` is a single file and
  when `maxdepth` already bounds recursion.
- `literal` (boolean): when true, `pattern` is treated as exact text and its
  regex metacharacters are escaped. Default false.
- `ignoreCase` (boolean): when true, matching is case-insensitive. Default
  false (case-sensitive).
- `maxdepth` (number): maximum recursion depth below `path`. `1` inspects only
  `path`'s direct children; omitted means unlimited.
- `maxFileSize` (number): maximum bytes of a single file to inspect; larger
  files are skipped entirely. Default `500000` (500k), matching the Read tool's
  cap so gigantic workspace logs (for example `llm.log`) are never read.
- `limit` (number): maximum number of line matches to collect before stopping.
  Default `1000`.

## Result

- `{ matches: GrepMatch[], files: string[], count: number, truncated: boolean }`
  on success.
- `matches` is an array of `{ path, line, text }` objects (1-based `line`, the
  matching `text` with surrounding whitespace trimmed), in file/line order.
- `files` lists the unique paths that contain at least one match.
- `count` is the total matches collected (equals `matches.length` unless the
  result was truncated by `limit`).
- `truncated` is true when the result was capped by reaching `limit`.

## Formatted terminal output

The runtime announces the call as `Grep({...})`, runs an in-place timer, and
renders a green circle with a short summary on success or a red circle with the
error message on failure. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid `path` or `pattern` (blank or NUL): `TypeError`.
- `name` provided but blank: `TypeError`.
- `maxdepth` not a non-negative integer: `TypeError`.
- `maxFileSize` not a positive integer: `TypeError`.
- `limit` not a positive integer: `TypeError`.
- `pattern` is not a valid regular expression (when `literal` is false):
  actionable error suggesting `literal: true`.
- `path` does not exist or is neither a file nor a directory (for example a
  missing path, a socket, or a device): actionable error with cause.
- Unreadable base directory during recursion: actionable error with cause.
- Individual unreadable/oversized files encountered during the search are
  skipped silently rather than aborting the whole search.

## Critical operating constraints

- `Grep` is strictly read-only; it never creates, modifies, or removes
  anything, and never shells out.
- It refuses to inspect files larger than `maxFileSize` (default 500k) so huge
  logs are never loaded into memory.
- It never searches `data.json`: any file named `data.json` encountered under
  `path` is skipped, because its contents are never a valid target.
- Results are capped at `limit` (default 1000) matches.

## Safe use

**Allowed**

- Searching source/config text inside the workspace by substring or regex.
- Filtering by basename glob, case-sensitivity, and recursion depth.

**Denied**

- Searching `data.json` contents (always skipped).
- Searching protected/credential files (blocked by the classifier).
- Searching outside the workspace (blocked by the classifier).
- Reading oversized files (skipped when above `maxFileSize`).

**Dangerous examples (do not run)**

- `Grep({ pattern: "secret", path: "." })` searching outside the workspace or
  into credential paths.
- `Grep({ pattern: "token", path: "../outside" })`.
- `Grep({ pattern: "anything", path: ".", maxFileSize: 1000000000 })` — raises
  the size cap enough to read huge logs; keep the default.

**Required permissions**

- Read access to the directory and files under `path`.
- The `path` must resolve inside the workspace (or the container in Docker
  mode).

## Examples

1. Find lines mentioning `Find` in all TypeScript files under `tools`:

   ```js
   const result = await Grep({ pattern: "Find", path: "tools", name: "*.ts" });
   // result.matches: [{ path: "tools/Find.ts", line: 1, text: "..." }, ...]
   ```

2. Case-insensitive literal search in a single directory level:

   ```js
   const result = await Grep({ pattern: "TODO", path: ".", ignoreCase: true, maxdepth: 1 });
   ```

3. Search with a regular expression and a tighter result cap:

   ```js
   const result = await Grep({ pattern: "class (\\w+)", path: "tools", limit: 50 });
   ```

4. Grep a single file directly:

   ```js
   const result = await Grep({ pattern: "main", path: "main.ts" });
   // result.matches: [{ path: "main.ts", line: 1, text: "..." }]
   ```

5. Search only a directory's direct child files (no subdirectory descent):

   ```js
   const result = await Grep({ pattern: "TODO", path: ".", recursive: false });
   ```
