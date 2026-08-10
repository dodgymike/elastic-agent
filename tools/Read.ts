import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface ReadOptions {
  path: string;
  /** SHA-256 hash of the version of the file the caller expects to read. */
  read_hash: string;
}

export interface ReadResult {
  content: string;
  read_hash: string;
}

/**
 * Reads a UTF-8 file only when its contents match the caller's expected hash.
 *
 * The hash is calculated from the same bytes returned to the caller, so a
 * change between a separate check and read cannot result in unchecked content.
 */
export async function Read({ path }: ReadOptions): Promise<ReadResult> {
  try {
    const bytes = await readFile(path);
    const actualHash = createHash("sha256").update(bytes).digest("hex");

    return {
      content: bytes.toString("utf8"),
      read_hash: actualHash,
    };
  } catch (err) {
    return {
      error: JSON.stringify(err),
    };
  }
}

export default Read;
