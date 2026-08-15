// Unit tests for the Delete tool (tools/Delete.ts): permanent deletion that
// only proceeds when the file at path currently matches the caller-supplied
// SHA-256 file_hash AND file_size. Missing/malformed/mismatched values abort
// and leave the file untouched.
// Compiled and executed standalone by the `test:delete-tool` npm script.
import Delete from "../tools/Delete.js";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "delete-tool-test-"));
let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) { console.log(`PASS: ${name}`); }
  else { failures += 1; console.error(`FAIL: ${name}`); }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readError(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => Promise.resolve(""),
    (e) => Promise.resolve(e instanceof Error ? e.message : String(e)),
  );
}

async function main(): Promise<void> {
  try {
    // 1. Delete succeeds when both hash and size match the file on disk.
    const target = join(dir, "a.txt");
    writeFileSync(target, "delete me\n");
    const expectedHash = sha256(Buffer.from("delete me\n", "utf8"));
    const size = Buffer.byteLength("delete me\n", "utf8");
    const deleted = await Delete({ path: target, file_hash: expectedHash, file_size: size });
    check("delete with matching hash and size succeeds", deleted.deleted === true && deleted.path === target);
    check("delete file is removed", !existsSync(target));

    // 2. Missing or malformed hash aborts and leaves the file untouched.
    const b = join(dir, "b.txt");
    writeFileSync(b, "keep b\n");
    const bHash = sha256(Buffer.from("keep b\n", "utf8"));
    const bSize = Buffer.byteLength("keep b\n", "utf8");

    let missingHash = await readError(() => Delete({ path: b, file_size: bSize } as any));
    check("missing file_hash aborts", /file_hash is required/i.test(missingHash));
    check("missing-hash abort leaves the file", existsSync(b));

    let blankHash = await readError(() => Delete({ path: b, file_hash: "   ", file_size: bSize }));
    check("blank file_hash aborts", /file_hash is required/i.test(blankHash));
    check("blank-hash abort leaves the file", existsSync(b));

    let badHash = await readError(() => Delete({ path: b, file_hash: "not-a-hash", file_size: bSize }));
    check("malformed file_hash aborts", /64 hexadecimal/i.test(badHash));
    check("malformed-hash abort leaves the file", existsSync(b));

    // 3. Missing/invalid file_size aborts and leaves the file untouched.
    let missingSize = await readError(() => Delete({ path: b, file_hash: bHash } as any));
    check("missing file_size aborts", /file_size is required/i.test(missingSize));
    check("missing-size abort leaves the file", existsSync(b));

    let negSize = await readError(() => Delete({ path: b, file_hash: bHash, file_size: -1 }));
    check("negative file_size aborts", /non-negative integer/i.test(negSize));
    check("negative-size abort leaves the file", existsSync(b));

    let floatSize = await readError(() => Delete({ path: b, file_hash: bHash, file_size: 1.5 }));
    check("fractional file_size aborts", /non-negative integer/i.test(floatSize));
    check("fractional-size abort leaves the file", existsSync(b));

    // 4. Size mismatch aborts even when the hash is correct.
    let sizeMismatch = await readError(() => Delete({ path: b, file_hash: bHash, file_size: bSize + 1 }));
    check("size mismatch aborts", /file size changed/i.test(sizeMismatch));
    check("size-mismatch abort leaves the file", existsSync(b));

    // 5. Hash mismatch (same size) aborts and leaves the file untouched.
    const sameSizeHash = sha256(Buffer.from("keep b\r", "utf8")); // different bytes, same length
    let hashMismatch = await readError(() => Delete({ path: b, file_hash: sameSizeHash, file_size: bSize }));
    check("hash mismatch aborts", /file hash changed since it was read/i.test(hashMismatch));
    check("hash-mismatch abort leaves the file", existsSync(b));

    // 6. A directory is refused (only regular files may be deleted).
    const sub = join(dir, "sub");
    mkdirSync(sub);
    let dirError = await readError(() => Delete({ path: sub, file_hash: bHash, file_size: 0 }));
    check("directory is refused", /not a regular file/i.test(dirError));
    check("directory still exists after refusal", existsSync(sub));

    // 7. A nonexistent path is refused and reports it cannot be statted.
    const missing = join(dir, "does-not-exist.txt");
    let missingError = await readError(() => Delete({ path: missing, file_hash: bHash, file_size: 0 }));
    check("nonexistent path aborts", /cannot stat/i.test(missingError));

    // 8. Cleanup: verify b.txt still exists at the end (it was never deleted).
    check("b.txt survives every abort", existsSync(b) && Buffer.byteLength("keep b\n", "utf8") === bSize);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }

  if (failures === 0) { console.log("\nAll Delete tool tests passed."); process.exit(0); }
  else { console.error(`\n${failures} Delete tool test(s) failed.`); process.exit(1); }
}

main().catch((error) => {
  console.error("Delete tool test harness crashed:", error);
  process.exit(1);
});
