import { readFile } from "node:fs/promises";
import { runProcess } from "./process-runner.js";
import type { ShellPolicy } from "./shell-policy.js";

export interface RunPackageScriptOptions {
  /** Name of the script declared in `package.json#scripts`; must match exactly. */
  script: string;
  /** Optional positional arguments appended after `--`. */
  args?: readonly string[];
  /** Directory containing package.json; defaults to the workspace root. */
  cwd?: string;
  /** Process deadline in seconds; default 120. */
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
  /** Optional `KEY=value` environment overrides. */
  env?: readonly string[];
  /** Internal runtime wiring; not part of the advertised schema. */
  signal?: AbortSignal;
  /** Internal runtime wiring; not part of the advertised schema. */
  policy?: ShellPolicy;
}

export interface RunPackageScriptResult {
  script: string;
  /** The literal argv that was run. */
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
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
  }
  return value as readonly string[];
}

/**
 * Run a script declared in `package.json` without invoking a shell. The script
 * name is validated against `package.json#scripts` before npm starts, so an
 * attacker-controlled value cannot inject npm flags or extra commands. Only
 * `npm run <script>` is ever executed; install/publish/exec/update and other
 * npm subcommands are not part of this tool.
 */
export default async function RunPackageScript(options: RunPackageScriptOptions): Promise<RunPackageScriptResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("RunPackageScript options must be an object.");
  }
  const script = validateString(options.script, "script");
  if (script.startsWith("-")) throw new TypeError("script must not start with '-'.");
  const args = validateStringArray(options.args, "args");
  const env = validateStringArray(options.env, "env");
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
  const timeoutSeconds = options.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : options.timeoutSeconds;
  if (typeof timeoutSeconds !== "number" || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new TypeError("timeoutSeconds must be a positive integer.");
  }

  const cwd = options.cwd ?? process.cwd();
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(`${cwd}/package.json`, "utf8"));
  } catch (error) {
    throw new Error(`RunPackageScript could not read package.json in '${cwd}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError(`package.json in '${cwd}' does not contain a JSON object.`);
  }
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new TypeError(`package.json in '${cwd}' has no scripts object.`);
  }
  if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
    throw new TypeError(`RunPackageScript refuses: '${script}' is not a declared script in package.json#scripts.`);
  }

  const command = ["npm", "run", script];
  if (args.length > 0) command.push("--", ...args);
  const result = await runProcess(command, {
    cwd,
    timeoutMs: timeoutSeconds * 1000,
    maxOutputBytes: options.maxOutputBytes,
    maxOutputLines: options.maxOutputLines,
    env,
    signal: options.signal,
    policy: options.policy,
  });

  return {
    script,
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
  };
}
