import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface ReadOptions {
  path: string;
  /**
   * Optional expected SHA-256 hash. When supplied, a mismatch is reported as an
   * error rather than returning unchecked content. When omitted, the file is
   * read unconditionally and its hash is returned with the content so the
   * caller can pass it to Edit or Write.
   */
  read_hash?: string;
}

export interface ReadResult {
  content: string;
  read_hash: string;
  /** Present only when the read failed (e.g. missing file or hash mismatch). */
  error?: unknown;
}

/**
 * Reads a UTF-8 file and returns its content alongside the SHA-256 hash of the
 * bytes read. The returned `read_hash` is what callers must supply to Edit or
 * Write to prove the file is unchanged since this read.
 *
 * If a caller-supplied `read_hash` is provided, it is validated against the
 * actual content: a mismatch is returned as an `error` instead of unchecked
 * content.
 */
export async function Read({ path, read_hash }: ReadOptions): Promise<ReadResult> {
  try {
    const bytes = await readFile(path);
    const actualHash = createHash("sha256").update(bytes).digest("hex");

    if (typeof read_hash === "string" && read_hash.trim() !== "") {
      const expectedHash = read_hash.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
        return { content: "", read_hash: actualHash, error: "File has changed since it was read; refusing to return unchecked content." };
      }
    }

    return {
      content: bytes.toString("utf8"),
      read_hash: actualHash,
    };
  } catch (err) {
    return {
      content: "",
      read_hash: "",
      error: JSON.stringify(err),
    };
  }
}

export default Read;
