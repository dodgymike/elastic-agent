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

/**
 * Reads a page of a UTF-8 file and returns its text alongside the SHA-256 hash
 * of the complete file bytes. The returned `read_hash` is what callers must
 * supply to Edit or Write to prove the file is unchanged since this read.
 *
 * `file_size` must be obtained from the FileSize tool first and must match the
 * current file size. `read_offset` and `read_length` describe a byte window;
 * boundaries are snapped outward only when needed to avoid splitting a
 * multi-byte UTF-8 character.
 */
export async function Read({ path, file_size, read_length, read_offset, read_hash }: ReadOptions): Promise<ReadResult> {
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

  const length = toInteger(read_length);
  if (length === null || length <= 0) {
    return errorResult("read_length must be a positive integer byte count.");
  }

  const offset = toInteger(read_offset);
  if (offset === null || offset < 0) {
    return errorResult("read_offset must be a non-negative integer byte offset.");
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
    if (offset > actualSize) {
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

  // Snap the byte window outward to complete UTF-8 code points when the
  // requested boundaries cut through one. This avoids replacement characters
  // and prevents pages from losing characters at their edges.
  let start = offset;
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;

  let end = Math.min(offset + length, bytes.length);
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
