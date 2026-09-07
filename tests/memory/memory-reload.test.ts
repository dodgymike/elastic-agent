/**
 * Two-process reload tests for the versioned event store (MI-04).
 *
 * Process A records a session, process B recalls it and appends, and process C
 * sees both events without duplication. A different workspace/principal with
 * the same session ID retrieves nothing.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryEventStore,
  type MemoryEventStore,
} from "../../src/memory/event-store.js";
import { loadSession } from "../../src/memory/session-loader.js";
import type {
  MemoryEventAppendV2,
  MemoryIdentityV2,
  MemoryScopeV2,
} from "../../src/memory/contracts-v2.js";

function makeScope(overrides: Partial<MemoryScopeV2> = {}): MemoryScopeV2 {
  return {
    workspaceId: "ws-reload",
    principalId: "principal-reload",
    sessionId: "session-reload",
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<MemoryIdentityV2> = {}): MemoryIdentityV2 {
  return {
    workspaceId: "ws-reload",
    principalId: "principal-reload",
    sessionId: "session-reload",
    runId: "run-reload",
    ...overrides,
  };
}

function makeAppend(eventId: string, overrides: Partial<MemoryEventAppendV2> = {}): MemoryEventAppendV2 {
  return {
    eventId,
    identity: makeIdentity(),
    runRef: "run-reload",
    kind: "observation",
    payload: { eventId },
    ...overrides,
  };
}

function runChild(script: string): string {
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
}

async function testProcessARecordsProcessBAppendsProcessCSeesBoth(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-reload-"));
  const filePath = join(dir, "events.sqlite");
  const storeJs = join(__dirname, "..", "..", "src", "memory", "event-store.js");
  const loaderJs = join(__dirname, "..", "..", "src", "memory", "session-loader.js");
  const scope = makeScope();
  try {
    // Process A records one event.
    const scriptA = [
      `const { createMemoryEventStore } = require(${JSON.stringify(storeJs)});`,
      `const store = createMemoryEventStore({ filePath: ${JSON.stringify(filePath)} });`,
      `const scope = ${JSON.stringify(scope)};`,
      `const event = ${JSON.stringify(makeAppend("evt-a"))};`,
      `(async () => { const result = await store.append(scope, event); await store.close(scope); console.log(JSON.stringify(result)); })().catch((e) => { console.error(e); process.exit(1); });`,
    ].join("\n");
    const resultA = JSON.parse(runChild(scriptA).trim());
    assert.equal(resultA.status, "durable");

    // Process B recalls the session (sees one event) and appends.
    const scriptB = [
      `const { createMemoryEventStore } = require(${JSON.stringify(storeJs)});`,
      `const { loadSession } = require(${JSON.stringify(loaderJs)});`,
      `const store = createMemoryEventStore({ filePath: ${JSON.stringify(filePath)} });`,
      `const scope = ${JSON.stringify(scope)};`,
      `const event = ${JSON.stringify(makeAppend("evt-b"))};`,
      `(async () => {`,
      `  const loaded = await loadSession(store, scope);`,
      `  const result = await store.append(scope, event);`,
      `  await store.close(scope);`,
      `  console.log(JSON.stringify({ loaded, result }));`,
      `})().catch((e) => { console.error(e); process.exit(1); });`,
    ].join("\n");
    const resultB = JSON.parse(runChild(scriptB).trim()) as { loaded: { status: string; eventCount: number }; result: { status: string } };
    assert.equal(resultB.loaded.status, "ready");
    assert.equal(resultB.loaded.eventCount, 1);
    assert.equal(resultB.result.status, "durable");

    // Process C sees both committed events without duplication.
    const scriptC = [
      `const { createMemoryEventStore } = require(${JSON.stringify(storeJs)});`,
      `const { loadSession } = require(${JSON.stringify(loaderJs)});`,
      `const store = createMemoryEventStore({ filePath: ${JSON.stringify(filePath)} });`,
      `const scope = ${JSON.stringify(scope)};`,
      `(async () => {`,
      `  const loaded = await loadSession(store, scope);`,
      `  const retrieved = await store.retrieve({ scope, purpose: "replay", limit: 10 });`,
      `  await store.close(scope);`,
      `  console.log(JSON.stringify({ loaded, events: retrieved.events.map((e) => e.eventId) }));`,
      `})().catch((e) => { console.error(e); process.exit(1); });`,
    ].join("\n");
    const resultC = JSON.parse(runChild(scriptC).trim()) as {
      loaded: { status: string; eventCount: number };
      events: string[];
    };
    assert.equal(resultC.loaded.status, "ready");
    assert.equal(resultC.loaded.eventCount, 2);
    assert.deepEqual([...resultC.events].sort(), ["evt-a", "evt-b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testSameSessionIdDifferentScopeIsIsolated(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-reload-"));
  const filePath = join(dir, "events.sqlite");
  const store: MemoryEventStore = createMemoryEventStore({ filePath });
  const scope = makeScope();
  try {
    await store.append(scope, makeAppend("evt-a"));
    const otherScope = makeScope({ workspaceId: "other-workspace" });
    const loaded = await loadSession(store, otherScope);
    assert.equal(loaded.status, "absent");
    const retrieved = await store.retrieve({ scope: otherScope, purpose: "replay" });
    assert.equal(retrieved.events.length, 0);
  } finally {
    await store.close(scope);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testProcessARecordsProcessBAppendsProcessCSeesBoth();
  await testSameSessionIdDifferentScopeIsIsolated();
  console.log("memory-reload.test.ts: OK (process A/B/C reload, scope isolation)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
