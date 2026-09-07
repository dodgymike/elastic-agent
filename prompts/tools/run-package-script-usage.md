# RunPackageScript tool usage

## Purpose

Run a script declared in `package.json#scripts` via `npm run <script>` without
invoking a shell. Only `run` is allowed; install/publish/exec/update are never
run.

## When to use

Use `RunPackageScript` for `npm run build`, `npm run test:*`, `npm run
migrate:*`, and any other declared package script. Use `ExecuteCommand` only
for ad-hoc npm verification outside the declared scripts.

## Required parameters

- `script` (string): must exactly match a key in `package.json#scripts`.

## Optional parameters

- `args` (string[]): positional arguments appended after `--`.
- `cwd` (string): directory containing package.json; defaults to the workspace
  root.
- `timeoutSeconds` (number): process deadline in seconds; default 120.
- `maxOutputBytes` (number): combined stdout/stderr byte ceiling; default 1 MiB.
- `maxOutputLines` (number): keep only the tail N lines of each stream.
- `env` (string[]): `KEY=value` overrides merged over the filtered environment.

## Result

- `script` (string): the declared script that ran.
- `command` (string[]): the literal argv that was run, excluding `npm`.
- `exitCode` (number): process exit status; `0` means success.
- `stdout` / `stderr` (string): captured streams.
- `stdoutTruncated` / `stderrTruncated` (boolean): truncation flags.
- `durationMs` (number): elapsed wall-clock time.

A non-zero `exitCode` is returned, not thrown.

## Formatted terminal output

The runtime announces the call as `RunPackageScript({...})`. While it runs, an
in-place timer line ticks and is finalized with the elapsed time. Success
renders a green circle (clean success renders only the circle); a non-zero exit
renders a red circle with `exit N` followed by stderr then stdout diagnostics.
No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Missing/blank `script`, invalid `cwd`, or invalid numeric bounds: `TypeError`.
- A script name not declared in `package.json#scripts`: `TypeError`.
- Process spawn failure, deadline, signal, or output-limit overflow rejects
  with a structured process error carrying bounded partial output.

## Critical operating constraints

- Only `npm run <script>` is executed; no other npm subcommand is possible.
- The script name is validated against `package.json#scripts` before npm runs,
  so it cannot inject npm flags or extra commands.

## Safe use

**Allowed**
- Running declared package.json scripts (`build`, `test:*`, `migrate:*`).

**Denied**
- `install`, `publish`, `exec`, `update`, or arbitrary npm subcommands.
- Passing an undeclared or `-`-prefixed script name.

**Dangerous examples (do not run)**
- `RunPackageScript({ script: "install" })`
- `RunPackageScript({ script: "--version" })`

**Required permissions**
- `script` must be declared in `package.json#scripts`.

## Examples

1. Run the build script:

   ```js
   await RunPackageScript({ script: "build" });
   ```

2. Run a focused test with tail output:

   ```js
   await RunPackageScript({ script: "test:tool-safety", maxOutputLines: 40 });
   ```
