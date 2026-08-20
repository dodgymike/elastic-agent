/**
 * Tool-safety CLI configuration.
 *
 * This module owns the resolution and validation of the command-line flags
 * that configure the tool safety classifier:
 *
 *   --disable-classifier
 *   --agent-source-dir <dir>
 *   --start-dir <dir>
 *   --allow-agent-source-modifications
 *   --safe-dir <dir1,dir2,...>
 *
 * The parsed commander options are resolved once at startup into an immutable
 * `ToolSafetyConfig`. Directory flags are normalized to absolute paths and
 * validated so that later classifier policy (for example boundary checks for
 * edit-capable tools) can trust the values without re-validating them. The
 * resolution helpers are pure (no I/O beyond `fs.statSync`) and dependency-free
 * so they can be unit tested without booting the agent loop.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  AgentSourceRootMismatchError,
  resolveAgentSourceRoot,
} from "./tool-source-root.js";

/**
 * Resolved, validated tool-safety configuration. All directory paths are
 * absolute. The classifier is enabled unless `--disable-classifier` was set.
 */
export interface ToolSafetyConfig {
  /** True when the safety classifier should run; false bypasses classification. */
  readonly enabled: boolean;
  /** Absolute path of the agent source directory (the code the agent may edit). */
  readonly agentSourceDir: string;
  /** Absolute path of the starting directory (the runtime working directory). */
  readonly startDir: string;
  /** True when --start-dir was explicitly provided (not the runtime-cwd default). */
  readonly startDirConfigured: boolean;
  /** True when edit-capable tools are allowed to modify files under the configured directories. */
  readonly allowAgentSourceModifications: boolean;
  /**
   * Absolute paths of additional user-declared safe (editable) directories
   * from --safe-dir. `resolveToolSafetyConfig` always sets this to an array
   * (empty when the flag is absent); it is optional in the interface only so
   * callers that construct a partial config are treated as having no safe dirs.
   */
  readonly safeDirs?: readonly string[];
}

/** Parsed commander option subset consumed by `resolveToolSafetyConfig`. */
export interface RawToolSafetyOptions {
  readonly disableClassifier?: boolean;
  readonly agentSourceDir?: string;
  readonly startDir?: string;
  readonly allowAgentSourceModifications?: boolean;
  /** Comma-separated list of additional safe/editable directories. */
  readonly safeDirs?: string;
}

function absoluteDirectoryPath(candidate: string, baseCwd: string): string {
  return isAbsolute(candidate) ? resolve(candidate) : resolve(baseCwd, candidate);
}

/**
 * Resolve a user-supplied or default directory value to an absolute path and
 * validate that it exists and is a directory. Throws a clear usage error so
 * the CLI can report it and exit without starting the agent loop.
 */
