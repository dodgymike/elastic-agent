/**
 * Focused tests for the composite memory module (`src/memory/compositeMemory.ts`)
 * under its MI-11 authoritative-owner semantics.
 *
 * Coverage:
 *  1. Constructor validation (an authoritative primary is required; secondary
 *     projections are optional).
 *  2. remember() writes the authoritative owner exactly once and updates only
 *     explicitly non-durable projections (never duplicating durable writes).
 *  3. getContext() merges owner context first, omits exact duplicate text
 *     blocks, and respects configurable labels.
 *  4. Fail-safe: when one module's getContext()/remember() throws, the other's
 *     context is still returned / the failure is recorded.
 *  5. finalize() routes to the authoritative owner exactly once.
 *  6. Real concat-mode wiring (persistent owner + in-memory projection) writes
 *     the owner once, updates the cache projection, and does not repeat
 *     identical context blocks.
 *
 * Follows the project's test conventions: plain `node:assert/strict`, a
 * `main().catch(...)` entrypoint, compiled with tsc and run with node.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompositeMemoryModule,
  createCompositeMemoryModule,
  createConcatenationMemoryModule,
} from "../../src/memory/compositeMemory.js";
import { createInMemoryMemoryModule, InMemoryMemoryModule } from "../../src/memory/inMemory.js";
import { createPersistentMemoryModule, PersistentMemoryModule } from "../../src/memory/persistent.js";
import type {
  ContextRequest,
  MemoryContextResult,
  MemoryModule,
  RememberInput,
} from "../../src/memory/types.js";
import type { MemoryCapabilitiesV2 } from "../../src/memory/contracts-v2.js";

const SESSION = "session-composite";

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

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A configurable MemoryModule mock used to observe/control composite behavior. */
class StubMemory implements MemoryModule {
  readonly remembered: RememberInput[] = [];
  readonly name: string;
  result: MemoryContextResult;
  readonly capabilities?: MemoryCapabilitiesV2;
  /** When set, remember() throws. */
  throwOnRemember = false;
  /** When set, getContext() throws. */
  throwOnGetContext = false;
  /** Optional custom finalize callback for testing passthrough. */
  finalizeImpl?: (sessionId: string) => Promise<unknown>;
  finalizeCalls = 0;

  constructor(name: string, result: MemoryContextResult, capabilities?: MemoryCapabilitiesV2) {
    this.name = name;
    this.result = result;
    this.capabilities = capabilities;
  }

  async remember(input: RememberInput): Promise<void> {
    if (this.throwOnRemember) throw new Error(`${this.name} remember boom`);
    this.remembered.push(input);
  }

  async getContext(_request: ContextRequest): Promise<MemoryContextResult> {
    if (this.throwOnGetContext) throw new Error(`${this.name} getContext boom`);
    return this.result;
  }

  async finalize(sessionId: string): Promise<unknown> {
    this.finalizeCalls += 1;
    if (this.finalizeImpl) return this.finalizeImpl(sessionId);
    return `finalized:${sessionId}`;
  }
}

function rememberInput(step = 1): RememberInput {
  return {
    context: { session_id: SESSION },
    actions: [{ name: "Read" }],
    outcome: "completed",
    timestamp: "2025-01-01T00:00:00.000Z",
    extra: { step },
  };
}

const primaryResult: MemoryContextResult = {
  text: "Persistent summary text",
  matchedContexts: [{ session_id: SESSION }],
  hasMemory: true,
};
const secondaryResult: MemoryContextResult = {
  text: "In-memory summary text",
  matchedContexts: [{ session_id: SESSION }],
  hasMemory: true,
};

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function testConstructorRequiresOwner(): Promise<void> {
  assert.throws(
    // @ts-expect-error intentionally missing primary
    () => new CompositeMemoryModule({ secondary: new StubMemory("s", secondaryResult) }),
    /requires an authoritative primary/,
  );
  // Secondary projections are optional under the new ownership model.
  const ownerOnly = new CompositeMemoryModule({ primary: new StubMemory("p", primaryResult) });
  assert.ok(ownerOnly instanceof CompositeMemoryModule);

  // Factory with valid modules succeeds.
  const factoryModule = createCompositeMemoryModule({
    primary: new StubMemory("p", primaryResult),
    secondary: new StubMemory("s", secondaryResult),
  });
  assert.ok(factoryModule instanceof CompositeMemoryModule);
  const aliasModule = createConcatenationMemoryModule({
    primary: new StubMemory("p", primaryResult),
    secondary: new StubMemory("s", secondaryResult),
  });
  assert.ok(aliasModule instanceof CompositeMemoryModule);
}

