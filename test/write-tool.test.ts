import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Write from "../tools/Write.js";

function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "elastic-write-tool-"));
    try {
        const target = join(root, "note.txt");

        // 1. New-file creation writes the exact UTF-8 content.
        await Write({ path: target, content: "héllo ☃", overwrite: false, read_hash: "0".repeat(64) });
        assert.equal(readFileSync(target, "utf8"), "héllo ☃");

        // 2. A stale hash preserves the other writer's data.
        await assert.rejects(
            Write({ path: target, content: "should not land", overwrite: true, read_hash: sha256("different") }),
            /changed since it was read/,
        );
        assert.equal(readFileSync(target, "utf8"), "héllo ☃");

        // 3. A matching hash replaces content and preserves the existing mode.
        chmodSync(target, 0o640);
        await Write({ path: target, content: "replacement", overwrite: true, read_hash: sha256("héllo ☃") });
        assert.equal(readFileSync(target, "utf8"), "replacement");
        assert.equal(statSync(target).mode & 0o777, 0o640);

        // 4. Concurrent creation: exactly one writer wins and the surviving
        //    content is the winner's whole payload (never a mix/corruption).
        const raced = join(root, "raced.txt");
        const first = Write({ path: raced, content: "A", overwrite: false, read_hash: "0".repeat(64) });
        const second = Write({ path: raced, content: "B", overwrite: false, read_hash: "0".repeat(64) });
        const results = await Promise.allSettled([first, second]);
        assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1, "exactly one concurrent creator succeeds");
        assert.equal(results.filter((entry) => entry.status === "rejected").length, 1, "exactly one concurrent creator is refused");
        const rejected = results.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
        assert.ok(rejected, "a rejected creator exists");
        assert.match(rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason), /concurrently|overwrite must be true/);
        const racedContent = readFileSync(raced, "utf8");
        assert.ok(racedContent === "A" || racedContent === "B", "surviving content is one writer's whole payload");

        // 5. Overwriting without overwrite=true is refused and preserves content.
        await assert.rejects(
            Write({ path: target, content: "nope", overwrite: false, read_hash: sha256("replacement") }),
            /overwrite must be true/,
        );
        assert.equal(readFileSync(target, "utf8"), "replacement");

        console.log("PASS write-tool: exclusive creation, stale-hash preservation, staged replacement, mode preservation, UTF-8");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
