/**
 * MI-11 shared conformance suite: unified backend capabilities and composite
 * ownership routing.
 *
 * This suite runs the same contract checks against every advertised backend
 * configuration and, for the composite wrapper, uses fake projections with
 * write-count assertions to prove:
 *
 *  - one authoritative owner receives each remember() exactly once;
 *  - durable projections are never double-written;
 *  - flush/close/finalize/compaction route to the owner exactly once even
 *    through the wrapper;
 *  - composite retrieval drops exact duplicate text blocks so each logical
 *    fact appears once;
 *  - capability gaps (flush on a volatile backend, compaction on graph /
 *    persistent-v2) are explicit rather than silently skipped;
 *  - `persistent-v2` is opt-in, durable, and round-trips remember -> getContext.
 *
 * Follows the project's test conventions: plain `node:assert/strict`, a
 * `main().catch(...)` entrypoint, compiled with tsc and run with node.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesOf } from "../memory/backend-capabilities.js";
import {
  MemoryBackendSelectionError,
  createMemoryBackend,
  resolveMemoryTypeSelection,
} from "../memory/backend-factory.js";
import {
  CompositeMemoryModule,
  createCompositeMemoryModule,
} from "../memory/compositeMemory.js";
import { GraphMemoryModule } from "../memory/graph-memory.js";
import { InMemoryMemoryModule } from "../memory/inMemory.js";
import { PersistentMemoryModule } from "../memory/persistent.js";
import { PersistentV2MemoryModule } from "../memory/persistent-v2.js";
import type {
  MemoryCapabilitiesV2,
  MemoryScopeV2,
} from "../memory/contracts-v2.js";
import type {
  ContextRequest,
  MemoryContextResult,
  MemoryModule,
  RememberInput,
} from "../memory/types.js";

const SCOPE: MemoryScopeV2 = {
  workspaceId: "ws-test",
  principalId: "p-test",
  sessionId: "s-test",
};

const NON_DURABLE_CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: false,
  retrievalPurposes: ["prompt-context"],
  supportsCompaction: false,
  supportsForget: false,
  supportsExport: false,
};

const DURABLE_CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: true,
  retrievalPurposes: ["prompt-context", "replay", "audit", "export"],
  supportsCompaction: false,
  supportsForget: false,
  supportsExport: false,
};

/** A fake backend that counts every routed operation. */
class CountingMemory implements MemoryModule {
  readonly capabilities?: MemoryCapabilitiesV2;
  readonly remembered: RememberInput[] = [];
  rememberCount = 0;
  getContextCount = 0;
  initializeCount = 0;
  flushCount = 0;
  closeCount = 0;
  finalizeCount = 0;
  summary: string;
  private readonly summaries = new Map<string, string>();

  constructor(summary = "", capabilities?: MemoryCapabilitiesV2) {
    this.summary = summary;
    this.capabilities = capabilities;
  }

  async remember(input: RememberInput): Promise<void> {
    this.rememberCount += 1;
    this.remembered.push(input);
  }

  async getContext(_request: ContextRequest): Promise<MemoryContextResult> {
    this.getContextCount += 1;
    return { text: this.summary, matchedContexts: [], hasMemory: this.summary.length > 0 };
  }

  async initialize(scope: MemoryScopeV2) {
    this.initializeCount += 1;
    return { status: "ready", scope } as const;
  }

  async flush() {
    this.flushCount += 1;
    return { status: "durable", revision: this.flushCount } as const;
  }

  async close() {
    this.closeCount += 1;
    return { status: "closed" } as const;
  }

  async finalize(sessionId: string) {
    this.finalizeCount += 1;
    return `finalized:${sessionId}`;
  }

  getSummary(sessionId: string): string | undefined {
    return this.summaries.get(sessionId);
  }

  setSummary(sessionId: string, summary: string): void {
    this.summaries.set(sessionId, summary);
  }
}

