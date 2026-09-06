import { realpath } from "node:fs/promises";

export interface GetWorkingDirectoryOptions {
  /** Resolve the symlink-free real path; defaults to true. */
  resolve?: boolean;
}

export interface GetWorkingDirectoryResult {
  cwd: string;
  realCwd: string;
}

/**
 * Return the current working directory and its symlink-resolved real path.
 * This replaces the common `pwd` shell call with a typed, read-only tool.
 */
export default async function GetWorkingDirectory(options: GetWorkingDirectoryOptions = {}): Promise<GetWorkingDirectoryResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("GetWorkingDirectory options must be an object.");
  }
  if (options.resolve !== undefined && typeof options.resolve !== "boolean") {
    throw new TypeError("resolve must be a boolean when provided.");
  }
  const cwd = process.cwd();
  if (options.resolve === false) return { cwd, realCwd: cwd };
  try {
    return { cwd, realCwd: await realpath(cwd) };
  } catch (error) {
    throw new Error(`GetWorkingDirectory could not resolve the real path of '${cwd}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
  }
}
