import { readdir, stat } from "node:fs/promises";

export interface FindOptions {
  /** Base directory in which to search. */
  path: string;
  /**
   * Optional basename filter. May be an exact name or a glob pattern using `*`
   * (any run of characters), `?` (exactly one character), and `**` (any number
   * of path segments). When omitted, every entry under `path` is a candidate.
   */
  name?: string;
  /** Optional entry-type filter: "file" or "directory". */
  type?: "file" | "directory";
  /**
   * Maximum depth of entries matched below `path`, mirroring `find -maxdepth`.
   * `1` matches only `path`'s direct children, `2` adds their children, and so
   * on. `0` matches nothing (the base directory itself is never a candidate).
   * Omitted means unlimited.
   */
  maxdepth?: number;
}

export interface FindEntry {
  path: string;
  type: "file" | "directory";
}

export interface FindResult {
  /** Absolute or input-relative path of each matching entry, in depth-first order. */
  matches: string[];
  count: number;
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Translate a glob pattern into a RegExp. Supports `**` (any number of path
 * segments, only as a full segment), `*` (any run of characters within a
 * segment), and `?` (exactly one character). The pattern is matched against the
 * entry's basename (a single segment) and never against a full path, so `*` and
 * `**` behave identically for basename matching.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      // `**` collapses to the same run-of-characters match as `*` for a
      // basename, so both are handled identically.
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** True when `entryType` satisfies the optional `type` filter. */
function matchesType(type: "file" | "directory" | undefined, isDirectory: boolean): boolean {
  if (type === undefined) return true;
  return type === "directory" ? isDirectory : !isDirectory;
}

interface WalkContext {
  basePath: string;
  nameFilter?: RegExp;
  type?: "file" | "directory";
  maxdepth?: number;
}

/**
 * Depth-first walk. `depth` is the depth of the *directory being scanned* below
 * the base path (base itself is depth 0), so each of its children sits at
 * `depth + 1`. An entry is matched only when its own depth satisfies the
 * `maxdepth` bound (mirroring `find -maxdepth`, where the base's direct
 * children are depth 1). Subdirectories are recursed into only when deeper
 * levels could still be matched, to avoid unbounded descent.
 */
async function walk(directory: string, depth: number, ctx: WalkContext): Promise<string[]> {
  const matches: string[] = [];

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Find could not read '${directory}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  for (const entry of entries) {
    const childPath = `${directory}/${entry.name}`;
    const isDirectory = entry.isDirectory();
    const entryDepth = depth + 1;
    if (ctx.maxdepth === undefined || entryDepth <= ctx.maxdepth) {
      if (matchesType(ctx.type, isDirectory) && (ctx.nameFilter === undefined || ctx.nameFilter.test(entry.name))) {
        matches.push(childPath);
      }
      if (isDirectory && (ctx.maxdepth === undefined || entryDepth < ctx.maxdepth)) {
        matches.push(...(await walk(childPath, entryDepth, ctx)));
      }
    }
  }
  return matches;
}

/**
 * Search `path` (a directory) for entries matching the optional `name` glob and
 * `type` filters, recursing up to `maxdepth` when provided. Returns the list of
 * matching entry paths in depth-first order.
 *
 * `path` must resolve to a directory; a missing base directory or an
 * unreadable subdirectory rejects with an actionable tool error carrying the
 * original filesystem cause.
 */
export default async function Find({ path, name, type, maxdepth }: FindOptions): Promise<FindResult> {
  const basePath = validatePath(path, "path");
  if (type !== undefined && type !== "file" && type !== "directory") {
    throw new TypeError(`type must be 'file' or 'directory' when provided.`);
  }
  if (name !== undefined && name.trim() === "") {
    throw new TypeError("name must be a non-empty string when provided.");
  }
  if (maxdepth !== undefined && !isNonNegativeInteger(maxdepth)) {
    throw new TypeError("maxdepth must be a non-negative integer when provided.");
  }

  let baseStats;
  try {
    baseStats = await stat(basePath);
  } catch (error) {
    throw new Error(
      `Find could not stat base path '${basePath}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (!baseStats.isDirectory()) {
    throw new Error(`Find base path '${basePath}' is not a directory.`);
  }

  const ctx: WalkContext = {
    basePath,
    nameFilter: name !== undefined ? globToRegExp(name) : undefined,
    type,
    maxdepth,
  };
  const matches = await walk(basePath, 0, ctx);
  return { matches, count: matches.length };
}
