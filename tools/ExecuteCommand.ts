import { spawn } from "node:child_process";

export interface ExecuteCommandResult { exitCode: number; stdout: string; stderr: string; }

/** Runs validated Bash source with literal positional parameters. */
export function executeCommand(command: string, parameters: readonly string[] = []): Promise<ExecuteCommandResult> {
  if (typeof command !== "string" || command.trim() === "") throw new TypeError("command must be a non-empty string.");
  if (command.includes("\0")) throw new TypeError("command cannot contain NUL characters.");
  if (!Array.isArray(parameters) || parameters.some((parameter) => typeof parameter !== "string" || parameter.includes("\0"))) {
    throw new TypeError("parameters must be an array of strings without NUL characters.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command, "--", ...parameters], { stdio: ["ignore", "pipe", "pipe"] });
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
