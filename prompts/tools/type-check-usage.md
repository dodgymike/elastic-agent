# TypeCheck tool usage

## Purpose

Run the project's TypeScript compiler in check or emit mode with a fixed,
repo-approved flag set. Flags are built by the tool, never pasted by the model,
so `--outDir /etc` and other flag injection are impossible. `tsc` is spawned
directly, never through a shell.

## When to use

Use `TypeCheck` instead of `npx tsc`, `./node_modules/.bin/tsc`, or bare `tsc`.
Use `RunPackageScript` when the repository already has a typed check script.

## Required parameters

None; the tool defaults to a type-check (`--noEmit`) of the workspace root.

## Optional parameters

- `files` (string[]): files to compile; each must resolve inside the workspace.
- `noEmit` (boolean): type-check only; defaults to `true`. Pass `false` to emit.
- `outDir` (string): optional output directory for emit mode.
- `tsconfig` (string): optional path to a `tsconfig.json`. Mutually exclusive
  with `files`.
- `cwd` (string): working directory; defaults to the workspace root.
- `timeoutSeconds` (number): process deadline in seconds; default 120.
- `maxOutputBytes` (number): combined stdout/stderr byte ceiling; default 1 MiB.
- `maxOutputLines` (number): keep only the tail N lines of each stream.

## Result

- `exitCode` (number): process exit status; `0` means success.
- `stdout` / `stderr` (string): captured streams.
- `stdoutTruncated` / `stderrTruncated` (boolean): truncation flags.
- `durationMs` (number): elapsed wall-clock time.
- `files` (string[]): the files that were passed (empty when tsconfig was used).

## Formatted terminal output

The runtime announces the call as `TypeCheck({...})`. Success renders a green
circle; a non-zero exit renders a red circle with `exit N` followed by stderr
then stdout diagnostics. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid `files`, `cwd`, `outDir`, `tsconfig`, or numeric bounds: `TypeError`.
- Supplying both `files` and `tsconfig`: `TypeError`.
- Process spawn failure, deadline, signal, or output-limit overflow rejects
  with a structured process error carrying bounded partial output.

## Critical operating constraints

- Compiler flags are fixed (`es2022` / `nodenext` / `skipLibCheck` / node
  types) and are not user-extensible.
- When `tsconfig` is supplied, `--project tsconfig` owns compiler options;
  otherwise the fixed flag set is applied.
- `--noEmit` is the default unless `noEmit: false` is explicit.

## Safe use

**Allowed**
- Type-checking or emitting workspace TypeScript files.

**Denied**
- Arbitrary tsc flags, `--outDir` outside the workspace, or combining `files`
  and `tsconfig`.

**Dangerous examples (do not run)**
- `TypeCheck({ outDir: "/etc" })`
- `TypeCheck({ files: ["src/index.ts"], tsconfig: "tsconfig.json" })`

**Required permissions**
- Read access to the compiled files; emit mode additionally follows the
  `--allow-agent-source-modifications`/`--safe-dir` policy.

## Examples

1. Type-check the project:

   ```js
   await TypeCheck({});
   ```

2. Type-check specific files:

   ```js
   await TypeCheck({ files: ["src/tools/Read.ts", "src/tools/Grep.ts"] });
   ```

3. Emit with a tsconfig:

   ```js
   await TypeCheck({ noEmit: false, tsconfig: "tsconfig.json" });
   ```
