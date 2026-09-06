import { shellEnvironment, shellModeFromEnvironment, shellSandboxFailureMessage, sandboxArguments, type ShellPolicy } from "./shell-policy.js";
import { spawn } from "node:child_process";
import { detectAgentBusCommand } from "./agent-bus-detect.js";

export interface ExecuteCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly policy?: ShellPolicy;
}

export interface ExecuteCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when stdout was capped at `maxOutputBytes` and some output was dropped. */
  stdoutTruncated: boolean;
  /** True when stderr was capped at `maxOutputBytes` and some output was dropped. */
  stderrTruncated: boolean;
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

  constructor(message: string, partial: ExecuteCommandPartialOutput) {
    super(message);
    this.name = "ExecuteCommandError";
    this.stdout = partial.stdout;
    this.stderr = partial.stderr;
    this.stdoutTruncated = partial.stdoutTruncated;
    this.stderrTruncated = partial.stderrTruncated;
  }

  /** Serializable payload merged into the tool result by the dispatcher. */
  toToolPayload(): ExecuteCommandPartialOutput & { reason: string } {
    return {
      reason: this.message,
      stdout: this.stdout,
      stderr: this.stderr,
      stdoutTruncated: this.stdoutTruncated,
      stderrTruncated: this.stderrTruncated,
    };
  }
}

/**
 * Runs validated Bash source with literal positional parameters. When `cwd` is
 * supplied it is passed straight to the spawned process instead of mutating the
 * process-wide working directory.
 */
export function executeCommand(
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
  // run before any file/identity read or HTTP call in the execution path. When
  // a refusal is detected we reject definitively and never run the shell
  // command. See tools/agent-bus-detect.ts for the exact matching rules.
  const agentBusDetection = detectAgentBusCommand(command);
  if (agentBusDetection.action === "refuse") {
    const error = new Error(agentBusDetection.reason);
    error.name = "AgentBusCommandRefused";
    return Promise.reject(error);
  }

  if (typeof command !== "string" || command.trim() === "") throw new TypeError("command must be a non-empty string.");
  if (command.includes("\0")) throw new TypeError("command cannot contain NUL characters.");
  if (!Array.isArray(parameters) || parameters.some((parameter) => typeof parameter !== "string" || parameter.includes("\0"))) {
    throw new TypeError("parameters must be an array of strings without NUL characters.");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxBytes = options.maxOutputBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Shell timeout and output limit must be positive integers.");
  }
  if (options.signal?.aborted) throw new Error("Shell execution aborted.");
  const workdir = cwd ?? process.cwd();
  const policy = options.policy ?? { mode: shellModeFromEnvironment(), writableRoots: [workdir], readableRoots: [] };
  if (policy.mode !== "sandbox" && policy.mode !== "trusted-host") throw new Error("Invalid shell policy mode.");
  const executable = policy.mode === "sandbox" ? "/usr/bin/bwrap" : "/bin/bash";
  const args = policy.mode === "sandbox" ? sandboxArguments(policy, workdir, command, parameters)
    : ["--noprofile", "--norc", "-c", command, "--", ...parameters];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: workdir, env: shellEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let bytes = 0; let failure: Error | undefined;
    let stdoutTruncated = false; let stderrTruncated = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) try { process.kill(-child.pid, signal); } catch { /* already exited */ }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 250);
    };
    const abort = () => stop(new Error("Shell execution aborted."));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error("Shell execution deadline exceeded.")), timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer, markTruncated: () => void) => {
      const remaining = Math.max(0, maxBytes - bytes);
      bytes += chunk.length;
      if (remaining) target.push(chunk.subarray(0, remaining));
      if (bytes > maxBytes) {
        markTruncated();
        stop(new Error("Shell output exceeds byte limit."));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, () => { stdoutTruncated = true; }));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, () => { stderrTruncated = true; }));
    child.once("error", (error) => { failure = error; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      killGroup("SIGKILL"); // Do not leave background descendants behind.
      const partial = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), stdoutTruncated, stderrTruncated };
      if (failure) reject(new ExecuteCommandError(
        policy.mode === "sandbox" && (failure as NodeJS.ErrnoException).code === "ENOENT"
          ? shellSandboxFailureMessage() : failure.message,
        partial,
      ));
      else if (exitCode === null) reject(new ExecuteCommandError(`Shell was terminated by signal ${signal ?? "unknown"}`, partial));
      else if (policy.mode === "sandbox" && exitCode !== 0 && Buffer.concat(stderr).toString().includes("bwrap:")) {
        reject(new ExecuteCommandError(shellSandboxFailureMessage(), partial));
      } else resolve({ exitCode, stdout: partial.stdout, stderr: partial.stderr, stdoutTruncated: false, stderrTruncated: false });
    });
  });
}