async function testRememberWritesOwnerOnceAndUpdatesExplicitNonDurableProjection(): Promise<void> {
  const owner = new StubMemory("p", primaryResult);
  const cache = new StubMemory("s", secondaryResult, NON_DURABLE_CAPABILITIES);
  const durableProjection = new StubMemory("d", secondaryResult, DURABLE_CAPABILITIES);
  const module = new CompositeMemoryModule({
    primary: owner,
    secondary: cache,
    projections: [durableProjection],
  });

  await module.remember(rememberInput(1));
  await module.remember(rememberInput(2));

  assert.equal(owner.remembered.length, 2, "authoritative owner receives every remember");
  assert.equal(cache.remembered.length, 2, "non-durable projection receives cache updates");
  assert.equal(durableProjection.remembered.length, 0, "durable projection is never double-written");
  assert.equal(cache.remembered[0].extra?.step, 1);
  assert.equal(module.lastFailure, null, "no failure on successful remember");
}

async function testGetContextMergesOwnerFirst(): Promise<void> {
  const module = new CompositeMemoryModule({
    primary: new StubMemory("p", primaryResult),
    secondary: new StubMemory("s", secondaryResult, NON_DURABLE_CAPABILITIES),
  });
  const ctx = await module.getContext({ session_id: SESSION });

  const primaryIdx = ctx.text.indexOf("Persistent summary text");
  const secondaryIdx = ctx.text.indexOf("In-memory summary text");
  assert.ok(primaryIdx >= 0, "primary text present");
  assert.ok(secondaryIdx >= 0, "secondary text present");
  assert.ok(primaryIdx < secondaryIdx, "primary context appears before secondary");
  assert.match(ctx.text, /--- primary memory ---/);
  assert.match(ctx.text, /--- secondary memory ---/);
  assert.equal(ctx.hasMemory, true);
}

async function testGetContextDropsDuplicateTextBlocks(): Promise<void> {
  const owner = new StubMemory("p", { text: "same fact", matchedContexts: [], hasMemory: true });
  const cache = new StubMemory("s", { text: "same fact", matchedContexts: [], hasMemory: true }, NON_DURABLE_CAPABILITIES);
  const module = new CompositeMemoryModule({ primary: owner, secondary: cache });

  const ctx = await module.getContext({ session_id: SESSION });
  assert.equal(ctx.text.split("same fact").length - 1, 1, "identical text appears exactly once");
}

async function testGetContextUsesCustomHeaders(): Promise<void> {
  const module = new CompositeMemoryModule({
    primary: new StubMemory("p", primaryResult),
    secondary: new StubMemory("s", { text: "volatile", matchedContexts: [], hasMemory: true }, NON_DURABLE_CAPABILITIES),
    headers: { primary: "persistent", secondary: "in-memory" },
  });
  const ctx = await module.getContext({ session_id: SESSION });
  assert.match(ctx.text, /--- persistent ---/);
  assert.match(ctx.text, /--- in-memory ---/);
}

async function testGetContextFailSafeKeepsOtherContext(): Promise<void> {
  const primary = new StubMemory("p", primaryResult);
  const secondary = new StubMemory("s", secondaryResult, NON_DURABLE_CAPABILITIES);
  secondary.throwOnGetContext = true;
  const module = new CompositeMemoryModule({ primary, secondary });

  const ctx = await module.getContext({ session_id: SESSION });
  assert.ok(ctx.text.includes("Persistent summary text"), "primary context still returned");
  assert.ok(!ctx.text.includes("In-memory summary text"), "failed secondary omitted");
  assert.equal(module.lastFailure?.secondaryFailed, true, "recorded secondary failure");
}

