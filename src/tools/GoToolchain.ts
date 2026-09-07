import { runProcess } from "./process-runner.js";
import type { ShellPolicy } from "./shell-policy.js";

export type GoToolchainAction = "build" | "test" | "vet" | "version" | "fmt";

export interface GoToolchainOptions {
  /** Whitelisted go toolchain action. */
  action: GoToolchainAction;
  /** Package patterns such as `./internal/ids/...`. */
  packages?: readonly string[];
  /** Append `-race` (test only). */
  race?: boolean;
  /** Optional `-run` regex (test only). */
  run?: string;
  /** Boundary-checked module directory; defaults to the workspace root. */
  cwd?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
  /** Internal runtime wiring; not part of the advertised schema. */
  signal?: AbortSignal;
  /** Internal runtime wiring; not part of the advertised schema. */
  policy?: ShellPolicy;
}

export interface GoToolchainResult {
  action: GoToolchainAction;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

const ACTIONS: readonly GoToolchainAction[] = ["build", "test", "vet", "version", "fmt"];
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

function validatePackages(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("packages must be an array of strings.");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new TypeError("packages must contain only strings without NUL characters.");
    }
    if (entry.startsWith("-") || entry.includes("|") || entry.includes(";")) {
      throw new TypeError(`package pattern '${entry}' is not a safe argv value.`);
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
 * Run whitelisted Go toolchain commands for a Go module. Only the five actions
 * are accepted; every other `go` verb is refused. Package patterns are
 * validated as safe argv (no `|`, `;`, or leading `-`), and `race`/`run` are
 * accepted only with `action: "test"`. `fmt` writes source files and follows
 * the `--allow-agent-source-modifications` policy; `version` is read-only.
 */
export default async function GoToolchain(options: GoToolchainOptions): Promise<GoToolchainResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("GoToolchain options must be an object.");
  }
  const action = validateString(options.action, "action") as GoToolchainAction;
  if (!ACTIONS.includes(action)) {
    throw new TypeError(`GoToolchain action must be one of: ${ACTIONS.join(", ")}.`);
  }
  const packages = validatePackages(options.packages);
  if (options.race !== undefined && typeof options.race !== "boolean") {
    throw new TypeError("race must be a boolean when provided.");
  }
  if (options.run !== undefined && (typeof options.run !== "string" || options.run.includes("\0"))) {
    throw new TypeError("run must be a string without NUL characters when provided.");
  }
  if ((options.race === true || options.run !== undefined) && action !== "test") {
    throw new TypeError("race and run are only valid with action: \"test\".");
  }
  if (action === "version" && packages.length > 0) {
    throw new TypeError("version takes no package patterns.");
  }
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  const timeoutSeconds = options.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : positiveInteger(options.timeoutSeconds, "timeoutSeconds");

  const argv: string[] = [];
  if (action === "fmt") {
    argv.push("go", "fmt");
    argv.push(...packages);
  } else {
    argv.push("go", action);
    if (action === "test") {
      if (options.race === true) argv.push("-race");
      if (options.run !== undefined) argv.push("-run", options.run);
    }
    argv.push(...packages);
  }

  const result = await runProcess(argv, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: timeoutSeconds * 1000,
    maxOutputBytes: options.maxOutputBytes,
    maxOutputLines: options.maxOutputLines,
    signal: options.signal,
    policy: options.policy,
  });

  return {
    action,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
  };
}
