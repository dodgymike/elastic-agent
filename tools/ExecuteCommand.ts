import { spawn } from "node:child_process";

/** The result produced by {@link executeCommand}. */
export interface ExecuteCommandResult {
  /** The process exit code. A zero value conventionally indicates success. */
  exitCode: number;
  /** Data written by the command to standard output. */
  stdout: string;
  /** Data written by the command to standard error. */
  stderr: string;
}

/**
 * Runs a Bash command and collects its output.
 *
 * `parameters` are exposed to the Bash command as positional parameters:
 * `parameters[0]` is `$1`, `parameters[1]` is `$2`, and so on. For example:
 *
 * ```ts
 * await executeCommand('printf "%s\\n" "$1"', ['hello']);
 * ```
 *
 * @param command Bash source to execute.
 * @param parameters Values to pass as Bash positional parameters.
 * @throws If Bash cannot be started, or if it is terminated by a signal before
 * producing an exit code.
 */
export function executeCommand(
  command: string,
  parameters: readonly string[] = [],
): Promise<ExecuteCommandResult> {
  return new Promise((resolve, reject) => {
    // The `--` supplies $0 to `bash -c`; this prevents the first user-provided
    // parameter from being consumed as $0. Passing an argument array (rather
    // than constructing a shell string) preserves each parameter verbatim.
    const child = spawn("bash", ["-c", command, "--", ...parameters], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      spawnError = error;
    });

    child.once("close", (exitCode, signal) => {
      if (spawnError) {
        reject(spawnError);
      } else if (exitCode === null) {
        reject(new Error(`Bash was terminated by signal ${signal ?? "unknown"}`));
      } else {
        resolve({ exitCode, stdout, stderr });
      }
    });
  });
}