async function testRememberFailSafeDoesNotReject(): Promise<void> {
  const primary = new StubMemory("p", primaryResult);
  const secondary = new StubMemory("s", secondaryResult, NON_DURABLE_CAPABILITIES);
  secondary.throwOnRemember = true;
  const module = new CompositeMemoryModule({ primary, secondary });

  await module.remember(rememberInput());
  assert.equal(primary.remembered.length, 1, "primary still wrote");
  assert.equal(module.lastFailure?.secondaryFailed, true, "recorded secondary failure");
}

async function testFinalizeRoutesToOwnerOnce(): Promise<void> {
  const primary = new StubMemory("p", primaryResult);
  primary.finalizeImpl = async (sessionId) => `finalized-${sessionId}`;
  const secondary = new StubMemory("s", secondaryResult, NON_DURABLE_CAPABILITIES);
  const module = new CompositeMemoryModule({ primary, secondary });

  const result = await module.finalize(SESSION);
  assert.equal(result, `finalized-${SESSION}`);
  assert.equal(primary.finalizeCalls, 1, "owner finalize called once");
  assert.equal(secondary.finalizeCalls, 0, "projections are never finalized");

  // A non-finalizable primary yields undefined without throwing.
  const inMemory = createInMemoryMemoryModule({});
  const compositeNonFinal = new CompositeMemoryModule({ primary: inMemory, secondary });
  assert.equal(await compositeNonFinal.finalize(SESSION), undefined);
}

async function testRealConcatWiring(): Promise<void> {
  // Mirrors the concat-mode setup in the unified factory: an authoritative
  // PersistentMemoryModule owner + an InMemoryMemoryModule cache projection.
  const dir = await mkdtemp(join(tmpdir(), "elagent-concat-"));
  try {
    const persistent = createPersistentMemoryModule({ outputDir: dir }) as PersistentMemoryModule;
    const inMemory = createInMemoryMemoryModule({}) as InMemoryMemoryModule;
    const module = new CompositeMemoryModule({
      primary: persistent,
      secondary: inMemory,
      headers: { primary: "persistent memory", secondary: "in-memory memory" },
    });

    const input: RememberInput = {
      context: { session_id: SESSION, user_id: "user-concat", plan: "P" },
      actions: [{ name: "Read" }, { name: "Edit" }],
      outcome: "completed",
      reasoning: "do it",
      timestamp: "2025-01-01T00:00:00.000Z",
    };
    await module.remember(input);

    // The owner is written once and the in-memory cache projection is updated.
    assert.equal(persistent.countForSession(SESSION), 1, "persistent owner updated");
    assert.equal(inMemory.countForSession(SESSION), 1, "in-memory projection updated");

    // Both stores render identical summaries over the same input, so the
    // composite returns the fact once (owner block only).
    const ctx = await module.getContext({ session_id: SESSION, user_id: "user-concat" });
    assert.match(ctx.text, /--- persistent memory ---/);
    assert.ok(!ctx.text.includes("--- in-memory memory ---"), "duplicate projection block omitted");
    assert.equal(ctx.text.split(`Session ${SESSION} history:`).length - 1, 1, "summary text appears once");
    assert.equal(ctx.hasMemory, true);

    // The composite's finalize() passthrough flushes the durable owner.
    const path = (await module.finalize(SESSION)) as string;
    assert.equal(typeof path, "string");
    assert.ok((path as string).endsWith(".json"), "durable owner finalize writes a document");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testConstructorRequiresOwner();
  await testRememberWritesOwnerOnceAndUpdatesExplicitNonDurableProjection();
  await testGetContextMergesOwnerFirst();
  await testGetContextDropsDuplicateTextBlocks();
  await testGetContextUsesCustomHeaders();
  await testGetContextFailSafeKeepsOtherContext();
  await testRememberFailSafeDoesNotReject();
  await testFinalizeRoutesToOwnerOnce();
  await testRealConcatWiring();
  console.log("composite-memory.test.ts: OK (authoritative owner, deduped retrieval, routed lifecycle)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
