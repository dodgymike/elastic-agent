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

    // 7. line_range mode replaces exactly the requested 1-based lines.
    const rangeTarget = join(dir, "range.txt");
    writeFileSync(rangeTarget, "one\ntwo\nthree\nfour\nfive\n");
    const rangeRead = await readFileTool(rangeTarget);
    assert.equal(rangeRead.error, undefined, "Read should succeed on the line-range file");
    const rangeEdit = await Edit({
      path: rangeTarget,
      read_hash: rangeRead.read_hash,
      line_range: "2-4",
      content: "TWO\nthree-and-a-half\n",
    });
    check("line_range replacement returns applied=1", rangeEdit.applied === 1);
    check("line_range replacement rewrites only the selected lines", readFileSync(rangeTarget, "utf8") === "one\nTWO\nthree-and-a-half\nfive\n");
    check("line_range replacement returns the new content", rangeEdit.content === readFileSync(rangeTarget, "utf8"));
    check("line_range replacement returns a fresh 64-hex hash", /^[a-f0-9]{64}$/.test(rangeEdit.read_hash));

    // 8. Single-line line_range and empty-content deletion both work.
    const singleRange = await Edit({ path: rangeTarget, read_hash: rangeEdit.read_hash, line_range: "3", content: "THIRD" });
    check("single-line line_range replaces one line", singleRange.applied === 1 && readFileSync(rangeTarget, "utf8") === "one\nTWO\nTHIRD\nfive\n");
    const deleteRange = await Edit({ path: rangeTarget, read_hash: singleRange.read_hash, line_range: "2-3", content: "" });
    check("empty line_range content deletes the selected lines", deleteRange.applied === 1 && readFileSync(rangeTarget, "utf8") === "one\nfive\n");

    // 9. line_range rejects invalid combinations and formats.
    const comboTarget = join(dir, "combo.txt");
    writeFileSync(comboTarget, "a\nb\nc\nd\n");
    const comboRead = await readFileTool(comboTarget);
    let comboError = "";
    try {
      await Edit({ path: comboTarget, read_hash: comboRead.read_hash, line_range: "1-2", old_string: "a", new_string: "A", content: "x" });
    } catch (e) { comboError = e instanceof Error ? e.message : String(e); }
    check("line_range combined with string edit is rejected", comboError.length > 0 && /cannot be combined/i.test(comboError));

    let contentOnlyError = "";
    try { await Edit({ path: comboTarget, read_hash: comboRead.read_hash, content: "x" } as any); } catch (e) { contentOnlyError = e instanceof Error ? e.message : String(e); }
    check("content without line_range is rejected", contentOnlyError.length > 0 && /only valid together with line_range/i.test(contentOnlyError));

    let missingContentError = "";
    try { await Edit({ path: comboTarget, read_hash: comboRead.read_hash, line_range: "1-2" } as any); } catch (e) { missingContentError = e instanceof Error ? e.message : String(e); }
    check("line_range without content is rejected", missingContentError.length > 0 && /content must be a string/i.test(missingContentError));

    let reversedRangeError = "";
    try { await Edit({ path: comboTarget, read_hash: comboRead.read_hash, line_range: "3-2", content: "x" }); } catch (e) { reversedRangeError = e instanceof Error ? e.message : String(e); }
    check("reversed line_range is rejected", reversedRangeError.length > 0 && /less than or equal/i.test(reversedRangeError));

    let malformedRangeError = "";
    try { await Edit({ path: comboTarget, read_hash: comboRead.read_hash, line_range: "1-2-3", content: "x" }); } catch (e) { malformedRangeError = e instanceof Error ? e.message : String(e); }
    check("malformed line_range is rejected", malformedRangeError.length > 0 && /line_range must be/i.test(malformedRangeError));

    let nonStringRangeError = "";
    try { await Edit({ path: comboTarget, read_hash: comboRead.read_hash, line_range: 123, content: "x" } as any); } catch (e) { nonStringRangeError = e instanceof Error ? e.message : String(e); }
    check("non-string line_range is rejected", nonStringRangeError.length > 0 && /non-empty string/i.test(nonStringRangeError));

    let beyondLinesError = "";
    try { await Edit({ path: comboTarget, read_hash: comboRead.read_hash, line_range: "3-10", content: "x" }); } catch (e) { beyondLinesError = e instanceof Error ? e.message : String(e); }
    check("line_range end beyond the total line count is rejected", beyondLinesError.length > 0 && /total line count 4/i.test(beyondLinesError));

    // 10. A stale read_hash is rejected in line_range mode and the file stays unchanged.
    const staleTarget = join(dir, "stale-range.txt");
    writeFileSync(staleTarget, "r1\nr2\nr3\nr4\n");
    const staleRead = await readFileTool(staleTarget);
    await Edit({ path: staleTarget, read_hash: staleRead.read_hash, old_string: "r2", new_string: "R2" });
    const staleBefore = readFileSync(staleTarget, "utf8");
    let staleRangeError = "";
    try {
      await Edit({ path: staleTarget, read_hash: staleRead.read_hash, line_range: "3-4", content: "new" });
    } catch (e) { staleRangeError = e instanceof Error ? e.message : String(e); }
    check("stale read_hash is rejected in line_range mode", staleRangeError.length > 0 && /changed since it was read/i.test(staleRangeError));
    check("stale line_range edit leaves the file unchanged", readFileSync(staleTarget, "utf8") === staleBefore);

    // 11. A valid-format but mismatched read_hash is rejected before any write.
    let mismatchedRangeError = "";
    try {
      await Edit({ path: staleTarget, read_hash: "0".repeat(64), line_range: "3-4", content: "new" });
    } catch (e) { mismatchedRangeError = e instanceof Error ? e.message : String(e); }
    check("mismatched read_hash is rejected in line_range mode", mismatchedRangeError.length > 0 && /changed since it was read/i.test(mismatchedRangeError));
    check("mismatched line_range edit leaves the file unchanged", readFileSync(staleTarget, "utf8") === staleBefore);
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
