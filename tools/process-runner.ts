import { spawn } from "node:child_process";
import {
  shellEnvironment,
  shellModeFromEnvironment,
  shellSandboxFailureMessage,
  sandboxExecArguments,
  type ShellPolicy,
} from "./shell-policy.js";

export interface ProcessRunnerOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputLines?: number;
  readonly policy?: ShellPolicy;
  readonly cwd?: string;
  /** Literal `KEY=value` environment overrides merged over the filtered env. */
  readonly env?: readonly string[];
}

export interface ProcessRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

/** Partial process output preserved when a bounded run is cancelled or capped. */
export interface ProcessRunnerPartialOutput {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * Error raised when a process run is aborted, exceeds its deadline, exceeds
 * its output ceiling, fails to spawn, or is terminated by a signal. The capped
 * partial output, truncation flags, and elapsed duration remain available so
 * the caller/model can see what ran.
 */
export class ProcessRunnerError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;

  constructor(message: string, partial: ProcessRunnerPartialOutput, durationMs: number) {
    super(message);
    this.name = "ProcessRunnerError";
    this.stdout = partial.stdout;
    this.stderr = partial.stderr;
    this.stdoutTruncated = partial.stdoutTruncated;
    this.stderrTruncated = partial.stderrTruncated;
    this.durationMs = durationMs;
  }

  /** Serializable payload merged into the tool result by the dispatcher. */
  toToolPayload(): ProcessRunnerPartialOutput & { reason: string; durationMs: number } {
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

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

function validateStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of strings.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new TypeError(`${field} must contain only strings without NUL characters.`);
    }
  }
  return value as readonly string[];
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return value;
}

function mergeEnvironment(overrides: readonly string[] | undefined): NodeJS.ProcessEnv {
  const environment = shellEnvironment();
  if (overrides === undefined) return environment;
  for (const entry of overrides) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, separator))) {
      throw new TypeError(`env entries must be KEY=value strings with a valid variable name.`);
    }
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

/** Keep only the final `maxLines` lines of `text`, preserving LF line endings. */
function tailLines(text: string, maxLines: number | undefined): { text: string; truncated: boolean } {
  if (maxLines === undefined) return { text, truncated: false };
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(lines.length - maxLines).join("\n"), truncated: true };
}

/**
 * Run `argv` (a literal program plus arguments) under the shared shell policy.
 *
 * In `sandbox` mode the process runs inside the bubblewrap mount namespace
 * built by `sandboxExecArguments`. In `trusted-host` mode `argv[0]` is spawned
 * directly with `argv.slice(1)` — still without a shell, with the filtered
 * environment, the configured deadline, and the combined stdout/stderr output
 * ceiling. Both modes terminate the whole process group on abort, deadline, or
 * output-limit overflow and never leave background descendants behind.
 *
 * Normal non-zero exits are resolved as results, never thrown, per
 * ERROR_HANDLING.md. Abnormal execution (spawn failure, timeout, signal,
 * output overflow) rejects with `ProcessRunnerError`.
 */
export async function runProcess(
  argv: readonly string[],
  options: ProcessRunnerOptions = {},
): Promise<ProcessRunnerResult> {
  const program = validateStringArray(argv, "argv");
  if (program.length === 0) throw new TypeError("argv must contain at least the program to run.");

  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : positiveInteger(options.timeoutMs, "timeoutMs");
  const maxBytes = options.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : positiveInteger(options.maxOutputBytes, "maxOutputBytes");
  const maxLines = options.maxOutputLines === undefined ? undefined : positiveInteger(options.maxOutputLines, "maxOutputLines");
  const environment = mergeEnvironment(options.env);
  if (options.signal?.aborted) throw new Error("Process execution aborted.");

  const workdir = options.cwd ?? process.cwd();
  const policy = options.policy ?? { mode: shellModeFromEnvironment(), writableRoots: [workdir], readableRoots: [] };
  if (policy.mode !== "sandbox" && policy.mode !== "trusted-host") throw new Error("Invalid shell policy mode.");

  const executable = policy.mode === "sandbox" ? "/usr/bin/bwrap" : program[0];
  const args = policy.mode === "sandbox" ? sandboxExecArguments(policy, workdir, program) : program.slice(1);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: workdir, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // Already exited.
        }
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 250);
    };
    const abort = () => stop(new Error("Process execution aborted."));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error("Process execution deadline exceeded.")), timeoutMs);

    const collect = (target: Buffer[], chunk: Buffer, markTruncated: () => void) => {
      const remaining = Math.max(0, maxBytes - bytes);
      bytes += chunk.length;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (bytes > maxBytes) {
        markTruncated();
        stop(new Error("Process output exceeds byte limit."));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, () => {
      stdoutTruncated = true;
    }));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, () => {
      stderrTruncated = true;
    }));
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      killGroup("SIGKILL"); // Do not leave background descendants behind.

      const stdoutTail = tailLines(Buffer.concat(stdout).toString("utf8"), maxLines);
      const stderrTail = tailLines(Buffer.concat(stderr).toString("utf8"), maxLines);
      const partial: ProcessRunnerPartialOutput = {
        stdout: stdoutTail.text,
        stderr: stderrTail.text,
        stdoutTruncated: stdoutTruncated || stdoutTail.truncated,
        stderrTruncated: stderrTruncated || stderrTail.truncated,
      };
      const durationMs = Date.now() - started;

      if (failure) {
        reject(new ProcessRunnerError(
          policy.mode === "sandbox" && (failure as NodeJS.ErrnoException).code === "ENOENT"
            ? shellSandboxFailureMessage()
            : failure.message,
          partial,
          durationMs,
        ));
      } else if (exitCode === null) {
        reject(new ProcessRunnerError(`Process was terminated by signal ${signal ?? "unknown"}`, partial, durationMs));
      } else if (policy.mode === "sandbox" && exitCode !== 0 && partial.stderr.includes("bwrap:")) {
        reject(new ProcessRunnerError(shellSandboxFailureMessage(), partial, durationMs));
      } else {
        resolve({
          exitCode,
          stdout: partial.stdout,
          stderr: partial.stderr,
          stdoutTruncated: partial.stdoutTruncated,
          stderrTruncated: partial.stderrTruncated,
          durationMs,
        });
      }
    });
  });
}
