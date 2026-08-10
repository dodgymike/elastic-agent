import { readdir } from "node:fs/promises";

export default interface ListDirectoryOptions { directory: string; }
export default interface ListDirectoryResponse { name: string; parentPath: string; path: string; }

/** Lists a directory after validating the caller-provided filesystem path. */
export default async function listDirectory(options: ListDirectoryOptions): Promise<ListDirectoryResponse[]> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("ListDirectory options must be an object.");
  const directory = validateFilesystemPath(options.directory, "directory");
  const readResults = await readdir(directory, { withFileTypes: true });
  return readResults.map((dirent) => ({ name: dirent.name, parentPath: directory, path: `${directory}/${dirent.name}` }));
}

export function validateFilesystemPath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string.`);
  if (value.includes("\0")) throw new TypeError(`${field} cannot contain NUL characters.`);
  return value;
}
