import { readFile, readdir, stat } from "node:fs/promises";

export interface GrepOptions {
  /**
   * Literal text or regular expression to search for within file contents.
   * When `literal` is false (the default) the pattern is compiled as a
   * regular expression; when the pattern contains no regex metacharacters it
   * is treated as a literal substring either way.
   */
  pattern: string;
  /**
   * The file or directory to search. When `path` is a regular file, its
   * contents are searched directly (a single-file grep). When `path` is a
   * directory, its child files are searched, descending into subdirectories
   * only when `recursive` is true (the default) and within the optional
   * `maxdepth` bound.
   */
  path: string;
  /**
   * Optional basename filter. Same glob semantics as the Find tool: an exact
   * name or a pattern using `*` (any run of characters), `?` (exactly one
   * character), and `**` (any number of path segments). When omitted, every
   * regular file under `path` that is small enough to inspect is a candidate.
   * Ignored when `path` points at a single file.
   */
  name?: string;
  /**
   * When true (the default), searching a directory descends into
   * subdirectories. Set to false to inspect only the directory's direct child
   * files (like `grep` without `-r`). Ignored when `path` points at a single
   * file and when `maxdepth` already bounds recursion.
   */
  recursive?: boolean;
  /**
   * Treat `pattern` as a literal string rather than a regular expression.
   * When false, any regex metacharacters in `pattern` are interpreted; a
   * malformed regex rejects with an actionable error.
   */
  literal?: boolean;
  /**
   * Maximum depth of entries matched below `path`, mirroring `find -maxdepth`
   * and the Find tool's `maxdepth`. `1` inspects only `path`'s direct
   * children, `2` adds their children, and so on. Omitted means unlimited.
   */
  maxdepth?: number;
  /**
   * When true, matching is case-insensitive (grep -i). Default: false
   * (case-sensitive).
   */
  ignoreCase?: boolean;
  /** Maximum size in bytes of a single file to inspect. Files larger than
   * this are skipped rather than loaded into memory. Default: 500k, matching
   * the Read tool's cap so huge workspace logs (for example llm.log) are never
   * read. */
  maxFileSize?: number;
  /** Maximum number of line matches to collect before stopping. Default: 1000.
   * Prevents unbounded output from extremely common patterns. */
  limit?: number;
}

export interface GrepMatch {
  /** Path of the file containing the match, as constructed from `path`. */
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matching line's text with surrounding whitespace trimmed. */
  text: string;
}

export interface GrepResult {
  /** The individual line matches, in file/line order, capped at `limit`. */
  matches: GrepMatch[];
  /** Unique file paths that contain at least one match. */
  files: string[];
  /** Total number of line matches found (may exceed `matches.length` when the
   * result is truncated by `limit`). */
  count: number;
  /** True when the result was truncated by reaching `limit`. */
  truncated: boolean;
}

/** Grep refuses to inspect files larger than this many bytes (500k), matching
 * the Read tool so a gigantic workspace log is never loaded into memory. */
const DEFAULT_MAX_FILE_SIZE = 500_000;
const DEFAULT_LIMIT = 1000;

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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Translate a glob pattern into a RegExp, mirroring the Find tool. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
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

/**
 * Root the `pattern` as either a regular expression or a literal string.
 * Returns a `RegExp` when `literal` is false; a malformed regex rejects with
 * an actionable error. When `literal` is true the pattern is escaped so only
 * exact-string matches are produced.
 */
function compilePattern(pattern: string, literal: boolean, ignoreCase: boolean): RegExp {
  const flags = ignoreCase ? "i" : "";
  if (literal) {
    return new RegExp(escapeRegExp(pattern), flags);
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(
      `Grep pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}. ` +
        "Pass literal: true to search for exact text, or fix the pattern.",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `entryType` satisfies the optional `type` filter (Grep only ever
 * inspects regular files). */
function isRegularFile(entry: { isFile(): boolean; isDirectory(): boolean }): boolean {
  return entry.isFile();
}

interface WalkContext {
  pattern: RegExp;
  nameFilter?: RegExp;
  maxdepth?: number;
  /** When false, a directory search inspects only direct child files and does
   * not descend into subdirectories (like `grep` without `-r`). */
  recursive: boolean;
  maxFileSize: number;
  limit: number;
  matches: GrepMatch[];
  fileSet: Set<string>;
  truncated: boolean;
}

async function inspectFile(filePath: string, ctx: WalkContext): Promise<void> {
  if (ctx.truncated) return;
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return; // unreadable/vanished file: skip silently during a content search
  }
  if (!stats.isFile() || stats.size > ctx.maxFileSize) return;

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return; // binary or unreadable: skip
  }

  // Guard against a data.json file that somehow exists under the search path:
  // its contents are never a valid searchable target.
  const basename = filePath.split("/").pop() ?? "";
  if (basename === "data.json") return;

  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!ctx.pattern.test(lines[index])) continue;
    ctx.matches.push({
      path: filePath,
      line: index + 1,
      text: lines[index].trim(),
    });
    ctx.fileSet.add(filePath);
    if (ctx.matches.length >= ctx.limit) {
      ctx.truncated = true;
      return;
    }
  }
}

