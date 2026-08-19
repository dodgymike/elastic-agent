// Unit tests for the Grep text-search tool.
// Compiled and executed standalone by the `test:grep-tool` npm script.
import Grep from "../tools/Grep.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "grep-tool-test-"));
let failures = 0;
/** Temp subdirectory used to test literal-vs-regex pattern handling. */
let jsonPatternDir: string;
function check(name: string, cond: boolean): void {
  if (cond) { console.log(`PASS: ${name}`); }
  else { failures += 1; console.error(`FAIL: ${name}`); }
}

async function main(): Promise<void> {
  try {
    // Fixture tree:
    //   a.txt  -> "alpha\nbeta\ngamma\n"
    //   b.txt  -> "Alpha beta\ndelta\n"
    //   sub/c.txt -> "beta beta\n"
    //   big.txt -> 600k of 'a' (exceeds the default 500k maxFileSize)
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(dir, "b.txt"), "Alpha beta\ndelta\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "c.txt"), "beta beta\n");
    writeFileSync(join(dir, "big.txt"), "a".repeat(600_000));

    // 1. Basic recursive search returns path:line:text matches.
    const betaOnly = await Grep({ pattern: "beta", path: dir });
    check("basic search finds matches", betaOnly.matches.length >= 3 && betaOnly.files.length >= 3);
    check("matches carry path/line/text", betaOnly.matches.every((m) => typeof m.path === "string" && m.line >= 1 && typeof m.text === "string"));
    check("files lists unique matching file paths", betaOnly.files.length === new Set(betaOnly.files).size);
    check("single trailing newline does not add a phantom line", betaOnly.count === betaOnly.matches.length);

    // 2. Case-sensitive by default (lowercase 'beta' does not match 'Beta'... it
    //    matches 'beta' in b.txt but 'Beta' only with ignoreCase).
    const betaMatches = betaOnly.matches.filter((m) => m.path.endsWith("b.txt"));
    const caseSensitive = betaMatches.every((m) => !m.text.includes("Alpha Beta"));
    check("case-sensitive by default", caseSensitive);

    // 3. ignoreCase:true matches differently-cased text (uppercase pattern
    //    against lowercase file content).
    const betaCI = await Grep({ pattern: "BETA", path: dir, ignoreCase: true });
    const bCI = betaCI.matches.some((m) => m.path.endsWith("b.txt") && m.text.includes("beta"));
    check("ignoreCase matches differently-cased text", bCI);

    // 3b. Without ignoreCase, an uppercase pattern matches nothing.
    const caseSensitiveMiss = await Grep({ pattern: "BETA", path: dir, name: "*.txt" });
    check("case-sensitive pattern misses differently-cased content", caseSensitiveMiss.matches.every((m) => m.text !== "alpha"));
    check("case-sensitive uppercase search yields no matches", caseSensitiveMiss.matches.length === 0);

    // 4. Basename glob filter via `name`.
    const onlyC = await Grep({ pattern: "beta", path: dir, name: "c.txt" });
    check("name glob restricts files", onlyC.files.length === 1 && onlyC.files[0].endsWith("c.txt"));
    check("name glob results have correct line", onlyC.matches[0].line === 1 && onlyC.matches[0].text === "beta beta");

    // 5. maxdepth bounds recursion (1 inspects only direct children).
    const depthOne = await Grep({ pattern: "beta", path: dir, maxdepth: 1 });
    check("maxdepth 1 excludes nested files", depthOne.files.every((f) => !f.includes("/sub/")));

    // 6. Oversized files are skipped (default maxFileSize 500k skips big.txt).
    const overBig = await Grep({ pattern: "a", path: dir });
    check("oversized files are skipped by default", !overBig.files.some((f) => f.endsWith("big.txt")));

    // 7. Raising maxFileSize lets grep inspect the big file.
    const withBig = await Grep({ pattern: "a", path: dir, maxFileSize: 1_000_000, limit: 2000 });
    check("raised maxFileSize enables big-file search", withBig.files.some((f) => f.endsWith("big.txt")));

    // 8. limit caps the number of matches and sets truncated.
    const capped = await Grep({ pattern: "a", path: dir, maxFileSize: 1_000_000, limit: 5 });
    check("limit caps returned matches", capped.matches.length === 5 && capped.truncated === true);
    check("capped count equals match length", capped.count === capped.matches.length);

    // 9. literal:true treats regex metacharacters as literal text.
    jsonPatternDir = join(dir, "re");
    mkdirSync(jsonPatternDir);
    writeFileSync(join(jsonPatternDir, "x.txt"), "price is $5.00 and a+b\n");
    const literalHit = await Grep({ pattern: "a+b", path: jsonPatternDir, literal: true });
    check("literal:true matches plain text", literalHit.matches.length === 1);
    // In regex mode `a+b` means "one or more 'a' then 'b'" (no literal '+'),
    // so it does not match the literal "a+b" in the file content.
    const regexHit = await Grep({ pattern: "a+b", path: jsonPatternDir });
    check("regex mode interprets metacharacters (no literal match)", regexHit.matches.length === 0);

    // 10. A malformed regex rejects with an actionable error.
    let regexError = "";
    try {
      await Grep({ pattern: "([unclosed", path: dir });
    } catch (error) {
      regexError = error instanceof Error ? error.message : String(error);
    }
    check("malformed regex is rejected with actionable message", /not a valid regular expression/.test(regexError) && /literal/.test(regexError));

    // 11. data.json under the search path is never searched.
    writeFileSync(join(dir, "data.json"), "secret-beta-data\n");
    const dataJsonSearch = await Grep({ pattern: "secret-beta", path: dir });
    check("data.json contents are never searched", dataJsonSearch.files.every((f) => !f.endsWith("data.json")) && dataJsonSearch.matches.every((m) => !m.path.endsWith("data.json")));

    // 12. A single file can be grepped directly (path is a regular file, not a
    //     directory). name is ignored for a single-file search.
    const singleFile = await Grep({ pattern: "beta", path: join(dir, "a.txt") });
    check(
      "single-file grep finds matches in that file only",
      singleFile.files.length === 1 && singleFile.files[0].endsWith("a.txt"),
    );
    check("single-file grep returns correct line/text", singleFile.count === 1 && singleFile.matches[0].line === 2 && singleFile.matches[0].text === "beta");

    // 12b. recursive:false inspects only a directory's direct child files and
    //      does not descend into subdirectories.
    const nonRecursive = await Grep({ pattern: "beta", path: dir, recursive: false });
    check(
      "recursive:false excludes nested subdirectory files",
      nonRecursive.files.every((f) => !f.includes("/sub/")),
    );
    check(
      "recursive:false still finds direct child matches",
      nonRecursive.files.some((f) => f.endsWith("a.txt")),
    );
    // The default (recursive omitted) does descend and finds the nested file.
    const defaultRecursive = await Grep({ pattern: "beta", path: dir, name: "c.txt" });
    check(
      "default recursion descends into subdirectories",
      defaultRecursive.files.some((f) => f.includes("/sub/") && f.endsWith("c.txt")),
    );

    // 13. A missing base path is rejected with an actionable error.
    let missingDirError = "";
    try {
      await Grep({ pattern: "beta", path: join(dir, "does-not-exist") });
    } catch (error) {
      missingDirError = error instanceof Error ? error.message : String(error);
    }
    check("missing base path is rejected", /could not stat base path/.test(missingDirError));

    // 14. Invalid parameters are rejected.
    let blankPathError = "";
    try { await Grep({ pattern: "beta", path: "" }); } catch (error) { blankPathError = error instanceof Error ? error.message : String(error); }
    check("blank path is rejected", /must be a non-empty string/.test(blankPathError));

    let blankPatternError = "";
    try { await Grep({ pattern: "", path: dir }); } catch (error) { blankPatternError = error instanceof Error ? error.message : String(error); }
    check("blank pattern is rejected", /must be a non-empty string/.test(blankPatternError));

    let badMaxdepthError = "";
    try { await Grep({ pattern: "beta", path: dir, maxdepth: -1 }); } catch (error) { badMaxdepthError = error instanceof Error ? error.message : String(error); }
    check("negative maxdepth is rejected", /non-negative integer/.test(badMaxdepthError));

    let badLimitError = "";
    try { await Grep({ pattern: "beta", path: dir, limit: 0 }); } catch (error) { badLimitError = error instanceof Error ? error.message : String(error); }
    check("zero limit is rejected", /positive integer/.test(badLimitError));

    let badSizeError = "";
    try { await Grep({ pattern: "beta", path: dir, maxFileSize: -10 }); } catch (error) { badSizeError = error instanceof Error ? error.message : String(error); }
    check("non-positive maxFileSize is rejected", /positive integer byte count/.test(badSizeError));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }

  if (failures === 0) { console.log("\nAll Grep tool tests passed."); process.exit(0); }
  else { console.error(`\n${failures} Grep tool test(s) failed.`); process.exit(1); }
}

main().catch((error) => {
  console.error("Grep tool test harness crashed:", error);
  process.exit(1);
});
