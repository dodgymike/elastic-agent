import { readdir, rmdir, stat } from "node:fs/promises";

export interface RmdirOptions {
  /** Filesystem path of the directory to remove. */
  path: string;
  /**
   * When true, remove the directory tree (including non-empty directories and
   * their contents). Defaults to false, in which case only an *empty* directory
   * can be removed and a non-empty one rejects as a safety guard.
   */
  recursive?: boolean;
}

export interface RmdirResult {
  removed: true;
  path: string;
  /** Number of entries removed when `recursive` removed a tree; undefined for a plain empty-dir removal. */
  entriesRemoved?: number;
}

/** Validate a caller-provided filesystem path, rejecting blank and NUL-padded input. */
function validatePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${field} cannot contain NUL characters.`);
  }
  return value;
}

/** Depth-first count of the entries under `directory`, used to report recursion scope. */
async function countEntries(directory: string): Promise<number> {
  let count = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return count;
  }
  for (const entry of entries) {
    count += 1;
    if (entry.isDirectory()) {
      count += await countEntries(`${directory}/${entry.name}`);
    }
  }
  return count;
}

/**
 * Remove a directory at `path`.
 *
 * Without `recursive`, only an empty directory is removed (Node's `rmdir`); a
 * non-empty directory rejects with an actionable error telling the caller to
 * pass `recursive: true` explicitly, so no contents are ever deleted by
 * accident. With `recursive: true` the directory tree (and its contents) is
 * removed.
 *
 * The directory must exist and be a directory (not a regular file); removing a
 * regular file is the Delete tool's responsibility. Failures reject with an
 * actionable tool error carrying the original filesystem cause.
 */
export default async function Rmdir({ path, recursive }: RmdirOptions): Promise<RmdirResult> {
  const target = validatePath(path, "path");
  const recurse = recursive === true;

  let stats;
  try {
    stats = await stat(target);
  } catch (error) {
    throw new Error(
      `Rmdir could not stat '${target}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`Rmdir refuses: '${target}' is not a directory (use Delete for regular files).`);
  }

  if (!recurse) {
    try {
      await rmdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        throw new Error(
          `Rmdir refuses: '${target}' is not empty; pass recursive:true to remove the directory tree and its contents.`,
          { cause: error instanceof Error ? error : undefined },
        );
      }
      throw new Error(
        `Rmdir could not remove '${target}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    return { removed: true, path: target };
  }

  // Recursive removal: use Node's rm with recursive+force so the whole tree is
  // removed, and report how many entries were removed.
  const entriesRemoved = await countEntries(target);
  const { rm } = await import("node:fs/promises");
  try {
    await rm(target, { recursive: true, force: false });
  } catch (error) {
    throw new Error(
      `Rmdir could not remove directory tree '${target}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  return { removed: true, path: target, entriesRemoved };
}