function resolveDirectoryOption(value: string | undefined, flagName: string, fallback: string): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error(`Usage: ${flagName} requires a non-empty directory path.`);
  }
  const absolute = absoluteDirectoryPath(candidate.trim(), fallback);
  if (!existsSync(absolute)) {
    throw new Error(`Usage: ${flagName} '${candidate.trim()}' does not exist (resolved to '${absolute}').`);
  }
  let stats;
  try {
    stats = statSync(absolute);
  } catch (error) {
    throw new Error(
      `Usage: ${flagName} '${candidate.trim()}' cannot be accessed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`Usage: ${flagName} '${candidate.trim()}' is not a directory (resolved to '${absolute}').`);
  }
  // Canonicalize (symlink-resolve) the directory so the classifier and tool
  // working-directory logic always compare against the real location rather
  // than a lexical spelling that may alias it (for example /home -> /mnt).
  // When realpath fails (a virtual/overlay mount or a removed directory) we
  // degrade to the validated absolute path so startup still proceeds.
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    canonical = absolute;
  }
  return canonical;
}

/**
 * Resolve the comma-separated `--safe-dir` list into an array of canonical,
 * absolute, validated directory paths. Each entry is resolved and validated
 * just like a single directory flag (`resolveDirectoryOption`), so a missing
 * or non-directory entry fails at startup with a clear usage error. Empty
 * entries (for example a trailing comma or doubled separator) are skipped so
 * the flag is forgiving of simple punctuation mistakes. Returns an empty array
 * when the flag is absent.
 */
function resolveSafeDirList(value: string | undefined, flagName: string, baseCwd: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const dirs: string[] = [];
  for (const entry of entries) {
    dirs.push(resolveDirectoryOption(entry, flagName, baseCwd));
  }
  return Array.from(new Set(dirs));
}

/**
 * Resolve and validate the tool-safety CLI flags into a `ToolSafetyConfig`.
 *
 * Defaults:
 * - `startDir` defaults to the runtime working directory.
 * - `agentSourceDir` defaults to the resolved agent source directory, which is
 *   the runtime working directory containing the agent source tree.
 * - The classifier is enabled unless `disableClassifier` is true.
 * - Agent-source modifications are disallowed unless
 *   `allowAgentSourceModifications` is true.
 */
export function resolveToolSafetyConfig(
  options: RawToolSafetyOptions,
  runtimeCwd: string = process.cwd(),
  mainPath?: string,
): ToolSafetyConfig {
  const fallback = absoluteDirectoryPath(runtimeCwd, process.cwd());
  const startDirConfigured = options.startDir !== undefined;
  const allowAgentSourceModifications = options.allowAgentSourceModifications === true;
  // The --safe-dir list is resolved against the runtime working directory (the
  // same base as the other directory flags) so relative entries normalize to
  // absolute canonical paths. It is independent of the edit/modifications flags
  // and is threaded into both config branches below, including the mods root
  // branch where it adds user-declared safe directories on top of the
  // authoritative agent-source root.
  const safeDirs = resolveSafeDirList(options.safeDirs, "--safe-dir", fallback);
  // --start-dir scopes all tool work to a single directory, which is mutually
  // exclusive with allowing modifications across the agent source tree. Reject
  // the conflicting combination up front so the CLI reports a clear usage error
  // instead of running with ambiguous filesystem boundaries.
  if (startDirConfigured && allowAgentSourceModifications) {
    throw new Error(
      "Usage: --allow-agent-source-modifications and --start-dir cannot be used together.",
    );
  }
  // --allow-agent-source-modifications lets the agent rewrite its own source,
  // so the authoritative modification root is the directory containing the
  // main entry module (the agent's own main.ts), and the runtime working
  // directory must resolve to that same root. Both directories are set to the
  // canonical agent-source root so the classifier's edit boundary and the tool
  // working directory follow the user's intent. A mismatch fails startup with a
  // clear error instead of running with an ambiguous filesystem boundary.
  if (allowAgentSourceModifications) {
    if (!mainPath) {
      throw new Error(
        "Usage: --allow-agent-source-modifications requires the main entry module path to resolve the agent source root.",
      );
    }
    const sourceRoot = resolveAgentSourceRoot(mainPath, runtimeCwd);
    if (!sourceRoot.cwdMatchesRoot) {
      throw new AgentSourceRootMismatchError(sourceRoot.root, runtimeCwd);
    }
    return {
      enabled: options.disableClassifier !== true,
      agentSourceDir: sourceRoot.root,
      startDir: sourceRoot.root,
      startDirConfigured: false,
      allowAgentSourceModifications: true,
      safeDirs,
    };
  }
  const agentSourceDir = resolveDirectoryOption(options.agentSourceDir, "--agent-source-dir", fallback);
  const startDir = resolveDirectoryOption(options.startDir, "--start-dir", fallback);
  return {
    enabled: options.disableClassifier !== true,
    agentSourceDir,
    startDir,
    startDirConfigured,
    allowAgentSourceModifications,
    safeDirs,
  };
}

/**
 * Build the model-facing path warning injected into tool-executing prompts.
 *
 * When `--start-dir` was explicitly configured, model tool calls must use
 * paths that are absolute or relative to the normalized start directory. The
 * returned value is the exact warning line with a leading blank-line separator
 * so callers can append it to a prompt. When `--start-dir` was not provided
 * (the runtime-cwd default), an empty string is returned so the prompt stays
 * unchanged.
 *
 * When `isDocker` is true, a short Docker-only note is appended after the path
 * line stating that filesystem access outside the start directory is permitted
 * for the running container session. Protected files and secrets remain
 * forbidden and are governed by the classifier's filesystem policy.
 */
export function startDirPathWarning(
  config: Pick<ToolSafetyConfig, "startDir" | "startDirConfigured">,
  isDocker: boolean = false,
): string {
  if (!config.startDirConfigured) {
    return "";
  }
  const baseLine = `\n\nALL PATHS MUST BE ABSOLUTE OR RELATIVE TO ${config.startDir}.`;
  return isDocker
    ? `${baseLine}\nDocker/container detected: filesystem access outside this directory is permitted for this running container session.`
    : baseLine;
}
