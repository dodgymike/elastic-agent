# RunNodeTest tool usage

## Purpose

Run `node --test <files...>` for workspace test files. The fixed `--test` flag
and the literal file argv prevent flag injection and shell parsing.

## When to use

Use `RunNodeTest` for Node's built-in test runner. Use `RunPackageScript` for
declared package.json `test:*` scripts, and `RunScript` for a non-test script.

## Required parameters

- `files` (string[]): workspace test files passed to `node --test`.

## Optional parameters

- `cwd` (string): working directory; defaults to the workspace root.
- `timeoutSeconds` (number): process deadline in seconds; default 120.
- `maxOutputBytes` (number): combined stdout/stderr byte ceiling; default 1 MiB.
- `maxOutputLines` (number): keep only the tail N lines of each stream.

## Result

- `files` (string[]): the test files that ran.
- `exitCode` (number): process exit status; `0` means success.
- `stdout` / `stderr` (string): captured streams.
- `stdoutTruncated` / `stderrTruncated` (boolean): truncation flags.
- `durationMs` (number): elapsed wall-clock time.

## Formatted terminal output

The runtime announces the call as `RunNodeTest({...})`. Success renders a green
circle; a non-zero exit renders a red circle with `exit N` followed by stderr
then stdout diagnostics. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Empty `files`, a `-`-prefixed file, or invalid numeric bounds: `TypeError`.
- Process spawn failure, deadline, signal, or output-limit overflow rejects
  with a structured process error carrying bounded partial output.

## Critical operating constraints

- Every file must be a non-empty string that does not start with `-` and must
  resolve inside the workspace.

## Safe use

**Allowed**
- Running workspace test files with `node --test`.

**Denied**
- Arbitrary node flags, `node -e`, or test files outside the workspace.

**Dangerous examples (do not run)**
- `RunNodeTest({ files: ["-e", "process.exit(1)"] })`
- `RunNodeTest({ files: ["../outside/test.js"] })`

**Required permissions**
- Read/execute permission on the test files within the workspace.

## Examples

1. Run one test file:

   ```js
   await RunNodeTest({ files: ["tests/tools/tool-lifecycle.test.ts"] });
   ```

2. Run several tests with bounded output:

   ```js
   await RunNodeTest({ files: ["test/a.test.ts", "test/b.test.ts"], maxOutputLines: 40 });
   ```
