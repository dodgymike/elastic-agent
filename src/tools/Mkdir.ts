import { mkdir } from "node:fs/promises";

export interface MkdirOptions {
  /** Filesystem path of the directory to create. */
  path: string;
  /** When true, create any missing parent directories as well. Defaults to false. */
  recursive?: boolean;
}

export interface MkdirResult {
  created: true;
  path: string;
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

/**
 * Create a directory at `path`. When `recursive` is true, missing parent
 * directories are created as needed (mirroring `mkdir -p`); otherwise creating
 * a directory whose parent does not exist rejects. Existing directories are
 * accepted as a no-op in both modes, consistent with Node's `mkdir` semantics.
 *
 * Failures (permission errors, a non-directory parent, an invalid path) reject
 * with an actionable tool error carrying the original filesystem cause.
 */
export default async function Mkdir({ path, recursive }: MkdirOptions): Promise<MkdirResult> {
  const target = validatePath(path, "path");
  const parents = recursive === true;
  try {
    await mkdir(target, { recursive: parents });
  } catch (error) {
    throw new Error(
      `Mkdir could not create directory '${target}'${parents ? " (with parents)" : ""}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  return { created: true, path: target };
}
