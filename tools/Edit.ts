import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export interface EditOperation {
  /** Exact text that must appear in the current file content. */
  old_string: string;
  /** Replacement text for `old_string`. */
  new_string: string;
}

export interface EditOptions {
  path: string;
  /** SHA-256 hash of the version of the file the caller last read. */
  read_hash: string;
  /** A single replacement operation. */
  old_string?: string;
  new_string?: string;
  /** An ordered list of replacement operations applied in sequence. */
  edits?: EditOperation[];
  /**
   * Optional inclusive 1-based line range such as "100-200" (or "100" for a
   * single line). When supplied, Edit replaces exactly those lines with
   * `content`. Cannot be combined with old_string/new_string/edits.
   */
  line_range?: string;
  /**
   * Replacement text for line_range mode. Use an empty string to delete the
   * selected lines. Valid only together with `line_range`.
   */
  content?: string;
}

export interface EditResult {
  /** Full edited file content. */
  content: string;
  /** SHA-256 hash of the new file content (pass to your next Read/Write/Edit). */
  read_hash: string;
  /** Summary of the applied replacements. */
  applied: number;
  /**
   * Full file content before the edit, available to diff renderers. This
   * property is intentionally non-enumerable so JSON serialization for the
   * LLM does not duplicate large content; console renderers can still read it
   * directly from the result object.
   */
  previous_content?: string;
}

function isSha256Hash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value.trim().toLowerCase());
}

function hashesEqual(actualHex: string, expectedHex: string): boolean {
  const a = Buffer.from(actualHex, "hex");
  const b = Buffer.from(expectedHex.trim().toLowerCase(), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type LineRangeParseResult = { start: number; end: number } | { error: string };

/**
 * Parses an inclusive 1-based line range such as "100-200" or a single line
 * such as "100". Format and ordering are validated here; the end bound is
 * validated against the file's total line count by the caller after the file
 * has been read.
 */
function parseLineRange(value: string): LineRangeParseResult {
  const trimmed = value.trim();
  const match = /^(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (!match) {
    return {
      error:
        `line_range must be an inclusive 1-based range such as "100-200", or a ` +
        `single line such as "100". Received: ${JSON.stringify(value)}`,
    };
  }

  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < 1) {
    return { error: "line_range start and end must be positive integers (lines are 1-based)." };
  }
  if (start > end) {
    return { error: `line_range start (${start}) must be less than or equal to end (${end}).` };
  }
  return { start, end };
}

/**
 * Splits file content into content lines, excluding the trailing empty line
 * that results when the file ends with a newline. An empty file has no lines.
 */
function splitFileLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Splits replacement content for line_range mode using the same convention as
 * splitFileLines: a single trailing newline is treated as a line terminator
 * rather than as an extra blank line.
 */
function splitReplacementLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Replaces the inclusive 1-based line range [start, end] with the provided
 * content. Surrounding lines and the file's final-newline style are preserved;
 * the replacement content is inserted as one or more lines.
 */
function replaceLineRange(text: string, range: { start: number; end: number }, content: string): string {
  const originalLines = splitFileLines(text);
  const before = originalLines.slice(0, range.start - 1);
  const after = originalLines.slice(range.end);
  const inserted = splitReplacementLines(content);
  const newLines = before.concat(inserted, after);
  let newText = newLines.join("\n");
  if (text.endsWith("\n") && newLines.length > 0) newText += "\n";
  return newText;
}

function normalizeOperations(options: EditOptions): EditOperation[] {
  const edits: EditOperation[] = [];
  if (options.edits !== undefined) {
    if (!Array.isArray(options.edits)) throw new TypeError("edits must be an array of { old_string, new_string } operations.");
    edits.push(...options.edits);
  }
  if (options.old_string !== undefined || options.new_string !== undefined) {
    if (typeof options.old_string !== "string" || typeof options.new_string !== "string") {
      throw new TypeError("old_string and new_string must both be provided for a single replacement.");
    }
    edits.push({ old_string: options.old_string, new_string: options.new_string });
  }
  // Reject empty edit lists (an edit call with nothing to change is a bug).
  if (edits.length === 0) throw new TypeError("Edit requires at least one { old_string, new_string } replacement or an edits array.");
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || typeof edit.old_string !== "string" || typeof edit.new_string !== "string") {
      throw new TypeError("Each edit must be an object with string old_string and new_string fields.");
    }
    if (edit.old_string.length === 0) throw new TypeError("old_string must not be empty.");
  }
  return edits;
}

