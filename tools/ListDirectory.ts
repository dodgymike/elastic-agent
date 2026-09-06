import { readdir, realpath } from "node:fs/promises";

export interface ListDirectoryOptions { directory: string; }

export type ListDirectoryEntryType = "file" | "directory" | "symlink" | "other";

export interface ListDirectoryEntry {
  name: string;
  path: string;
  type: ListDirectoryEntryType;
}

export interface ListDirectoryResponse {
  /** The directory that was listed, as supplied after validation. */
  directory: string;
  /** Symlink-resolved real path of the listed directory. */
  realDirectory: string;
  entries: ListDirectoryEntry[];
}

/** Lists a directory after validating the caller-provided filesystem path. */
export default async function listDirectory(options: ListDirectoryOptions): Promise<ListDirectoryResponse> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("ListDirectory options must be an object.");
  const directory = validateFilesystemPath(options.directory, "directory");
  const realDirectory = await realpath(directory);
  const readResults = await readdir(directory, { withFileTypes: true });
  const entries = readResults.map((dirent) => {
    let type: ListDirectoryEntryType = "other";
    if (dirent.isDirectory()) type = "directory";
    else if (dirent.isFile()) type = "file";
    else if (dirent.isSymbolicLink()) type = "symlink";
    return { name: dirent.name, path: `${directory}/${dirent.name}`, type };
  });
  return { directory, realDirectory, entries };
}

export function validateFilesystemPath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string.`);
  if (value.includes("\0")) throw new TypeError(`${field} cannot contain NUL characters.`);
  return value;
}
