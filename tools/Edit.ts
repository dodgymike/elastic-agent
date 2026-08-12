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
}

export interface EditResult {
  /** Full edited file content. */
  content: string;
  /** SHA-256 hash of the new file content (pass to your next Read/Write/Edit). */
  read_hash: string;
  /** Summary of the applied replacements. */
  applied: number;
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
 * Replacements are applied in order over the current content. Each edit's
 * `old_string` must appear exactly once; ambiguity is rejected so a stale or
 * unexpected content change cannot silently corrupt the file. On success the
 * new file content and its SHA-256 hash are returned (and persisted atomically).
 */
export default async function Edit(options: EditOptions): Promise<EditResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Edit options must be an object.");
  if (typeof options.path !== "string" || options.path.trim() === "") throw new TypeError("path must be a non-empty string.");
  if (typeof options.read_hash !== "string" || options.read_hash.trim() === "") throw new TypeError("read_hash is required.");
  if (!isSha256Hash(options.read_hash)) {
    throw new TypeError("read_hash must be a SHA-256 hash encoded as 64 hexadecimal characters.");
  }

  const operations = normalizeOperations(options);

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

  let content = bytes.toString("utf8");
  let applied = 0;
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

  try {
    await writeFile(options.path, content, "utf8");
  } catch (error) {
    throw new Error(`Edit could not write file '${options.path}': ${error instanceof Error ? error.message : String(error)}`);
  }

  const newHash = createHash("sha256").update(content, "utf8").digest("hex");
  return { content, read_hash: newHash, applied };
}
