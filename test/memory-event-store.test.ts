/**
 * Focused tests for the isolated transactional SQLite event store (MI-03).
 *
 * Covers:
 *  - committed appends survive close/reopen (including a child process);
 *  - duplicate delivery is idempotent and divergent duplicates conflict;
 *  - two writers serialize without losing events or assigning conflicting
 *    sequences, and scopes have independent sequences;
 *  - exact scope filtering and bounded paging;
 *  - unsupported schema versions, invalid database files, and lock exhaustion
 *    return explicit failures without replacing existing data.
 *
 * Uses fresh temporary databases only; no production database contents are
 * test inputs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import {
  createMemoryEventStore,
  EVENT_STORE_DB_VERSION,
} from "../memory/event-store.js";
import type {
  MemoryEventAppendV2,
  MemoryIdentityV2,
  MemoryScopeV2,
} from "../memory/contracts-v2.js";

function makeScope(overrides: Partial<MemoryScopeV2> = {}): MemoryScopeV2 {
  return {
    workspaceId: "ws-a",
    principalId: "principal-a",
    sessionId: "session-1",
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<MemoryIdentityV2> = {}): MemoryIdentityV2 {
  return {
    workspaceId: "ws-a",
    principalId: "principal-a",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  };
}

function makeAppend(overrides: Partial<MemoryEventAppendV2> = {}): MemoryEventAppendV2 {
  return {
    eventId: "evt-1",
    identity: makeIdentity(),
    runRef: "run-1",
    stepRef: "0",
    kind: "observation",
    outcome: { asserted: "completed", verification: "verified" },
    payload: { step: 1 },
    ...overrides,
  };
}

async function testAppendSurvivesCloseAndReopen(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-event-store-"));
  const filePath = join(dir, "events.sqlite");
  try {
    const store1 = createMemoryEventStore({ filePath });
    assert.equal((await store1.initialize(makeScope())).status, "ready");
    const appended = await store1.append(makeScope(), makeAppend());
    assert.equal(appended.status, "durable");
    await store1.close(makeScope());

    const store2 = createMemoryEventStore({ filePath });
    const retrieved = await store2.retrieve({ scope: makeScope(), purpose: "replay" });
    assert.equal(retrieved.degraded, false);
    assert.equal(retrieved.events.length, 1);
    assert.equal(retrieved.events[0].eventId, "evt-1");
    assert.equal(retrieved.events[0].sequence, 1);
    assert.equal(retrieved.events[0].kind, "observation");
    await store2.close(makeScope());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testDuplicateIdempotentAndConflictFails(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-event-store-"));
  const filePath = join(dir, "events.sqlite");
  try {
    const store = createMemoryEventStore({ filePath });
    const scope = makeScope();
    const first = await store.append(scope, makeAppend());
    assert.equal(first.status, "durable");

    const duplicate = await store.append(scope, makeAppend());
    assert.equal(duplicate.status, "duplicate");

    const divergent = await store.append(scope, makeAppend({ payload: { step: 2 } }));
    assert.equal(divergent.status, "conflict");
    if (divergent.status === "conflict") {
      assert.match(divergent.reason, /different content digest/);
    }

    const retrieved = await store.retrieve({ scope, purpose: "replay" });
    assert.equal(retrieved.events.length, 1, "conflict must not insert a second event");
    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testTwoWritersSerializeAndScopesAreIndependent(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-event-store-"));
  const filePath = join(dir, "events.sqlite");
  try {
    const writerA = createMemoryEventStore({ filePath });
    const writerB = createMemoryEventStore({ filePath });
    const scope = makeScope();
    assert.equal((await writerA.initialize(scope)).status, "ready");
    assert.equal((await writerB.initialize(scope)).status, "ready");

    const [a, b] = await Promise.all([
      writerA.append(scope, makeAppend({ eventId: "evt-a" })),
      writerB.append(scope, makeAppend({ eventId: "evt-b" })),
    ]);
    assert.equal(a.status, "durable");
    assert.equal(b.status, "durable");
    if (a.status === "durable" && b.status === "durable") {
      assert.notEqual(a.sequence, b.sequence, "writers must not share a sequence");
      const sequences = new Set([a.sequence, b.sequence]);
      assert.deepEqual([...sequences].sort((x, y) => x - y), [1, 2]);
    }

    const retrieved = await writerA.retrieve({ scope, purpose: "replay" });
    assert.equal(retrieved.events.length, 2, "no event may be lost");

    // A different scope starts its own sequence numbering.
    const otherScope = makeScope({ sessionId: "session-2" });
    const other = await writerA.append(otherScope, makeAppend({ eventId: "evt-other", identity: makeIdentity({ sessionId: "session-2" }) }));
    assert.equal(other.status, "durable");
    if (other.status === "durable") {
      assert.equal(other.sequence, 1, "sequences are per session scope");
    }
    await writerA.close(scope);
    await writerB.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testScopeFilteringAndBoundedPaging(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-event-store-"));
  const filePath = join(dir, "events.sqlite");
  try {
    const store = createMemoryEventStore({ filePath });
    const scope = makeScope();
    for (let i = 1; i <= 5; i += 1) {
      const result = await store.append(
        scope,
        makeAppend({ eventId: `evt-${i}`, payload: { step: i } }),
      );
      assert.equal(result.status, "durable");
    }

    // Exact scope filtering: another scope sees nothing.
    const otherScope = makeScope({ sessionId: "other" });
    const other = await store.retrieve({ scope: otherScope, purpose: "replay" });
    assert.equal(other.events.length, 0);

    // Bounded pages return the expected slice in sequence order.
    const page1 = await store.retrieve({ scope, purpose: "replay", limit: 2 });
    assert.equal(page1.events.length, 2);
    assert.deepEqual(page1.events.map((e) => e.sequence), [1, 2]);

    const page2 = await store.retrieve({ scope, purpose: "replay", afterSequence: 2, limit: 2 });
    assert.deepEqual(page2.events.map((e) => e.sequence), [3, 4]);

    // A zero/negative page size is clamped to at least one row.
    const clamped = await store.retrieve({ scope, purpose: "replay", limit: 0 });
    assert.equal(clamped.events.length, 1);

    // Scope mismatch on append fails rather than falling back.
    const mismatch = await store.append(
      otherScope,
      makeAppend({ eventId: "evt-wrong", identity: makeIdentity({ sessionId: "session-1" }) }),
    );
    assert.equal(mismatch.status, "failure");
    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testUnsupportedSchemaFailsWithoutOverwrite(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-event-store-"));
  const filePath = join(dir, "events.sqlite");
  try {
    const setup = await open({ filename: filePath, driver: sqlite3.Database });
    await setup.exec(`PRAGMA user_version = ${EVENT_STORE_DB_VERSION + 10}`);
    await setup.close();

    const store = createMemoryEventStore({ filePath });
    const init = await store.initialize(makeScope());
    assert.equal(init.status, "failure");
    if (init.status === "failure") {
      assert.match(init.reason, /unsupported event store schema version/);
    }

    // The newer schema was not overwritten.
    const check = await open({ filename: filePath, driver: sqlite3.Database });
    const row = await check.get<{ user_version: number }>("PRAGMA user_version");
    assert.equal(row?.user_version, EVENT_STORE_DB_VERSION + 10);
    await check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testInvalidDatabaseFileFailsExplicitly(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-event-store-"));
  const filePath = join(dir, "events.sqlite");
  try {
    writeFileSync(filePath, "this is not a sqlite database", "utf-8");
    const store = createMemoryEventStore({ filePath });
    const init = await store.initialize(makeScope());
    assert.equal(init.status, "failure");
    assert.ok(readFileSync(filePath, "utf-8").includes("this is not a sqlite database"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testLockExhaustionFailsExplicitly(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-event-store-"));
  const filePath = join(dir, "events.sqlite");
  try {
    // Prepare a valid database first.
    const setup = createMemoryEventStore({ filePath });
    await setup.initialize(makeScope());
    await setup.close(makeScope());

    // Hold the write lock from another connection while a writer with a very
    // short busy timeout tries to append.
    const blocker = await open({ filename: filePath, driver: sqlite3.Database });
    await blocker.exec("BEGIN IMMEDIATE");
    try {
      const store = createMemoryEventStore({ filePath, busyTimeoutMs: 25 });
      const result = await store.append(makeScope(), makeAppend({ eventId: "evt-locked" }));
      assert.equal(result.status, "failure");
      if (result.status === "failure") {
        assert.match(result.reason, /locked|busy/i);
      }
      await store.close(makeScope());
    } finally {
      await blocker.exec("ROLLBACK");
      await blocker.close();
    }

    // Once the lock is released the store accepts appends again.
    const store = createMemoryEventStore({ filePath });
    const recovered = await store.append(makeScope(), makeAppend({ eventId: "evt-locked" }));
    assert.equal(recovered.status, "durable");
    await store.close(makeScope());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testChildProcessAppendIsVisibleAfterReopen(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-event-store-"));
  const filePath = join(dir, "events.sqlite");
  const scope = makeScope();
  const event = makeAppend({ eventId: "evt-child" });
  const storeJs = join(__dirname, "..", "memory", "event-store.js");
  const script = [
    `const { createMemoryEventStore } = require(${JSON.stringify(storeJs)});`,
    `const store = createMemoryEventStore({ filePath: ${JSON.stringify(filePath)} });`,
    `const scope = ${JSON.stringify(scope)};`,
    `const event = ${JSON.stringify(event)};`,
    `(async () => {`,
    `  const init = await store.initialize(scope);`,
    `  const result = await store.append(scope, event);`,
    `  await store.close(scope);`,
    `  console.log(JSON.stringify(result));`,
    `})().catch((error) => { console.error(error); process.exit(1); });`,
  ].join("\n");
  try {
    const stdout = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const result = JSON.parse(stdout.trim()) as { status: string };
    assert.equal(result.status, "durable");

    const reader = createMemoryEventStore({ filePath });
    const retrieved = await reader.retrieve({ scope, purpose: "replay" });
    assert.equal(retrieved.events.length, 1);
    assert.equal(retrieved.events[0].eventId, "evt-child");
    await reader.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testAppendSurvivesCloseAndReopen();
  await testDuplicateIdempotentAndConflictFails();
  await testTwoWritersSerializeAndScopesAreIndependent();
  await testScopeFilteringAndBoundedPaging();
  await testUnsupportedSchemaFailsWithoutOverwrite();
  await testInvalidDatabaseFileFailsExplicitly();
  await testLockExhaustionFailsExplicitly();
  await testChildProcessAppendIsVisibleAfterReopen();
  console.log("memory-event-store.test.ts: OK (durability, idempotence, writers, filtering, schema, lock)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
