import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * SECLOG-03 regression test for the artifact tracking policy.
 *
 * It verifies, from metadata only (no artifact contents are read):
 * - the precise `.gitignore` rules keep generated memory/log/state artifacts
 *   out of accidental staging;
 * - required sanitized fixtures remain available;
 * - the artifact policy document records the cleanup steps for tracked
 *   runtime artifacts that predate this policy.
 */

function findRepoRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".gitignore")) && existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`could not locate repository root from ${start}`);
    }
    current = parent;
  }
}

function readIgnoreLines(repoRoot: string): string[] {
  return readFileSync(join(repoRoot, ".gitignore"), "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function assertIgnoreLine(lines: string[], pattern: string): void {
  assert.ok(
    lines.includes(pattern),
    `.gitignore must contain an exact ignore rule for '${pattern}'`,
  );
}

function testIgnoreRules(repoRoot: string): void {
  const lines = readIgnoreLines(repoRoot);

  // Runtime memory/log/state artifacts must be excluded.
  assertIgnoreLine(lines, "memory-output/");
  assertIgnoreLine(lines, "database.sqlite");
  assertIgnoreLine(lines, "database.sqlite-*");
  assertIgnoreLine(lines, "llm2.log");
  assertIgnoreLine(lines, "llm.log");
  assertIgnoreLine(lines, "prompt.log");

  // Protected path stays ignored for any new, untracked copy.
  assertIgnoreLine(lines, "data.json");
}

function testFixtures(repoRoot: string): void {
  const fixtures = [
    "docs/examples/elastic-agent-memory-aaaa-1112-0001.json",
    "tests/fixtures/memory-aaaa-1112-0001.json",
  ];
  for (const fixture of fixtures) {
    assert.ok(existsSync(join(repoRoot, fixture)), `required fixture must remain available: ${fixture}`);
  }
}

function testPolicyDocument(repoRoot: string): void {
  const policyPath = join(repoRoot, "docs/security/ARTIFACT_POLICY.md");
  assert.ok(existsSync(policyPath), "docs/security/ARTIFACT_POLICY.md must exist");
  const policy = readFileSync(policyPath, "utf-8");
  assert.ok(
    policy.includes("git rm --cached database.sqlite"),
    "policy must document the database.sqlite untracking command",
  );
  assert.ok(
    policy.includes("git rm --cached llm2.log"),
    "policy must document the llm2.log untracking command",
  );
  assert.ok(
    policy.includes("data.json") && policy.includes("Protected"),
    "policy must document data.json as a protected path",
  );
}

const repoRoot = findRepoRoot(__dirname);

testIgnoreRules(repoRoot);
testFixtures(repoRoot);
testPolicyDocument(repoRoot);

console.log("artifact policy checks passed");
