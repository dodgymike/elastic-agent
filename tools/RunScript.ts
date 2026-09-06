import { runProcess } from "./process-runner.js";
import type { ShellPolicy } from "./shell-policy.js";

export interface RunScriptOptions {
  /** Existing .js/.mjs/.cjs file in the workspace. */
  file: string;
  /** Literal positional arguments for the script. */
  args?: readonly string[];
  cwd?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
  /** Internal runtime wiring; not part of the advertised schema. */
  signal?: AbortSignal;
  /** Internal runtime wiring; not part of the advertised schema. */
  policy?: ShellPolicy;
}

export interface RunScriptResult {
  file: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_SECONDS = 120;

function validateFile(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("file must be a non-empty string.");
  }
  if (value.includes("\0")) {
    throw new TypeError("file cannot contain NUL characters.");
  }
  if (value.startsWith("-")) {
    throw new TypeError("file must not start with '-'.");
  }
  if (!/\.(?:js|mjs|cjs)$/i.test(value)) {
    throw new TypeError("file must end in .js, .mjs, or .cjs.");
  }
  return value;
}

function validateStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
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

/**
 * Run an existing .js/.mjs/.cjs file in the workspace with `node`, never
 * through a shell. The script path is passed as a literal argv element after
 * the fixed `node` executable, so it cannot inject node flags.
 */
export default async function RunScript(options: RunScriptOptions): Promise<RunScriptResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("RunScript options must be an object.");
  }
  const file = validateFile(options.file);
  const args = validateStringArray(options.args, "args");
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  const timeoutSeconds = options.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : positiveInteger(options.timeoutSeconds, "timeoutSeconds");

  const result = await runProcess(["node", file, ...args], {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: timeoutSeconds * 1000,
    maxOutputBytes: options.maxOutputBytes,
    maxOutputLines: options.maxOutputLines,
    signal: options.signal,
    policy: options.policy,
  });

  return {
    file,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
  };
}
