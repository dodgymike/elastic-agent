# ExecuteCommand tool usage

## Purpose

Run a Bash command and return its exit code, standard output, and standard
error. Caller-supplied parameters are passed to `bash` as literal positional
arguments rather than being re-parsed by the shell.

## When to use

Use `ExecuteCommand` for shell verification such as grep checks, builds, tests,
and repository inspection not covered by the dedicated `Git` tool. Do not use it
to edit files when `Read`/`Write`/`Edit` are appropriate. Prefer passing
dynamic data as `parameters` instead of shell interpolation.

## Required parameters

- `command` (string): Bash source to execute.

## Optional parameters

- `parameters` (array of strings): literal positional arguments available to the
  command via `$1`, `$2`, ... (through `bash -c command -- <parameters>`).

## Result

- `exitCode` (number): process exit status; `0` means success.
- `stdout` (string): captured standard output.
- `stderr` (string): captured standard error.

## Error handling

- Empty command or NUL in command/parameters: `TypeError`.
- Process spawn error: the promise rejects with the spawn error.
- Termination by signal: rejects with
  `Bash was terminated by signal <signal>`.
- A non-zero `exitCode` is **returned, not thrown**; always inspect `exitCode`
  and `stderr` before trusting the output.

## Critical operating constraints

- `command` must be a non-empty string and must not contain NUL characters.
- `parameters` must be an array of non-NUL strings.
- Standard input is ignored.
- Prefer passing data as `parameters` instead of shell interpolation to avoid
  quoting/injection bugs.

## Examples

1. Simple command:

   ```js
   await ExecuteCommand({ command: "git diff --check" });
   ```

2. Positional parameters:

   ```js
   await ExecuteCommand({ command: "echo $1 $2", parameters: ["hello", "world"] });
   ```

3. Check the exit status:

   ```js
   const r = await ExecuteCommand({ command: "npm run test:plan-print" });
   if (r.exitCode !== 0) {
     console.error(r.stderr);
   }
   ```
