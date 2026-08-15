import { stat } from "node:fs/promises";

export interface FileSizeOptions {
  path: string;
}

export interface FileSizeResult {
  size: number;
  /** Present only when the file size could not be determined. */
  error?: unknown;
}

/**
 * Returns the size of the file at `path` in bytes. The Read tool requires this
 * value as `file_size`, so callers must obtain it with FileSize before reading.
 */
export async function FileSize({ path }: FileSizeOptions): Promise<FileSizeResult> {
  if (typeof path !== "string" || path.trim() === "") {
    return { size: 0, error: "path must be a non-empty string." };
  }
  if (path.includes("\0")) {
    return { size: 0, error: "path cannot contain NUL characters." };
  }

  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      return { size: 0, error: `Path is not a regular file: ${path}` };
    }
    return { size: stats.size };
  } catch (err) {
    return { size: 0, error: JSON.stringify(err) };
  }
}

export default FileSize;
