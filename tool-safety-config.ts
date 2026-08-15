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
 *
 * The parsed commander options are resolved once at startup into an immutable
 * `ToolSafetyConfig`. Directory flags are normalized to absolute paths and
 * validated so that later classifier policy (for example boundary checks for
 * edit-capable tools) can trust the values without re-validating them. The
 * resolution helpers are pure (no I/O beyond `fs.statSync`) and dependency-free
 * so they can be unit tested without booting the agent loop.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
}

/** Parsed commander option subset consumed by `resolveToolSafetyConfig`. */
export interface RawToolSafetyOptions {
  readonly disableClassifier?: boolean;
  readonly agentSourceDir?: string;
  readonly startDir?: string;
  readonly allowAgentSourceModifications?: boolean;
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
  return absolute;
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
): ToolSafetyConfig {
  const fallback = absoluteDirectoryPath(runtimeCwd, process.cwd());
  const agentSourceDir = resolveDirectoryOption(options.agentSourceDir, "--agent-source-dir", fallback);
  const startDir = resolveDirectoryOption(options.startDir, "--start-dir", fallback);
  return {
    enabled: options.disableClassifier !== true,
    agentSourceDir,
    startDir,
    startDirConfigured: options.startDir !== undefined,
    allowAgentSourceModifications: options.allowAgentSourceModifications === true,
  };
}