async function walk(directory: string, depth: number, ctx: WalkContext): Promise<void> {
  if (ctx.truncated) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Grep could not read '${directory}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  for (const entry of entries) {
    if (ctx.truncated) return;
    const childPath = `${directory}/${entry.name}`;
    const entryDepth = depth + 1;
    if (ctx.maxdepth === undefined || entryDepth <= ctx.maxdepth) {
      if (isRegularFile(entry) && (ctx.nameFilter === undefined || ctx.nameFilter.test(entry.name))) {
        await inspectFile(childPath, ctx);
      } else if (
        entry.isDirectory() &&
        ctx.recursive &&
        (ctx.maxdepth === undefined || entryDepth < ctx.maxdepth)
      ) {
        await walk(childPath, entryDepth, ctx);
      }
    }
  }
}

/**
 * Search a single file or a directory for regular files whose contents match
 * `pattern`, returning `path:line:text` matches in file/line order.
 *
 * When `path` is a regular file, that file's contents are searched directly
 * (a single-file grep). When `path` is a directory, its child files are
 * searched and, when `recursive` is true (the default), subdirectories are
 * descended into up to the optional `maxdepth` bound.
 *
 * The tool is strictly read-only: it never creates, modifies, or removes
 * anything, and it never writes to the filesystem. It refuses to inspect files
 * larger than `maxFileSize` (default 500k, matching the Read tool) and caps the
 * returned matches at `limit` (default 1000). A `path` that is missing or
 * unreadable rejects with an actionable error carrying the original filesystem
 * cause; individual unreadable files encountered during the search are skipped
 * rather than aborting the whole search.
 */
export default async function Grep({
  pattern,
  path,
  name,
  recursive,
  literal,
  maxdepth,
  ignoreCase,
  maxFileSize,
  limit,
}: GrepOptions): Promise<GrepResult> {
  const basePath = validatePath(path, "path");
  const patternValue = validatePath(pattern, "pattern");
  if (name !== undefined && name.trim() === "") {
    throw new TypeError("name must be a non-empty string when provided.");
  }
  if (maxdepth !== undefined && !isNonNegativeInteger(maxdepth)) {
    throw new TypeError("maxdepth must be a non-negative integer when provided.");
  }
  const maxFileBytes = maxFileSize === undefined ? DEFAULT_MAX_FILE_SIZE : maxFileSize;
  if (maxFileBytes <= 0 || !Number.isSafeInteger(maxFileBytes)) {
    throw new TypeError("maxFileSize must be a positive integer byte count.");
  }
  const maxResults = limit === undefined ? DEFAULT_LIMIT : limit;
  if (!isPositiveInteger(maxResults)) {
    throw new TypeError("limit must be a positive integer.");
  }

  const regex = compilePattern(patternValue, literal === true, ignoreCase === true);

  let baseStats;
  try {
    baseStats = await stat(basePath);
  } catch (error) {
    throw new Error(
      `Grep could not stat base path '${basePath}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  const ctx: WalkContext = {
    pattern: regex,
    nameFilter: name !== undefined ? globToRegExp(name) : undefined,
    maxdepth,
    // Recursion is the default for directory searches; `recursive: false`
    // limits the search to a directory's direct child files.
    recursive: recursive !== false,
    maxFileSize: maxFileBytes,
    limit: maxResults,
    matches: [],
    fileSet: new Set<string>(),
    truncated: false,
  };

  if (baseStats.isFile()) {
    // Single-file grep: inspect just this file (still respecting the size cap,
    // `name` is ignored, and the data.json guard). A missing file was already
    // rejected by `stat` above.
    await inspectFile(basePath, ctx);
  } else if (baseStats.isDirectory()) {
    await walk(basePath, 0, ctx);
  } else {
    // Not a file or directory (e.g. a socket, device, or symlink target).
    throw new Error(`Grep base path '${basePath}' is neither a file nor a directory.`);
  }

  return {
    matches: ctx.matches,
    files: Array.from(ctx.fileSet),
    count: ctx.matches.length,
    truncated: ctx.truncated,
  };
}

/**
 * The input schema the Grep tool advertises to the model. This is the single
 * source of truth that main.ts wires into the native tool definition.
 */
export const GrepParameters: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Literal text or regular expression to search for within file contents." },
    path: { type: "string", description: "File or directory to search. A single file is grepped directly; a directory's child files are searched, descending when recursive is true." },
    name: { type: "string", description: "Optional basename glob: * (any run), ? (one char), or an exact name. Ignored for a single-file path." },
    recursive: { type: "boolean", description: "When true (default), a directory search descends into subdirectories; false inspects only direct child files. Ignored for a single-file path." },
    literal: { type: "boolean", description: "Treat pattern as a literal string instead of a regular expression (default false)." },
    maxdepth: { type: "number", description: "Optional maximum recursion depth below path (1 inspects only path's direct children)." },
    ignoreCase: { type: "boolean", description: "When true, matching is case-insensitive (default false)." },
    maxFileSize: { type: "number", description: "Maximum size in bytes of a single file to inspect; larger files are skipped (default 500000)." },
    limit: { type: "number", description: "Maximum number of line matches to collect before stopping (default 1000)." },
  },
  required: ["pattern", "path"],
};
