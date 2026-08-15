// Unit tests for the FileSize and Read tools. Read now requires file_size from
// FileSize, plus read_offset and read_length, refuses files larger than 500k,
// and pages through the requested byte window while returning the full-file
// read_hash for Edit/Write.
// Compiled and executed standalone by the `test:read-tool` npm script.
import { Read } from "../tools/Read.js";
import { FileSize } from "../tools/FileSize.js";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "read-tool-test-"));
let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) { console.log(`PASS: ${name}`); }
  else { failures += 1; console.error(`FAIL: ${name}`); }
}

async function readWhole(path: string): Promise<{ content: string; read_hash: string; error?: unknown }> {
  const sizeResult = await FileSize({ path });
  assert.equal(sizeResult.error, undefined, `FileSize should succeed for ${path}`);
  return Read({ path, file_size: sizeResult.size, read_offset: 0, read_length: sizeResult.size }) as unknown as { content: string; read_hash: string; error?: unknown };
}

async function main(): Promise<void> {
  try {
    // 1. FileSize returns the correct byte size.
    const small = join(dir, "small.txt");
    writeFileSync(small, "hello\n");
    const smallSize = await FileSize({ path: small });
    check("FileSize returns the small file size", smallSize.error === undefined && smallSize.size === 6);

    // 2. A full-window read returns the whole content and a full-file hash.
    const full = await readWhole(small);
    check("Read full window returns content", full.error === undefined && full.content === "hello\n");
    check("Read returns a 64-hex full-file hash", /^[a-f0-9]{64}$/.test(full.read_hash));

    // 3. Read requires file_size, read_length, and read_offset.
    const missingSize = await Read({ path: small } as any);
    check("missing file_size is rejected", missingSize.error !== undefined && /file_size/.test(String(missingSize.error)));
    const missingLength = await Read({ path: small, file_size: smallSize.size, read_offset: 0 } as any);
    check("missing read_length is rejected", missingLength.error !== undefined && /read_length/.test(String(missingLength.error)));
    const missingOffset = await Read({ path: small, file_size: smallSize.size, read_length: smallSize.size } as any);
    check("missing read_offset is rejected", missingOffset.error !== undefined && /read_offset/.test(String(missingOffset.error)));

    // 4. A stale/wrong file_size is rejected.
    const staleSize = await Read({ path: small, file_size: smallSize.size + 1, read_offset: 0, read_length: smallSize.size });
    check("mismatched file_size is rejected", staleSize.error !== undefined && /does not match/.test(String(staleSize.error)));

    // 5. Files larger than 500k are refused.
    const tooBig = join(dir, "too-big.txt");
    writeFileSync(tooBig, Buffer.alloc(500_001, 0x61));
    const bigSize = await FileSize({ path: tooBig });
    const bigRead = await Read({ path: tooBig, file_size: bigSize.size, read_offset: 0, read_length: 1000 });
    check("FileSize reports the large size", bigSize.error === undefined && bigSize.size === 500_001);
    check("Read refuses files larger than 500k", bigRead.error !== undefined && /too large|500000/.test(String(bigRead.error)));

    // 6. Paging through a file larger than 50k returns all bytes and identical
    //    full-file hashes from each page.
    const paged = join(dir, "paged.txt");
    const pagedText = "a".repeat(120_000);
    writeFileSync(paged, pagedText);
    const pagedSize = await FileSize({ path: paged });
    const page1 = await Read({ path: paged, file_size: pagedSize.size, read_offset: 0, read_length: 50_000 });
    const page2 = await Read({ path: paged, file_size: pagedSize.size, read_offset: 50_000, read_length: 50_000 });
    const page3 = await Read({ path: paged, file_size: pagedSize.size, read_offset: 100_000, read_length: 50_000 });
    check("paged reads succeed", page1.error === undefined && page2.error === undefined && page3.error === undefined);
    check("pages concatenate to the full content", page1.content + page2.content + page3.content === pagedText);
    check("every page reports the same full-file hash", page1.read_hash === page2.read_hash && page2.read_hash === page3.read_hash);
    const expectedPagedHash = createHash("sha256").update(readFileSync(paged)).digest("hex");
    check("page hashes match the full file bytes", page1.read_hash === expectedPagedHash);

    // 7. UTF-8 page boundaries snap outward so multi-byte characters are not
    //    split or replaced.
    const utf8 = join(dir, "utf8.txt");
    const utf8Text = "a".repeat(49_999) + "é" + "b".repeat(40_000);
    writeFileSync(utf8, utf8Text);
    const utf8Size = await FileSize({ path: utf8 });
    const utf8Page1 = await Read({ path: utf8, file_size: utf8Size.size, read_offset: 0, read_length: 50_000 });
    const utf8Page2 = await Read({ path: utf8, file_size: utf8Size.size, read_offset: 50_000, read_length: 50_000 });
    check("UTF-8 boundary pages contain no replacement chars", !utf8Page1.content.includes("\uFFFD") && !utf8Page2.content.includes("\uFFFD"));
    check("UTF-8 boundary page keeps the split character whole", utf8Page1.content.endsWith("é"));
    check("UTF-8 boundary overlap preserves the character on the next page", utf8Page2.content.startsWith("é"));

    // 8. read_offset beyond EOF is rejected rather than returning garbage.
    const beyond = await Read({ path: small, file_size: smallSize.size, read_offset: smallSize.size + 1, read_length: 10 });
    check("read_offset beyond EOF is rejected", beyond.error !== undefined && /beyond/.test(String(beyond.error)));

    // 9. line_range reads only the requested lines and returns the full-file hash.
    const numbered = join(dir, "numbered.txt");
    const numberedText = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join("\n") + "\n";
    writeFileSync(numbered, numberedText);
    const numberedSize = await FileSize({ path: numbered });
    const numberedRange = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: "3-5" });
    check("line_range 3-5 returns only those lines", numberedRange.error === undefined && numberedRange.content === "line3\nline4\nline5");
    const numberedExpectedHash = createHash("sha256").update(readFileSync(numbered)).digest("hex");
    check("line_range returns the full-file hash", numberedRange.read_hash === numberedExpectedHash);

    // 10. A single-line line_range is accepted.
    const singleLine = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: "7" });
    check("single-line line_range returns that line", singleLine.error === undefined && singleLine.content === "line7");

    // 11. Invalid line_range values are rejected with actionable messages.
    const zeroRange = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: "0-3" });
    check("line_range 0-3 is rejected as non-positive", zeroRange.error !== undefined && /positive integers/.test(String(zeroRange.error)));
    const reversedRange = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: "5-3" });
    check("line_range 5-3 is rejected as reversed", reversedRange.error !== undefined && /less than or equal/.test(String(reversedRange.error)));
    const malformedRange = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: "3-4-5" });
    check("malformed line_range is rejected", malformedRange.error !== undefined && /line_range must be/.test(String(malformedRange.error)));
    const blankRange = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: "   " });
    check("blank line_range is rejected", blankRange.error !== undefined && /non-empty/.test(String(blankRange.error)));
    const nonStringRange = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: 123 } as any);
    check("non-string line_range is rejected", nonStringRange.error !== undefined && /must be a string/.test(String(nonStringRange.error)));

    // 12. line_range end beyond the file's total line count is rejected.
    const tooManyLines = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: "9-11" });
    check("line_range end beyond the total line count is rejected", tooManyLines.error !== undefined && /total line count 10/.test(String(tooManyLines.error)));

    // 13. line_range works when byte-window parameters are omitted (direct API).
    const rangeWithoutWindow = await Read({ path: numbered, file_size: numberedSize.size, line_range: "2-3" } as any);
    check("line_range works without read_offset/read_length", rangeWithoutWindow.error === undefined && rangeWithoutWindow.content === "line2\nline3");

    // 14. An inconsistent byte window is rejected rather than returning partial lines.
    const inconsistentWindow = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: 1, line_range: "1-1" });
    check("inconsistent line_range/byte window is rejected", inconsistentWindow.error !== undefined && /not fully contained/.test(String(inconsistentWindow.error)));
    const consistentWindow = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, line_range: "8-10" });
    check("full-file byte window is consistent with line_range", consistentWindow.error === undefined && consistentWindow.content === "line8\nline9\nline10");

    // 15. line_range on an empty file is rejected with a clear message.
    const emptyFile = join(dir, "empty-lines.txt");
    writeFileSync(emptyFile, "");
    const emptySize = await FileSize({ path: emptyFile });
    const emptyRange = await Read({ path: emptyFile, file_size: emptySize.size, read_offset: 0, read_length: 1, line_range: "1-1" });
    check("line_range on an empty file is rejected", emptyRange.error !== undefined && /file has no lines/.test(String(emptyRange.error)));

    // 16. line_range plus only one byte-window parameter is rejected, because
    //     read_offset and read_length must always be supplied together.
    const offsetOnlyRange = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, line_range: "1-2" } as any);
    check("line_range with read_offset only is rejected", offsetOnlyRange.error !== undefined && /supplied together/.test(String(offsetOnlyRange.error)));
    const lengthOnlyRange = await Read({ path: numbered, file_size: numberedSize.size, read_length: numberedSize.size, line_range: "1-2" } as any);
    check("line_range with read_length only is rejected", lengthOnlyRange.error !== undefined && /supplied together/.test(String(lengthOnlyRange.error)));

    // 17. Optional read_hash validation returns content only when the hash matches.
    const numberedHash = createHash("sha256").update(readFileSync(numbered)).digest("hex");
    const matchingHashRead = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, read_hash: numberedHash });
    check("matching read_hash returns content", matchingHashRead.error === undefined && matchingHashRead.content === numberedText);
    const mismatchedHashRead = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, read_hash: "0".repeat(64) });
    check("mismatched read_hash is rejected with the actual hash", mismatchedHashRead.error !== undefined && /File has changed/.test(String(mismatchedHashRead.error)) && mismatchedHashRead.read_hash === numberedHash);
    const malformedHashRead = await Read({ path: numbered, file_size: numberedSize.size, read_offset: 0, read_length: numberedSize.size, read_hash: "not-a-hash" });
    check("malformed read_hash is rejected", malformedHashRead.error !== undefined && /File has changed/.test(String(malformedHashRead.error)));
    const hashWithLineRange = await Read({ path: numbered, file_size: numberedSize.size, line_range: "2-4", read_hash: numberedHash } as any);
    check("matching read_hash with line_range returns only the requested lines", hashWithLineRange.error === undefined && hashWithLineRange.content === "line2\nline3\nline4");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }

  if (failures === 0) { console.log("\nAll Read/FileSize tool tests passed."); process.exit(0); }
  else { console.error(`\n${failures} Read/FileSize tool test(s) failed.`); process.exit(1); }
}

main().catch((error) => {
  console.error("Read/FileSize tool test harness crashed:", error);
  process.exit(1);
});
