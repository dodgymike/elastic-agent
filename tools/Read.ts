import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface ReadOptions {
  path: string;
  /**
   * Size of the file in bytes. Callers must obtain this from the FileSize
   * tool before calling Read; Read refuses a mismatched or stale value.
   */
  file_size: number;
  /**
   * Maximum number of bytes to return in this page. Must be a positive
   * integer. The returned content may be slightly larger when the requested
   * window cuts through a multi-byte UTF-8 character because boundaries are
   * snapped outward to keep complete code points.
   */
  read_length: number;
  /** Zero-based byte offset at which to start reading. */
  read_offset: number;
  /**
   * Optional inclusive 1-based line range such as "100-200" (or "100" for a
   * single line). When supplied, Read returns only those lines instead of the
   * byte window. `file_size` must still match the current file size. When byte
   * window parameters are also supplied, they are validated and must cover the
   * requested lines.
   */
  line_range?: string;
  /**
   * Optional expected SHA-256 hash. When supplied, a mismatch is reported as
   * an error rather than returning unchecked content. The hash is always the
   * hash of the complete file, so it can be passed to Edit or Write even when
   * only a page was read.
   */
  read_hash?: string;
}

export interface ReadResult {
  /** The requested byte window of the file, decoded as UTF-8. */
  content: string;
  /** SHA-256 hash of the complete file bytes (not just the returned page). */
  read_hash: string;
  /** Present only when the read failed (e.g. missing file or hash mismatch). */
  error?: unknown;
}

/** Read refuses to read any file larger than this many bytes (500k). */
const MAX_READ_BYTES = 500_000;

function errorResult(message: string): ReadResult {
  return { content: "", read_hash: "", error: message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

type LineRangeParseResult = { start: number; end: number } | { error: string };

/**
 * Parses an inclusive 1-based line range such as "100-200" or a single line
 * such as "100". The format and ordering are validated here; the end bound is
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
 * Computes the byte offset of each line start in a UTF-8 buffer. The returned
 * `count` is the number of content lines, excluding the trailing empty line
 * that results when the file ends with a newline.
 */
function lineByteOffsets(bytes: Buffer): { starts: number[]; count: number } {
  const starts: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) starts.push(i + 1);
  }
  const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
  const count = bytes.length === 0 ? 0 : endsWithNewline ? starts.length - 1 : starts.length;
  return { starts, count };
}

/**
 * Reads a UTF-8 file and returns text alongside the SHA-256 hash of the
 * complete file bytes. The returned `read_hash` is what callers must supply to
 * Edit or Write to prove the file is unchanged since this read.
 *
 * `file_size` must be obtained from the FileSize tool first and must match the
 * current file size. Callers select content either with the byte window
 * described by `read_offset` and `read_length`, or with an optional
 * `line_range` such as "100-200". Byte-window boundaries are snapped outward
 * only when needed to avoid splitting a multi-byte UTF-8 character; line-range
 * reads return exactly the requested lines and still return the full-file
 * hash.
 */
