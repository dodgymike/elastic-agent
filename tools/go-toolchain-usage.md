# GoToolchain tool usage

## Purpose

Run whitelisted Go toolchain commands for a Go module. Only `build`, `test`,
`vet`, `version`, and `fmt` are accepted; every other `go` verb is refused.
Package patterns are validated as safe argv.

## When to use

Use `GoToolchain` for `go build`, `go test`, `go vet`, `go version`, and `go
fmt` inside a boundary-checked module directory. Use `ExecuteCommand` only for
Go operations outside this whitelist.

## Required parameters

- `action` (string): `build`, `test`, `vet`, `version`, or `fmt`.

## Optional parameters

- `packages` (string[]): package patterns such as `./internal/ids/...`. No
  leading `-`, `|`, or `;`.
- `race` (boolean): append `-race` (test only).
- `run` (string): optional `-run` regex (test only).
- `cwd` (string): boundary-checked module directory; defaults to the workspace
  root.
- `timeoutSeconds` (number): process deadline in seconds; default 120.
- `maxOutputBytes` (number): combined stdout/stderr byte ceiling; default 1 MiB.
- `maxOutputLines` (number): keep only the tail N lines of each stream.

## Result

- `action` (string): the action that ran.
- `exitCode` (number): process exit status; `0` means success.
- `stdout` / `stderr` (string): captured streams.
- `stdoutTruncated` / `stderrTruncated` (boolean): truncation flags.
- `durationMs` (number): elapsed wall-clock time.

## Formatted terminal output

The runtime announces the call as `GoToolchain({...})`. Success renders a green
circle; a non-zero exit renders a red circle with `exit N` followed by stderr
then stdout diagnostics. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Unknown `action`, unsafe package pattern, `race`/`run` with a non-test
  action, or invalid numeric bounds: `TypeError`.
- Process spawn failure, deadline, signal, or output-limit overflow rejects
  with a structured process error carrying bounded partial output.

## Critical operating constraints

- Only the five actions are accepted.
- `race` and `run` are valid only with `action: "test"`.
- `version` takes no package patterns.
- `fmt` writes source files and follows the
  `--allow-agent-source-modifications`/`--safe-dir` policy; `version` is
  read-only.

## Safe use

**Allowed**
- `build`, `test`, `vet`, `version`, and `fmt` with validated package
  patterns.

**Denied**
- Any other `go` verb (for example `run`, `install`, `mod`, `get`, `clean`).
- Package patterns containing `|`, `;`, or a leading `-`.

**Dangerous examples (do not run)**
- `GoToolchain({ action: "run", packages: ["main.go"] })`
- `GoToolchain({ action: "build", packages: ["./...; rm -rf ."] })`

**Required permissions**
- Read access to the module; `fmt` additionally requires write access.

## Examples

1. Build a module:

   ```js
   await GoToolchain({ action: "build", packages: ["./..."] });
   ```

2. Run tests with the race detector:

   ```js
   await GoToolchain({ action: "test", packages: ["./internal/ids/..."], race: true });
   ```

3. Show the Go version:

   ```js
   await GoToolchain({ action: "version" });
   ```
