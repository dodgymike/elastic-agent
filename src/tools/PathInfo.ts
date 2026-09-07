import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

export type PathInfoAction = "stat" | "lstat" | "realpath" | "readlink" | "which" | "type";

export interface PathInfoOptions {
  path: string;
  action?: PathInfoAction;
}

export interface PathInfoResult {
  exists: boolean;
  type?: "file" | "directory" | "symlink" | "other";
  size?: number;
  /** File mode as an octal string, for example "100644". */
  mode?: string;
  mtime?: string;
  symlinkTarget?: string;
  resolvedPath?: string;
  executable?: boolean;
}

const ACTIONS: readonly PathInfoAction[] = ["stat", "lstat", "realpath", "readlink", "which", "type"];

function validatePath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("path must be a non-empty string.");
  }
  if (value.includes("\0")) {
    throw new TypeError("path cannot contain NUL characters.");
  }
  return value;
}

function describeStats(stats: Awaited<ReturnType<typeof lstat>>): PathInfoResult {
  let type: PathInfoResult["type"] = "other";
  if (stats.isFile()) type = "file";
  else if (stats.isDirectory()) type = "directory";
  else if (stats.isSymbolicLink()) type = "symlink";
  return {
    exists: true,
    type,
    size: Number(stats.size),
    mode: stats.mode.toString(8),
    mtime: stats.mtime.toISOString(),
  };
}

function missingResult(): PathInfoResult {
  return { exists: false };
}

/**
 * Inspect filesystem metadata and resolve paths. Replaces `stat`, `readlink`,
 * `realpath`, `file`, `which`, and `ls -ld`. Read-only; the safety classifier
 * applies the same protected-path policy as Read.
 */
export default async function PathInfo(options: PathInfoOptions): Promise<PathInfoResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("PathInfo options must be an object.");
  }
  const path = validatePath(options.path);
  const action = options.action === undefined ? "stat" : options.action;
  if (!ACTIONS.includes(action)) {
    throw new TypeError(`action must be one of: ${ACTIONS.join(", ")}.`);
  }

  switch (action) {
    case "stat": {
      try {
        return describeStats(await stat(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingResult();
        throw new Error(`PathInfo could not stat '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
      }
    }
    case "lstat": {
      try {
        return describeStats(await lstat(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingResult();
        throw new Error(`PathInfo could not lstat '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
      }
    }
    case "realpath": {
      try {
        const resolvedPath = await realpath(path);
        return { exists: true, resolvedPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingResult();
        throw new Error(`PathInfo could not resolve '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
      }
    }
    case "readlink": {
      try {
        const symlinkTarget = await readlink(path);
        return { exists: true, symlinkTarget };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingResult();
        throw new Error(`PathInfo could not readlink '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
      }
    }
    case "type": {
      try {
        return describeStats(await lstat(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingResult();
        throw new Error(`PathInfo could not inspect '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
      }
    }
    case "which": {
      if (path.includes("/")) {
        try {
          const stats = await stat(path);
          return { exists: true, type: stats.isFile() ? "file" : "other", executable: stats.isFile() && (stats.mode & 0o111) !== 0, resolvedPath: path };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingResult();
          throw new Error(`PathInfo could not inspect '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
        }
      }
      const searchPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
      for (const directory of searchPath.split(":").filter(Boolean)) {
        const candidate = join(directory, path);
        try {
          const stats = await stat(candidate);
          if (stats.isFile() && (stats.mode & 0o111) !== 0) {
            return { exists: true, type: "file", executable: true, resolvedPath: candidate };
          }
        } catch {
          // Keep scanning PATH entries.
        }
      }
      return missingResult();
    }
  }
}