export async function Read({ path, file_size, read_length, read_offset, line_range, read_hash }: ReadOptions): Promise<ReadResult> {
  if (!isNonEmptyString(path)) return errorResult("path must be a non-empty string.");
  if (path.includes("\0")) return errorResult("path cannot contain NUL characters.");

  const size = toInteger(file_size);
  if (size === null || size < 0) {
    return errorResult("file_size must be a non-negative integer. Call FileSize first to obtain it.");
  }
  if (size > MAX_READ_BYTES) {
    return errorResult(
      `Read refuses to read this file because it is too large: ${size} bytes. ` +
        `Read can only read files up to ${MAX_READ_BYTES} bytes (500k).`,
    );
  }

  let lineRangeText: string | undefined;
  if (line_range !== undefined) {
    if (typeof line_range !== "string") {
      return errorResult("line_range must be a string such as '100-200'.");
    }
    if (line_range.trim() === "") {
      return errorResult("line_range must be a non-empty string such as '100-200'.");
    }
    lineRangeText = line_range;
  }
  const hasLineRange = lineRangeText !== undefined;
  const parsedLineRange = hasLineRange ? parseLineRange(lineRangeText as string) : null;
  if (parsedLineRange !== null && "error" in parsedLineRange) {
    return errorResult(parsedLineRange.error);
  }
  const lineRange = parsedLineRange as { start: number; end: number } | null;

  const length = toInteger(read_length);
  const offset = toInteger(read_offset);
  const lengthProvided = read_length !== undefined;
  const offsetProvided = read_offset !== undefined;

  if (hasLineRange) {
    if (lengthProvided && (length === null || length <= 0)) {
      return errorResult("read_length must be a positive integer byte count.");
    }
    if (offsetProvided && (offset === null || offset < 0)) {
      return errorResult("read_offset must be a non-negative integer byte offset.");
    }
    if (lengthProvided !== offsetProvided) {
      return errorResult(
        "read_offset and read_length must be supplied together. When using line_range, " +
          "pass read_offset 0 and read_length equal to file_size, or omit both.",
      );
    }
  } else {
    if (length === null || length <= 0) {
      return errorResult("read_length must be a positive integer byte count.");
    }
    if (offset === null || offset < 0) {
      return errorResult("read_offset must be a non-negative integer byte offset.");
    }
  }

  let bytes: Buffer;
  let actualSize: number;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return errorResult(`Path is not a regular file: ${path}`);
    actualSize = stats.size;
    if (actualSize > MAX_READ_BYTES) {
      return errorResult(
        `Read refuses to read this file because it is too large: ${actualSize} bytes. ` +
          `Read can only read files up to ${MAX_READ_BYTES} bytes (500k).`,
      );
    }
    if (actualSize !== size) {
      return errorResult(
        `file_size ${size} does not match the actual file size ${actualSize}. Call FileSize to obtain the current size.`,
      );
    }
    if (offset !== null && offset > actualSize) {
      return errorResult(`read_offset ${offset} is beyond the end of the file (${actualSize} bytes).`);
    }
    bytes = await readFile(path);
  } catch (err) {
    return { content: "", read_hash: "", error: JSON.stringify(err) };
  }

  const actualHash = createHash("sha256").update(bytes).digest("hex");

  if (typeof read_hash === "string" && read_hash.trim() !== "") {
    const expectedHash = read_hash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
      return { content: "", read_hash: actualHash, error: "File has changed since it was read; refusing to return unchecked content." };
    }
  }

  if (hasLineRange && lineRange !== null) {
    const { start, end } = lineRange;
    const text = bytes.toString("utf8");
    const rawLines = text.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
    const totalLineCount = text.length === 0 ? 0 : rawLines.length;

    if (end > totalLineCount) {
      return errorResult(
        totalLineCount === 0
          ? `line_range ${start}-${end} is invalid because the file has no lines.`
          : `line_range end ${end} exceeds the total line count ${totalLineCount}.`,
      );
    }

    if (lengthProvided && offsetProvided && length !== null && offset !== null) {
      const { starts } = lineByteOffsets(bytes);
      const requestedStartByte = starts[start - 1];
      const requestedEndByte = end < totalLineCount ? starts[end] : bytes.length;
      const windowStart = offset;
      const windowEnd = Math.min(offset + length, bytes.length);
      if (windowStart > requestedStartByte || windowEnd < requestedEndByte) {
        return errorResult(
          `line_range ${start}-${end} covers bytes ${requestedStartByte}-${requestedEndByte}, ` +
            `which is not fully contained within the requested byte window read_offset=${offset} ` +
            `read_length=${length} (bytes ${windowStart}-${windowEnd}). ` +
            `Pass read_offset 0 and read_length ${bytes.length} to use line_range, or omit line_range.`,
        );
      }
    }

    return {
      content: rawLines.slice(start - 1, end).join("\n"),
      read_hash: actualHash,
    };
  }

  // Snap the byte window outward to complete UTF-8 code points when the
  // requested boundaries cut through one. This avoids replacement characters
  // and prevents pages from losing characters at their edges.
  const byteWindowOffset = offset as number;
  const byteWindowLength = length as number;
  let start = byteWindowOffset;
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;

  let end = Math.min(byteWindowOffset + byteWindowLength, bytes.length);
  if (end < bytes.length) {
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
    const sequenceLength = utf8SequenceLength(bytes[end]);
    if (end + sequenceLength > bytes.length) {
      end = bytes.length;
    } else if (sequenceLength > 1) {
      end += sequenceLength;
    }
  }

  return {
    content: bytes.subarray(start, end).toString("utf8"),
    read_hash: actualHash,
  };
}

export default Read;
