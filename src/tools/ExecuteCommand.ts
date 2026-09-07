import { runProcess, ProcessRunnerError } from "./process-runner.js";
import { detectAgentBusCommand } from "./agent-bus-detect.js";
import type { ShellPolicy } from "./shell-policy.js";

export type { ShellPolicy } from "./shell-policy.js";

export interface ExecuteCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputLines?: number;
  readonly policy?: ShellPolicy;
}

export interface ExecuteCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when stdout was capped and some output was dropped. */
  stdoutTruncated: boolean;
  /** True when stderr was capped and some output was dropped. */
  stderrTruncated: boolean;
  /** Wall-clock elapsed time for the spawned process in milliseconds. */
  durationMs: number;
}

/** Partial shell output preserved when a bounded run is cancelled or capped. */
export interface ExecuteCommandPartialOutput {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * Error raised when a shell run is aborted, exceeds its deadline, exceeds its
 * output ceiling, or is terminated by a signal. The capped partial output and
 * truncation flags remain available so the caller/model can see what ran.
 */
export class ExecuteCommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;

  constructor(message: string, partial: ExecuteCommandPartialOutput, durationMs = 0) {
    super(message);
    this.name = "ExecuteCommandError";
    this.stdout = partial.stdout;
    this.stderr = partial.stderr;
    this.stdoutTruncated = partial.stdoutTruncated;
    this.stderrTruncated = partial.stderrTruncated;
    this.durationMs = durationMs;
  }

  /** Serializable payload merged into the tool result by the dispatcher. */
  toToolPayload(): ExecuteCommandPartialOutput & { reason: string; durationMs: number } {
    return {
      reason: this.message,
      stdout: this.stdout,
      stderr: this.stderr,
      stdoutTruncated: this.stdoutTruncated,
      stderrTruncated: this.stderrTruncated,
      durationMs: this.durationMs,
    };
  }
}

/**
 * Runs validated Bash source with literal positional parameters. When `cwd` is
 * supplied it is passed straight to the spawned process instead of mutating the
 * process-wide working directory. `maxOutputLines`, when supplied, keeps only
 * the tail of each captured stream.
 */
export async function executeCommand(
  command: string,
  parameters: readonly string[] = [],
  cwd?: string,
  options: ExecuteCommandOptions = {},
): Promise<ExecuteCommandResult> {
  // Agent-bus guard (defense in depth): refuse any command that executes an
  // agent-bus binary (`agent-busctl`/`agentbus`/`agent-bus`) BEFORE we spawn a
  // process. All agent-bus activity is owned by the dedicated `AgentBus`
  // (whoami/watch/send) and `AgentBusEnrol` (enroll) tools. The detector is
  // pure string logic — no I/O, no process spawn — so this guard is safe to
  // run before any file/identity read or HTTP call in the execution path.
  const agentBusDetection = detectAgentBusCommand(command);
  if (agentBusDetection.action === "refuse") {
    const error = new Error(agentBusDetection.reason);
    error.name = "AgentBusCommandRefused";
    throw error;
  }

  if (typeof command !== "string" || command.trim() === "") throw new TypeError("command must be a non-empty string.");
  if (command.includes("\0")) throw new TypeError("command cannot contain NUL characters.");
  if (!Array.isArray(parameters) || parameters.some((parameter) => typeof parameter !== "string" || parameter.includes("\0"))) {
    throw new TypeError("parameters must be an array of strings without NUL characters.");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  if (options.signal?.aborted) throw new Error("Shell execution aborted.");

  const argv = ["/bin/bash", "--noprofile", "--norc", "-c", command, "--", ...parameters];
  try {
    return await runProcess(argv, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      maxOutputLines: options.maxOutputLines,
      policy: options.policy,
      cwd,
    });
  } catch (error) {
    if (error instanceof ProcessRunnerError) {
      throw new ExecuteCommandError(error.message, {
        stdout: error.stdout,
        stderr: error.stderr,
        stdoutTruncated: error.stdoutTruncated,
        stderrTruncated: error.stderrTruncated,
      }, error.durationMs);
    }
    throw error;
  }
}
