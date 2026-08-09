import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";

export default interface ListDirectoryOptions {
    directory: string;
}

export default interface ListDirectoryResponse {
  name: string;
  parentPath: string;
  path: string;
}
/** Lists a directory. Each returned entry may be either a file or a directory. */
export default async function listDirectory({ directory }: ListDirectoryOptions): Promise<ListDirectoryResponse[]> {
  console.log(`Listing directory: ${JSON.stringify(directory)}`);
  
  const readResults = await readdir(directory, { withFileTypes: true });

  console.log(`Read results: ${JSON.stringify(readResults)}`);

  return readResults.map((dirent) => ({
    name: dirent.name,
    parentPath: directory,
    path: `${directory}/${dirent.name}`,
  }));
}
