// Unit tests for the Edit tool (tools/Edit.ts): in-place file replacement that
// only applies when the file's SHA-256 hash matches the caller-provided
// read_hash (from the last Read/Write/Edit), plus coverage for the ordered
// `edits` array and the single replacement form.
// Compiled and executed standalone by the `test:edit-tool` npm script.
import Edit from "../tools/Edit.js";
import { Read } from "../tools/Read.js";
import { FileSize } from "../tools/FileSize.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Read now requires file_size from FileSize, plus read_offset and read_length.
const readFileTool = async (path: string): Promise<{ read_hash: string; content?: string; error?: unknown }> => {
  const sizeResult = await FileSize({ path });
  if (sizeResult.error !== undefined) throw new Error(`FileSize failed: ${String(sizeResult.error)}`);
  return Read({ path, file_size: sizeResult.size, read_offset: 0, read_length: sizeResult.size }) as unknown as { read_hash: string; content?: string; error?: unknown };
};

const dir = mkdtempSync(join(tmpdir(), "edit-tool-test-"));
let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) { console.log(`PASS: ${name}`); }
  else { failures += 1; console.error(`FAIL: ${name}`); }
}

async function main(): Promise<void> {
  try {
    // 1. Single replacement with the correct read_hash succeeds and returns the
    //    new content and a fresh hash.
    const target = join(dir, "sample.txt");
    writeFileSync(target, "alpha beta gamma\n");
    const readResult = await readFileTool(target);
    assert.equal(readResult.error, undefined, "Read should succeed on the sample file");
    const editResult = await Edit({
      path: target,
      read_hash: readResult.read_hash,
      old_string: "beta",
      new_string: "BETA",
    });
    check("single replacement returns applied=1", editResult.applied === 1);
    check("single replacement applied the change to the file", readFileSync(target, "utf8") === "alpha BETA gamma\n");
    check("single replacement returns the new content", editResult.content === "alpha BETA gamma\n");
    check("single replacement returns a fresh 64-hex hash", /^[a-f0-9]{64}$/.test(editResult.read_hash));
    check("the new hash matches the new file bytes", editResult.content === readFileSync(target, "utf8"));

    // 2. Editing again with the NEW hash succeeds (chained edits).
    const edit2 = await Edit({
      path: target,
      read_hash: editResult.read_hash,
      old_string: "alpha",
      new_string: "Alpha",
    });
    check("chained edit with updated hash succeeds", edit2.applied === 1 && readFileSync(target, "utf8") === "Alpha BETA gamma\n");

    // 3. Using a STALE read_hash (the pre-edit hash) is rejected and the file
    //    is left unchanged.
    const staleHashBefore = readFileSync(target, "utf8");
    let staleError = "";
    try {
      await Edit({ path: target, read_hash: readResult.read_hash, old_string: "gamma", new_string: "GAMMA" });
    } catch (e) { staleError = e instanceof Error ? e.message : String(e); }
    check("stale read_hash is rejected", staleError.length > 0 && /changed since it was read/i.test(staleError));
    check("stale edit leaves the file unchanged", readFileSync(target, "utf8") === staleHashBefore);

    // 4. An ambiguous old_string (appears more than once) is rejected.
    writeFileSync(target, "one two one\n");
    const readAmb = await readFileTool(target);
    let ambiguousError = "";
    try {
      await Edit({ path: target, read_hash: readAmb.read_hash, old_string: "one", new_string: "ONE" });
    } catch (e) { ambiguousError = e instanceof Error ? e.message : String(e); }
    check("ambiguous old_string is rejected", ambiguousError.length > 0 && /must appear exactly once/i.test(ambiguousError));

    // 5. The ordered `edits` array applies multiple replacements in sequence.
    writeFileSync(target, "a b c\n");
    const readSeq = await readFileTool(target);
    const seqResult = await Edit({
      path: target,
      read_hash: readSeq.read_hash,
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "c", new_string: "C" },
        { old_string: "b", new_string: "B" },
      ],
    });
    check("edits array applied 3 replacements", seqResult.applied === 3);
    check("edits array produced the expected content", readFileSync(target, "utf8") === "A B C\n");

    // 6. An empty edit list or malformed read_hash is rejected.
    const readValid = await readFileTool(target);
    let emptyError = "";
    try { await Edit({ path: target, read_hash: readValid.read_hash } as any); } catch (e) { emptyError = e instanceof Error ? e.message : String(e); }
    check("empty edit list is rejected", emptyError.length > 0);
    let badHashError = "";
    try { await Edit({ path: target, read_hash: "not-a-hash", old_string: "A", new_string: "X" }); } catch (e) { badHashError = e instanceof Error ? e.message : String(e); }
    check("malformed read_hash is rejected", badHashError.length > 0 && /64 hexadecimal/i.test(badHashError));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }

  if (failures === 0) { console.log("\nAll Edit tool tests passed."); process.exit(0); }
  else { console.error(`\n${failures} Edit tool test(s) failed.`); process.exit(1); }
}

main().catch((error) => {
  console.error("Edit tool test harness crashed:", error);
  process.exit(1);
});