/**
 * Edits a UTF-8 file only when its current SHA-256 hash matches `read_hash`,
 * guaranteeing the file has not changed since the caller last read it.
 *
 * Two mutually exclusive modes are supported:
 * - String replacement: `old_string`/`new_string` or an ordered `edits` array.
 *   Each `old_string` must appear exactly once; ambiguity is rejected so a
 *   stale or unexpected content change cannot silently corrupt the file.
 * - Line-range replacement: `line_range` plus `content` replaces exactly the
 *   requested inclusive 1-based lines.
 *
 * On success the new file content and its SHA-256 hash are returned (and
 * persisted atomically). The pre-edit content is attached as a non-enumerable
 * `previous_content` property for diff renderers without being duplicated into
 * JSON-serialized LLM tool results.
 */
export default async function Edit(options: EditOptions): Promise<EditResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Edit options must be an object.");
  if (typeof options.path !== "string" || options.path.trim() === "") throw new TypeError("path must be a non-empty string.");
  if (typeof options.read_hash !== "string" || options.read_hash.trim() === "") throw new TypeError("read_hash is required.");
  if (!isSha256Hash(options.read_hash)) {
    throw new TypeError("read_hash must be a SHA-256 hash encoded as 64 hexadecimal characters.");
  }

  const hasLineRange = options.line_range !== undefined;
  const hasStringEdit = options.old_string !== undefined || options.new_string !== undefined || options.edits !== undefined;

  let lineRange: { start: number; end: number } | null = null;
  let operations: EditOperation[] = [];

  if (hasLineRange) {
    if (hasStringEdit) {
      throw new TypeError("line_range cannot be combined with old_string/new_string or edits; choose one edit mode.");
    }
    if (typeof options.line_range !== "string" || options.line_range.trim() === "") {
      throw new TypeError("line_range must be a non-empty string such as '100-200'.");
    }
    if (typeof options.content !== "string") {
      throw new TypeError("content must be a string when line_range is set; use an empty string to delete the selected lines.");
    }
    const parsedLineRange = parseLineRange(options.line_range);
    if ("error" in parsedLineRange) throw new TypeError(parsedLineRange.error);
    lineRange = parsedLineRange;
  } else {
    if (options.content !== undefined) {
      throw new TypeError("content is only valid together with line_range.");
    }
    operations = normalizeOperations(options);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(options.path);
  } catch (error) {
    throw new Error(`Edit could not read file '${options.path}': ${error instanceof Error ? error.message : String(error)}`);
  }

  const currentHash = createHash("sha256").update(bytes).digest("hex");
  if (!hashesEqual(currentHash, options.read_hash)) {
    throw new Error("File has changed since it was read; refusing to edit it. Re-read the file with Read to obtain its current read_hash.");
  }

  const previousContent = bytes.toString("utf8");
  let content = previousContent;
  let applied = 0;

  if (lineRange !== null) {
    const totalLineCount = splitFileLines(content).length;
    if (lineRange.end > totalLineCount) {
      throw new Error(
        totalLineCount === 0
          ? `line_range ${lineRange.start}-${lineRange.end} is invalid because the file has no lines.`
          : `line_range end ${lineRange.end} exceeds the total line count ${totalLineCount}.`,
      );
    }
    content = replaceLineRange(content, lineRange, options.content as string);
    applied = 1;
  } else {
    for (const edit of operations) {
      const occurrences = content.split(edit.old_string).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `old_string must appear exactly once in the file but was found ${occurrences} time${occurrences === 1 ? "" : "s"}; ` +
          "the file may have changed or the old_string is ambiguous. Re-read the file with Read first.",
        );
      }
      content = content.replace(edit.old_string, edit.new_string);
      applied += 1;
    }
  }

  try {
    await writeFile(options.path, content, "utf8");
  } catch (error) {
    throw new Error(`Edit could not write file '${options.path}': ${error instanceof Error ? error.message : String(error)}`);
  }

  const newHash = createHash("sha256").update(content, "utf8").digest("hex");
  const result: EditResult = { content, read_hash: newHash, applied };
  Object.defineProperty(result, "previous_content", {
    value: previousContent,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return result;
}
