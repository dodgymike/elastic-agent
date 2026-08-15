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
