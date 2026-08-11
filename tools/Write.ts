import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";


import { access } from "node:fs/promises";
import { constants } from "node:fs";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export default interface WriteOption {
    path: string;
    content: string;
    overwrite: boolean;
    read_hash: string;
}

/**
 * File Writing Strategy: never write large files in one call; chunk into
 * smaller pieces. The full UTF-8 byte encoding is produced once, then written
 * to the open file descriptor in fixed-size chunks at increasing offsets so no
 * single write buffers an unbounded region and multi-byte sequences stay
 * contiguous across chunk boundaries.
 */
const WRITE_CHUNK_SIZE = 64 * 1024; // 64 KiB per chunk

async function writeContentInChunks(file: Awaited<ReturnType<typeof open>>, content: string): Promise<void> {
    const buffer = Buffer.from(content, "utf8");
    await file.truncate(0);
    for (let offset = 0; offset < buffer.length; offset += WRITE_CHUNK_SIZE) {
        const chunk = buffer.subarray(offset, offset + WRITE_CHUNK_SIZE);
        await file.write(chunk, 0, chunk.length, offset);
    }
}

/**  * Overwrites a file only when its current SHA-256 hash matches `read_hash`.  */
export default async function Write({ path, content, overwrite, read_hash, }: WriteOption): Promise<void> {
    try {
        // Usage
        if (await fileExists(path)) {
            if (!overwrite) {
                throw new Error("overwrite must be true");
            } 

            if ((typeof read_hash !== "string" || read_hash.trim() === "")) {
                throw new TypeError("read_hash is required");
            }

            const expectedHash = read_hash.trim().toLowerCase();
            if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
                throw new TypeError("read_hash must be a SHA-256 hash encoded as 64 hexadecimal characters");
            } 
            
            try {
                const file = await open(path, "r+");
                try {
                    const currentContent = await file.readFile();
                    const currentHash = createHash("sha256").update(currentContent).digest("hex");
                    const hashesMatch = timingSafeEqual(Buffer.from(currentHash, "hex"), Buffer.from(expectedHash, "hex"),);
                    if (!hashesMatch) {
                        throw new Error("File has changed since it was read;  refusing to overwrite it");
                    }            
                } finally {
                    if (file) {
                        await file.close();
                    }
                }
            } catch (err) {
                throw err;
            }
        }

        const file = await open(path, "w");
        try {
            if (!file) {
                throw new Error("File handle is not available");
            }

            await writeContentInChunks(file, content);
        } finally {
            if (file) {
                await file.close();
            }
        }
    } catch (err) {
        throw err;
    }
} 
