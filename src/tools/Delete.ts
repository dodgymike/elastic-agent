import { createHash, timingSafeEqual } from "node:crypto";
import { stat, unlink } from "node:fs/promises";

export interface DeleteOptions {
  /** Filesystem path of the file to delete. */
  path: string;
  /** SHA-256 of the file's current bytes, encoded as 64 lowercase hex chars. */
  file_hash: string;
  /** Exact size of the file in bytes. */
  file_size: number;
}

export interface DeleteResult {
  deleted: true;
  path: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Deletes a file only after verifying that the file at `path` currently has
 * exactly the caller-supplied SHA-256 `file_hash` and `file_size`. The double
 * check (hash AND size) ensures the file being removed is the same content the
 * caller was looking at; if either value is missing, malformed, or mismatched
 * the tool aborts and leaves the file untouched.
 */
export default async function Delete({ path, file_hash, file_size }: DeleteOptions): Promise<DeleteResult> {
  if (typeof path !== "string" || path.trim() === "") {
    throw new TypeError("path is required and must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new TypeError("path cannot contain NUL characters");
  }

  if (typeof file_hash !== "string" || file_hash.trim() === "") {
    throw new TypeError("file_hash is required");
  }
  const expectedHash = file_hash.trim().toLowerCase();
  if (!SHA256_HEX.test(expectedHash)) {
    throw new TypeError("file_hash must be a SHA-256 hash encoded as 64 hexadecimal characters");
  }

  if (!isNonNegativeInteger(file_size)) {
    throw new TypeError("file_size is required and must be a non-negative integer (the file's size in bytes)");
  }

  // Re-stat the file so the size check happens against the current filesystem
  // state, not against whatever the caller remembers from an earlier read.
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new Error(`Refusing to delete: cannot stat '${path}' (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to delete: '${path}' is not a regular file`);
  }
  if (stats.size !== file_size) {
    throw new Error(
      `Refusing to delete: file size changed (expected ${file_size} bytes, found ${stats.size} bytes); re-read the file before deleting`,
    );
  }

  const { open } = await import("node:fs/promises");
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    throw new Error(`Refusing to delete: cannot open '${path}' (${error instanceof Error ? error.message : String(error)})`);
  }
  const currentHash = createHash("sha256");
  try {
    for await (const chunk of file.createReadStream()) {
      currentHash.update(chunk);
    }
  } finally {
    await file.close();
  }
  const currentHashHex = currentHash.digest("hex");
  const hashesMatch = timingSafeEqual(
    Buffer.from(currentHashHex, "hex"),
    Buffer.from(expectedHash, "hex"),
  );
  if (!hashesMatch) {
    throw new Error(
      "Refusing to delete: file hash changed since it was read; re-read the file before deleting",
    );
  }

  // Both guards passed: the on-disk file matches the caller's hash AND size.
  await unlink(path);
  return { deleted: true, path };
}
