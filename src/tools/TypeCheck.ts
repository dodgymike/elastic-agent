import { existsSync } from "node:fs";
import { runProcess } from "./process-runner.js";
import type { ShellPolicy } from "./shell-policy.js";

export interface TypeCheckOptions {
  /** Files to compile; each must resolve inside the workspace. */
  files?: readonly string[];
  /** Type-check only; defaults to true. Pass false to emit. */
  noEmit?: boolean;
  /** Optional output directory for emit mode; must resolve inside the workspace. */
  outDir?: string;
  /** Optional path to a tsconfig.json. Mutually exclusive with `files`. */
  tsconfig?: string;
  /** Working directory; defaults to the workspace root. */
  cwd?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
  /** Internal runtime wiring; not part of the advertised schema. */
  signal?: AbortSignal;
  /** Internal runtime wiring; not part of the advertised schema. */
  policy?: ShellPolicy;
}

export interface TypeCheckResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  files: string[];
}

const DEFAULT_TIMEOUT_SECONDS = 120;

function validateString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${field} cannot contain NUL characters.`);
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
    if (entry.startsWith("-")) {
      throw new TypeError(`${field} entries must not start with '-'.`);
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
 * Run the project's TypeScript compiler in check or emit mode with a fixed,
 * repo-approved flag set. Flags are built by the tool (never pasted by the
 * model), which prevents `--outDir /etc` and other flag injection. `tsc` is
 * spawned directly, never through a shell.
 */
export default async function TypeCheck(options: TypeCheckOptions): Promise<TypeCheckResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("TypeCheck options must be an object.");
  }
  const files = validateStringArray(options.files, "files");
  const tsconfig = options.tsconfig === undefined ? undefined : validateString(options.tsconfig, "tsconfig");
  const outDir = options.outDir === undefined ? undefined : validateString(options.outDir, "outDir");
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  if (options.noEmit !== undefined && typeof options.noEmit !== "boolean") {
    throw new TypeError("noEmit must be a boolean when provided.");
  }
  const timeoutSeconds = options.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : positiveInteger(options.timeoutSeconds, "timeoutSeconds");
  if (files.length > 0 && tsconfig !== undefined) {
    throw new TypeError("Specify either files or tsconfig, not both.");
  }

  const cwd = options.cwd ?? process.cwd();
  const localTsc = `${cwd}/node_modules/.bin/tsc`;
  const executable = existsSync(localTsc) ? localTsc : "tsc";
  const argv = [executable];

  // `--project` owns compiler options when a tsconfig is supplied; otherwise
  // the fixed repo-approved flag set is applied. `--noEmit` is the default
  // unless the caller explicitly opts into emit mode.
  if (options.noEmit !== false) argv.push("--noEmit");
  if (tsconfig !== undefined) {
    argv.push("--project", tsconfig);
  } else {
    argv.push(
      "--target", "es2022",
      "--module", "nodenext",
      "--moduleResolution", "nodenext",
      "--skipLibCheck",
      "--types", "node",
    );
  }
  if (outDir !== undefined) argv.push("--outDir", outDir);
  if (files.length > 0) argv.push(...files);

  const result = await runProcess(argv, {
    cwd,
    timeoutMs: timeoutSeconds * 1000,
    maxOutputBytes: options.maxOutputBytes,
    maxOutputLines: options.maxOutputLines,
    signal: options.signal,
    policy: options.policy,
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
    files: [...files],
  };
}