function rememberInput(step = 1): RememberInput {
  return {
    context: { session_id: "s1", user_id: "u1" },
    actions: [{ name: "Read" }, { name: "Edit" }],
    outcome: "completed",
    timestamp: "2025-01-01T00:00:00.000Z",
    extra: { step },
  };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function testDefaultAndSupportedSelections(): Promise<void> {
  const defaultHandle = createMemoryBackend({});
  assert.equal(defaultHandle.kind, "persistent");
  assert.ok(defaultHandle.module instanceof PersistentMemoryModule, "default is persistent legacy");
  assert.equal(defaultHandle.capabilities.durable, false, "legacy persistent remember() is not per-append durable");

  const kinds = ["persistent", "in-memory", "graph", "concat", "both", "persistent-v2"];
  for (const type of kinds) {
    const handle = createMemoryBackend({ type });
    assert.equal(handle.kind, type, `${type} selection resolves to its canonical kind`);
    assert.ok(handle.module, `${type} produces a module`);
  }

  assert.ok(createMemoryBackend({ type: "in-memory" }).module instanceof InMemoryMemoryModule);
  assert.ok(createMemoryBackend({ type: "graph" }).module instanceof GraphMemoryModule);
  assert.ok(createMemoryBackend({ type: "concat" }).module instanceof CompositeMemoryModule);
  assert.ok(createMemoryBackend({ type: "persistent-v2" }).module instanceof PersistentV2MemoryModule);
}

async function testUnknownSelectionRejected(): Promise<void> {
  assert.throws(
    () => createMemoryBackend({ type: "banana" }),
    MemoryBackendSelectionError,
  );
  assert.throws(
    () => resolveMemoryTypeSelection("banana"),
    /unrecognized memory backend type/,
  );
  assert.equal(resolveMemoryTypeSelection(undefined), "persistent");
  assert.equal(resolveMemoryTypeSelection(""), "persistent");
  assert.equal(resolveMemoryTypeSelection("   "), "persistent");
}

async function testCapabilityInspection(): Promise<void> {
  const inMemory = createMemoryBackend({ type: "in-memory" });
  assert.equal(inMemory.capabilities.durable, false);
  assert.equal(inMemory.capabilities.supportsCompaction, true);

  const graph = createMemoryBackend({ type: "graph" });
  assert.equal(graph.capabilities.durable, false, "graph nodes are not persisted");
  assert.equal(graph.capabilities.supportsCompaction, false);

  const persistentV2 = createMemoryBackend({ type: "persistent-v2" });
  assert.equal(persistentV2.capabilities.durable, true);
  assert.equal(persistentV2.capabilities.supportsForget, false, "forget is a later task (MI-13)");

  // Unknown modules fall back to a conservative non-durable surface.
  assert.equal(capabilitiesOf({}).durable, false);
}

async function testPersistentV2Lifecycle(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "elagent-v2-"));
  try {
    const handle = createMemoryBackend({
      type: "persistent-v2",
      eventStorePath: join(dir, "events.sqlite"),
    });
    assert.equal(handle.capabilities.durable, true);

    const init = await handle.initialize(SCOPE);
    assert.equal(init.status, "ready");

    const close = await handle.close(SCOPE);
    assert.equal(close.status, "closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testCompositeRoutesLifecycleToOwnerOnce(): Promise<void> {
  const owner = new CountingMemory("owner", NON_DURABLE_CAPABILITIES);
  const projection = new CountingMemory("projection", NON_DURABLE_CAPABILITIES);
  const composite = createCompositeMemoryModule({ primary: owner, secondary: projection }) as CompositeMemoryModule;

  const init = await composite.initialize(SCOPE);
  assert.equal(init.status, "ready");
  await composite.flush(SCOPE);
  await composite.close(SCOPE);

  assert.equal(owner.initializeCount, 1, "initialize reaches owner once");
  assert.equal(owner.flushCount, 1, "flush reaches owner once");
  assert.equal(owner.closeCount, 1, "close reaches owner once");
  assert.equal(projection.initializeCount, 0, "projections are never initialized");
  assert.equal(projection.flushCount, 0, "projections are never flushed");
  assert.equal(projection.closeCount, 0, "projections are never closed");
}

async function testCompositeRememberWritesOwnerOnceAndSkipsDurableProjection(): Promise<void> {
  const owner = new CountingMemory("owner", NON_DURABLE_CAPABILITIES);
  const cache = new CountingMemory("cache", NON_DURABLE_CAPABILITIES);
  const durableProjection = new CountingMemory("durable-projection", DURABLE_CAPABILITIES);
  const composite = new CompositeMemoryModule({
    primary: owner,
    secondary: cache,
    projections: [durableProjection],
  });

  await composite.remember(rememberInput(1));

  assert.equal(owner.rememberCount, 1, "authoritative owner receives the event exactly once");
  assert.equal(cache.rememberCount, 1, "explicitly non-durable projection is updated as a cache");
  assert.equal(durableProjection.rememberCount, 0, "durable projection is skipped (no duplicate durable write)");
}

async function testCompositeRetrievalDeduplicatesIdenticalBlocks(): Promise<void> {
  const owner = new CountingMemory("same fact", NON_DURABLE_CAPABILITIES);
  const cache = new CountingMemory("same fact", NON_DURABLE_CAPABILITIES);
  const composite = new CompositeMemoryModule({ primary: owner, secondary: cache });

  const ctx = await composite.getContext({ session_id: "s1" });
  const occurrences = ctx.text.split("same fact").length - 1;
  assert.equal(occurrences, 1, "identical owner/projection text appears exactly once");
}

async function testCompositeFinalizeAndCompactionRouteToOwner(): Promise<void> {
  const owner = new CountingMemory("owner", NON_DURABLE_CAPABILITIES);
  const projection = new CountingMemory("projection", NON_DURABLE_CAPABILITIES);
  const composite = new CompositeMemoryModule({ primary: owner, secondary: projection });

  await composite.finalize("s1");
  assert.equal(owner.finalizeCount, 1, "finalize reaches owner once");
  assert.equal(projection.finalizeCount, 0, "projections are never finalized");

  composite.setSummary("s1", "compacted");
  assert.equal(composite.getSummary("s1"), "compacted");
  assert.equal(owner.getSummary("s1"), "compacted", "compaction write routes to owner");
}

async function testLegacyLifecycleGapsExplicit(): Promise<void> {
  const handle = createMemoryBackend({ type: "in-memory" });

  const init = await handle.initialize(SCOPE);
  assert.equal(init.status, "ready");
  const close = await handle.close(SCOPE);
  assert.equal(close.status, "closed");
  const flush = await handle.flush(SCOPE);
  assert.equal(flush.status, "failure");
  assert.match(flush.reason, /flush is unsupported/);

  assert.ok(handle.compactionStore !== null, "in-memory exposes a compaction store");
  assert.equal(createMemoryBackend({ type: "graph" }).compactionStore, null);
  assert.equal(createMemoryBackend({ type: "persistent-v2" }).compactionStore, null);
}

async function testPersistentV2RememberGetContextRoundTrip(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "elagent-v2-ctx-"));
  try {
    const handle = createMemoryBackend({
      type: "persistent-v2",
      eventStorePath: join(dir, "events.sqlite"),
    });
    const module = handle.module as PersistentV2MemoryModule;

    await module.remember(rememberInput(1));
    const ctx = await module.getContext({ session_id: "s1", user_id: "u1" });
    assert.equal(ctx.hasMemory, true);
    assert.match(ctx.text, /Session s1 memory:/);
    assert.match(ctx.text, /\[1\] completed: Read, Edit/);

    await handle.close(SCOPE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testNonDurableBackendsFinalizeAsNoOp(): Promise<void> {
  assert.equal(await createMemoryBackend({ type: "in-memory" }).finalize("s1"), undefined);
  assert.equal(await createMemoryBackend({ type: "graph" }).finalize("s1"), undefined);
}

async function main(): Promise<void> {
  await testDefaultAndSupportedSelections();
  await testUnknownSelectionRejected();
  await testCapabilityInspection();
  await testPersistentV2Lifecycle();
  await testCompositeRoutesLifecycleToOwnerOnce();
  await testCompositeRememberWritesOwnerOnceAndSkipsDurableProjection();
  await testCompositeRetrievalDeduplicatesIdenticalBlocks();
  await testCompositeFinalizeAndCompactionRouteToOwner();
  await testLegacyLifecycleGapsExplicit();
  await testPersistentV2RememberGetContextRoundTrip();
  await testNonDurableBackendsFinalizeAsNoOp();
  console.log("memory-backend-capabilities.test.ts: OK (capabilities, composite routing, persistent-v2 opt-in)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
