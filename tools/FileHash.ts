import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface FileHashOptions {
  path: string;
  /** Digest algorithm; defaults to sha256. */
  algorithm?: string;
}

export interface FileHashResult {
  algorithm: string;
  hash: string;
  size: number;
}

const ALLOWED_ALGORITHMS = new Set(["sha1", "sha256", "sha384", "sha512"]);

function validatePath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("path must be a non-empty string.");
  }
  if (value.includes("\0")) {
    throw new TypeError("path cannot contain NUL characters.");
  }
  return value;
}

/**
 * Compute a file digest without a shell. This makes the `read_hash`
 * precondition for Edit/Write/Delete self-service instead of requiring an
 * ad-hoc node script. Read-only; the safety classifier applies the same
 * protected-path policy as Read.
 */
export default async function FileHash(options: FileHashOptions): Promise<FileHashResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("FileHash options must be an object.");
  }
  const path = validatePath(options.path);
  const algorithm = options.algorithm === undefined ? "sha256" : options.algorithm;
  if (typeof algorithm !== "string" || !ALLOWED_ALGORITHMS.has(algorithm)) {
    throw new TypeError(`algorithm must be one of: ${[...ALLOWED_ALGORITHMS].join(", ")}.`);
  }

  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new Error(`FileHash could not stat '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
  }
  if (!stats.isFile()) {
    throw new Error(`FileHash refuses: '${path}' is not a regular file.`);
  }

  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("close", resolve);
  });

  return { algorithm, hash: hash.digest("hex"), size: stats.size };
}
