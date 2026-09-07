import { runProcess } from "./process-runner.js";
import type { ShellPolicy } from "./shell-policy.js";

export interface RunNodeTestOptions {
  /** Workspace test files passed to `node --test`. */
  files: readonly string[];
  cwd?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
  /** Internal runtime wiring; not part of the advertised schema. */
  signal?: AbortSignal;
  /** Internal runtime wiring; not part of the advertised schema. */
  policy?: ShellPolicy;
}

export interface RunNodeTestResult {
  files: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_SECONDS = 120;

function validateFiles(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("files must be a non-empty array of strings.");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new TypeError("files must contain only non-empty strings.");
    }
    if (entry.includes("\0")) {
      throw new TypeError("files entries cannot contain NUL characters.");
    }
    if (entry.startsWith("-")) {
      throw new TypeError("files entries must not start with '-'.");
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

/**
 * Run `node --test <files...>` for workspace test files. The fixed `--test`
 * flag and the literal file argv prevent flag injection and shell parsing.
 */
export default async function RunNodeTest(options: RunNodeTestOptions): Promise<RunNodeTestResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("RunNodeTest options must be an object.");
  }
  const files = validateFiles(options.files);
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  const timeoutSeconds = options.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : positiveInteger(options.timeoutSeconds, "timeoutSeconds");

  const result = await runProcess(["node", "--test", ...files], {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: timeoutSeconds * 1000,
    maxOutputBytes: options.maxOutputBytes,
    maxOutputLines: options.maxOutputLines,
    signal: options.signal,
    policy: options.policy,
  });

  return {
    files: [...files],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
  };
}
