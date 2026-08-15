import { spawn } from "node:child_process";

export interface ExecuteCommandResult { exitCode: number; stdout: string; stderr: string; }

/**
 * Runs validated Bash source with literal positional parameters. When `cwd` is
 * supplied it is passed straight to the spawned process instead of mutating the
 * process-wide working directory.
 */
export function executeCommand(
  command: string,
  parameters: readonly string[] = [],
  cwd?: string,
): Promise<ExecuteCommandResult> {
  if (typeof command !== "string" || command.trim() === "") throw new TypeError("command must be a non-empty string.");
  if (command.includes("\0")) throw new TypeError("command cannot contain NUL characters.");
  if (!Array.isArray(parameters) || parameters.some((parameter) => typeof parameter !== "string" || parameter.includes("\0"))) {
    throw new TypeError("parameters must be an array of strings without NUL characters.");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command, "--", ...parameters], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let spawnError: Error | undefined;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (exitCode, signal) => {
      if (spawnError) reject(spawnError);
      else if (exitCode === null) reject(new Error(`Bash was terminated by signal ${signal ?? "unknown"}`));
      else resolve({ exitCode, stdout, stderr });
    });
  });
}
