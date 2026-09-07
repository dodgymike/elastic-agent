# RunScript tool usage

## Purpose

Run an existing `.js`/`.mjs`/`.cjs` file in the workspace with `node`, never
through a shell. The script path is passed as a literal argv element after the
fixed `node` executable, so it cannot inject node flags.

## When to use

Use `RunScript` for an existing workspace script. Use `RunNodeTest` for
`node --test`, and `RunPackageScript` for declared package.json scripts.
Avoid general `node -e` evaluation; there is intentionally no `NodeEval` tool.

## Required parameters

- `file` (string): workspace script file ending in `.js`, `.mjs`, or `.cjs`.

## Optional parameters

- `args` (string[]): literal positional arguments for the script.
- `cwd` (string): working directory; defaults to the workspace root.
- `timeoutSeconds` (number): process deadline in seconds; default 120.
- `maxOutputBytes` (number): combined stdout/stderr byte ceiling; default 1 MiB.
- `maxOutputLines` (number): keep only the tail N lines of each stream.

## Result

- `file` (string): the script that ran.
- `exitCode` (number): process exit status; `0` means success.
- `stdout` / `stderr` (string): captured streams.
- `stdoutTruncated` / `stderrTruncated` (boolean): truncation flags.
- `durationMs` (number): elapsed wall-clock time.

## Formatted terminal output

The runtime announces the call as `RunScript({...})`. Success renders a green
circle; a non-zero exit renders a red circle with `exit N` followed by stderr
then stdout diagnostics. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid `file` extension/blank path, invalid args, or invalid numeric bounds:
  `TypeError`.
- Process spawn failure, deadline, signal, or output-limit overflow rejects
  with a structured process error carrying bounded partial output.

## Critical operating constraints

- The script must end in `.js`, `.mjs`, or `.cjs` and must not start with `-`.
- The script path must resolve inside the workspace.

## Safe use

**Allowed**
- Running an existing workspace script with literal arguments.

**Denied**
- Arbitrary `node -e` evaluation, node flags, or scripts outside the workspace.

**Dangerous examples (do not run)**
- `RunScript({ file: "-e" })`
- `RunScript({ file: "../outside/run.js" })`

**Required permissions**
- Read/execute permission on the script within the workspace.

## Examples

1. Run a workspace script:

   ```js
   await RunScript({ file: "scripts/smoke.js" });
   ```

2. Run a script with arguments and tail output:

   ```js
   await RunScript({ file: "scripts/check.js", args: ["--ci"], maxOutputLines: 20 });
   ```
