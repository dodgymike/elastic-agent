/**
 * Legacy import tests for the versioned event store (MI-04).
 *
 * Uses the synthetic checked-in fixture (test/fixtures/memory-aaaa-1112-0001.json).
 * Covers idempotent re-import, no implicit merge across files with the same
 * session id, and corruption/size/identity/version failures that leave the
 * original untouched and never appear as valid empty memory.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryEventStore,
} from "../memory/event-store.js";
import {
  DEFAULT_MAX_LEGACY_FILE_BYTES,
  importLegacyMemoryDocument,
  quarantineLegacyFile,
} from "../memory/legacy-import.js";
import { loadSession } from "../memory/session-loader.js";
import type { MemoryScopeV2 } from "../memory/contracts-v2.js";

const fixturePath = join(__dirname, "..", "..", "fixtures", "memory-aaaa-1112-0001.json");

function makeScope(overrides: Partial<MemoryScopeV2> = {}): MemoryScopeV2 {
  return {
    workspaceId: "ws-import",
    principalId: "principal-import",
    sessionId: "aaaa-1112-0001",
    ...overrides,
  };
}

function readFixture(): string {
  return readFileSync(fixturePath, "utf8");
}

async function testImportFixtureTwiceCreatesOneLogicalHistory(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-import-"));
  try {
    const store = createMemoryEventStore({ filePath: join(dir, "events.sqlite") });
    const scope = makeScope();
    const first = await importLegacyMemoryDocument({ filePath: fixturePath, store, scope });
    assert.equal(first.status, "imported");
    if (first.status === "imported") {
      assert.equal(first.eventCount, 5, "4 steps + 1 summary event");
    }

    const second = await importLegacyMemoryDocument({ filePath: fixturePath, store, scope });
    assert.equal(second.status, "unchanged");

    const loaded = await loadSession(store, scope);
    assert.equal(loaded.status, "ready");
    if (loaded.status === "ready") {
      assert.equal(loaded.eventCount, 5, "re-import must not duplicate the logical history");
    }
    const retrieved = await store.retrieve({ scope, purpose: "replay", limit: 10 });
    assert.equal(retrieved.events.length, 5);
    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testTwoFilesWithSameSessionIdDoNotMergeImplicitly(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-import-"));
  try {
    const store = createMemoryEventStore({ filePath: join(dir, "events.sqlite") });
    const scope = makeScope();
    const fixture = JSON.parse(readFixture()) as Record<string, unknown>;
    const fileA = join(dir, "memory-aaaa-1112-0001.json");
    const fileB = join(dir, "other-name-mapping-to-same-session.json");
    writeFileSync(fileA, readFixture(), "utf8");
    fixture.summary = "A different historical summary for the same session id.";
    writeFileSync(fileB, JSON.stringify(fixture), "utf8");

    const first = await importLegacyMemoryDocument({ filePath: fileA, store, scope });
    const second = await importLegacyMemoryDocument({ filePath: fileB, store, scope });
    assert.equal(first.status, "imported");
    assert.equal(second.status, "imported");

    const loaded = await loadSession(store, scope);
    assert.equal(loaded.status, "ready");
    if (loaded.status === "ready") {
      assert.equal(loaded.eventCount, 10, "each explicit file import is its own logical history");
    }
    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testCorruptTooLargeMismatchedAndFutureVersionsFailSafely(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-import-"));
  try {
    const store = createMemoryEventStore({ filePath: join(dir, "events.sqlite") });
    const scope = makeScope();

    // Corrupt JSON leaves the original intact and does not create a session.
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not valid json", "utf8");
    const corruptResult = await importLegacyMemoryDocument({ filePath: corrupt, store, scope });
    assert.equal(corruptResult.status, "failure");
    assert.equal(readFileSync(corrupt, "utf8"), "{ not valid json");

    // Too-large file is rejected before parsing.
    const tooLarge = join(dir, "too-large.json");
    const tooLargeContent = JSON.stringify({ version: 1, session_id: scope.sessionId, summary: "x", stepCount: 0, steps: [] });
    writeFileSync(tooLarge, tooLargeContent, "utf8");
    const tooLargeResult = await importLegacyMemoryDocument({ filePath: tooLarge, store, scope, maxBytes: 16 });
    assert.equal(tooLargeResult.status, "failure");
    if (tooLargeResult.status === "failure") {
      assert.match(tooLargeResult.reason, /too large/);
    }
    assert.equal(readFileSync(tooLarge, "utf8"), tooLargeContent);

    // Mismatched embedded session id is rejected.
    const mismatched = join(dir, "mismatched.json");
    writeFileSync(mismatched, JSON.stringify({ version: 1, session_id: "other-session", summary: "x", stepCount: 0, steps: [] }), "utf8");
    const mismatchedResult = await importLegacyMemoryDocument({ filePath: mismatched, store, scope });
    assert.equal(mismatchedResult.status, "failure");
    if (mismatchedResult.status === "failure") {
      assert.match(mismatchedResult.reason, /does not match/);
    }

    // Future version is rejected.
    const future = join(dir, "future.json");
    writeFileSync(future, JSON.stringify({ version: 2, session_id: scope.sessionId, summary: "x", stepCount: 0, steps: [] }), "utf8");
    const futureResult = await importLegacyMemoryDocument({ filePath: future, store, scope });
    assert.equal(futureResult.status, "failure");
    if (futureResult.status === "failure") {
      assert.match(futureResult.reason, /unsupported legacy document version/);
    }

    // None of the failures may materialize as valid empty memory.
    const loaded = await loadSession(store, scope);
    assert.equal(loaded.status, "absent");

    // The quarantine helper copies (not moves) the corrupt original.
    const quarantined = quarantineLegacyFile(corrupt, join(dir, "quarantine"));
    assert.ok(readFileSync(quarantined, "utf8").includes("{ not valid json"));
    assert.equal(readFileSync(corrupt, "utf8"), "{ not valid json");

    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testImportFixtureTwiceCreatesOneLogicalHistory();
  await testTwoFilesWithSameSessionIdDoNotMergeImplicitly();
  await testCorruptTooLargeMismatchedAndFutureVersionsFailSafely();
  console.log("memory-import.test.ts: OK (idempotent import, no implicit merge, safe failures)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
