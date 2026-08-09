import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";

export default interface ListDirectoryOptions {
    directory: string;
}

/** Lists a directory. Each returned entry may be either a file or a directory. */
export default async function listDirectory({ directory }: ListDirectoryOptions): Promise<Dirent[]> {
  console.log(`Listing directory: ${JSON.stringify(directory)}`);
  return readdir(directory, { withFileTypes: true });
}
