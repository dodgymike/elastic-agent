import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, link, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface WriteOption {
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
 *
 * Concurrency semantics (TOOL-03):
 *   - New files are created atomically with exclusive creation: the content is
 *     staged to a same-directory temp file and then hard-linked into place, so
 *     a concurrent creator either wins the link or fails with EEXIST instead
 *     of both writers silently overwriting each other.
 *   - Existing files are replaced with a same-directory staged file that is
 *     renamed into place only after the current hash still matches
 *     `read_hash`, so a stale hash aborts before any replacement.
 *   - Partial writes are retried to completion (`bytesWritten` is honored).
 *   - Residual external-writer race: a process that modifies the target in
 *     place (not through this protocol) after the final pre-rename recheck but
 *     before `rename` can still be replaced. Callers that share a file across
 *     independent writers must coordinate outside this tool.
 */
const WRITE_CHUNK_SIZE = 64 * 1024; // 64 KiB per chunk

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function validateReadHash(read_hash: string): string {
    if (typeof read_hash !== "string" || read_hash.trim() === "") {
        throw new TypeError("read_hash is required");
    }
    const expectedHash = read_hash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new TypeError("read_hash must be a SHA-256 hash encoded as 64 hexadecimal characters");
    }
    return expectedHash;
}

async function currentFileHash(path: string): Promise<string> {
    const file = await open(path, "r");
    try {
        const currentContent = await file.readFile();
        return createHash("sha256").update(currentContent).digest("hex");
    } finally {
        await file.close();
    }
}

async function writeContentInChunks(file: Awaited<ReturnType<typeof open>>, content: string): Promise<void> {
    const buffer = Buffer.from(content, "utf8");
    for (let offset = 0; offset < buffer.length;) {
        const chunk = buffer.subarray(offset, offset + WRITE_CHUNK_SIZE);
        const { bytesWritten } = await file.write(chunk, 0, chunk.length, offset);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
            throw new Error("Write made no progress; refusing to continue.");
        }
        offset += bytesWritten;
    }
}

function tempPathFor(path: string): string {
    return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

async function closeQuietly(file: Awaited<ReturnType<typeof open>> | undefined): Promise<void> {
    if (!file) return;
    try { await file.close(); } catch { /* Preserve the original error. */ }
}

async function unlinkQuietly(path: string): Promise<void> {
    try { await unlink(path); } catch { /* Temp cleanup is best-effort. */ }
}

/**
 * Writes `content` to `path`, preserving existing content when `read_hash`
 * does not match, when another writer created the file first, or when staging
 * fails before the atomic replacement.
 */
export default async function Write({ path, content, overwrite, read_hash }: WriteOption): Promise<void> {
    if (typeof path !== "string" || path.trim() === "") {
        throw new TypeError("path must be a non-empty string.");
    }
    if (typeof content !== "string") {
        throw new TypeError("content must be a string.");
    }

    if (!(await fileExists(path))) {
        // Exclusive creation: stage to a temp file, then hard-link it into
        // place. link() fails with EEXIST when another writer created the
        // target first, so a concurrent create never overwrites the winner.
        const tmp = tempPathFor(path);
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
            handle = await open(tmp, "wx");
            await writeContentInChunks(handle, content);
            await handle.sync();
            await handle.close();
            handle = undefined;
            await link(tmp, path);
        } catch (error) {
            if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST") {
                throw new Error("File was created concurrently by another writer; refusing to overwrite it. Read the file again and retry with its current read_hash and overwrite=true.");
            }
            throw error;
        } finally {
            await closeQuietly(handle);
            await unlinkQuietly(tmp);
        }
        return;
    }

    if (!overwrite) {
        throw new Error("overwrite must be true");
    }
    const expectedHash = validateReadHash(read_hash);

    const currentHash = await currentFileHash(path);
    const hashesMatch = timingSafeEqual(Buffer.from(currentHash, "hex"), Buffer.from(expectedHash, "hex"));
    if (!hashesMatch) {
        throw new Error("File has changed since it was read; refusing to overwrite it");
    }

    // Stage the replacement on the same filesystem and preserve the existing
    // permission mode. The rename replaces the directory entry atomically and
    // only after a final hash recheck narrows the stale-hash window.
    const existingMode = (await stat(path)).mode & 0o777;
    const tmp = tempPathFor(path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(tmp, "wx", existingMode);
        await writeContentInChunks(handle, content);
        await handle.sync();
        await handle.close();
        handle = undefined;

        const beforeRenameHash = await currentFileHash(path);
        if (beforeRenameHash !== expectedHash) {
            throw new Error("File changed while the replacement was being staged; refusing to overwrite it");
        }
        await rename(tmp, path);
    } finally {
        await closeQuietly(handle);
        await unlinkQuietly(tmp);
    }
}
