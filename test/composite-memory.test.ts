/**
 * Focused tests for the composite concatenation memory module
 * (`memory/compositeMemory.ts`).
 *
 * Coverage:
 *  1. Constructor validation (primary/secondary required).
 *  2. remember() forwards to BOTH wrapped modules.
 *  3. getContext() concatenates primary context first then secondary, each
 *     under its own separator header, with configurable labels.
 *  4. Fail-safe: when one module's getContext() throws, the other's context is
 *     still returned.
 *  5. Fail-safe: when one module's remember() throws, the composite reports it
 *     on lastFailure but does not reject.
 *  6. finalize() passthrough: forwards to a durable (finalizable) primary.
 *  7. Real concat-mode wiring (as main.ts sets up): a durable
 *     PersistentMemoryModule primary + InMemoryMemoryModule secondary — both
 *     stores are updated on remember() and both labelled blocks appear in
 *     getContext(), with session/user context reaching both inner modules and
 *     finalize() flushing the durable primary.
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
} from "../memory/compositeMemory.js";
import { createInMemoryMemoryModule, InMemoryMemoryModule } from "../memory/inMemory.js";
import { createPersistentMemoryModule, PersistentMemoryModule } from "../memory/persistent.js";
import type {
  ContextRequest,
  MemoryContextResult,
  MemoryModule,
  RememberInput,
} from "../memory/types.js";

const SESSION = "session-composite";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A configurable MemoryModule mock used to observe/control composite behavior. */
class StubMemory implements MemoryModule {
  readonly remembered: RememberInput[] = [];
  readonly name: string;
  result: MemoryContextResult;
  /** When set, remember() throws. */
  throwOnRemember = false;
  /** When set, getContext() throws. */
  throwOnGetContext = false;
  /** Optional custom finalize callback for testing passthrough. */
  finalizeImpl?: (sessionId: string) => Promise<unknown>;

  constructor(name: string, result: MemoryContextResult) {
    this.name = name;
    this.result = result;
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

async function testConstructorRequiresModules(): Promise<void> {
  assert.throws(
    // @ts-expect-error intentionally missing primary
    () => new CompositeMemoryModule({ secondary: new StubMemory("s", secondaryResult) }),
    /requires a primary/,
  );
  assert.throws(
    // @ts-expect-error intentionally missing secondary
    () => new CompositeMemoryModule({ primary: new StubMemory("p", primaryResult) }),
    /requires a secondary/,
  );
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

async function testRememberForwardsToBoth(): Promise<void> {
  const primary = new StubMemory("p", primaryResult);
  const secondary = new StubMemory("s", secondaryResult);
  const module = new CompositeMemoryModule({ primary, secondary });

  await module.remember(rememberInput(1));
  await module.remember(rememberInput(2));

  assert.equal(primary.remembered.length, 2, "primary receives every remember");
  assert.equal(secondary.remembered.length, 2, "secondary receives every remember");
  assert.equal(secondary.remembered[0].extra?.step, 1);
  assert.equal(module.lastFailure, null, "no failure on successful remember");

  // A real in-memory backend pair also holds both histories.
  const memA = createInMemoryMemoryModule({});
  const memB = createInMemoryMemoryModule({});
  const composite = new CompositeMemoryModule({ primary: memA, secondary: memB });
  await composite.remember(rememberInput());
  const ctx = await composite.getContext({ session_id: SESSION });
  assert.equal(ctx.hasMemory, true);
}

async function testGetContextConcatenatesPrimaryFirst(): Promise<void> {
  const module = new CompositeMemoryModule({
    primary: new StubMemory("p", primaryResult),
    secondary: new StubMemory("s", secondaryResult),
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

async function testGetContextUsesCustomHeaders(): Promise<void> {
  const module = new CompositeMemoryModule({
    primary: new StubMemory("p", primaryResult),
    secondary: new StubMemory("s", { text: "volatile", matchedContexts: [], hasMemory: true }),
    headers: { primary: "persistent", secondary: "in-memory" },
  });
  const ctx = await module.getContext({ session_id: SESSION });
  assert.match(ctx.text, /--- persistent ---/);
  assert.match(ctx.text, /--- in-memory ---/);
}

async function testGetContextFailSafeKeepsOtherContext(): Promise<void> {
  const primary = new StubMemory("p", primaryResult);
  const secondary = new StubMemory("s", secondaryResult);
  secondary.throwOnGetContext = true;
  const module = new CompositeMemoryModule({ primary, secondary });

  const ctx = await module.getContext({ session_id: SESSION });
  assert.ok(ctx.text.includes("Persistent summary text"), "primary context still returned");
  assert.ok(!ctx.text.includes("In-memory summary text"), "failed secondary omitted");
  assert.equal(module.lastFailure?.secondaryFailed, true, "recorded secondary failure");
}

async function testRememberFailSafeDoesNotReject(): Promise<void> {
  const primary = new StubMemory("p", primaryResult);
  const secondary = new StubMemory("s", secondaryResult);
  secondary.throwOnRemember = true;
  const module = new CompositeMemoryModule({ primary, secondary });

  await module.remember(rememberInput());
  assert.equal(primary.remembered.length, 1, "primary still wrote");
  assert.equal(module.lastFailure?.secondaryFailed, true, "recorded secondary failure");
}

async function testFinalizePassthrough(): Promise<void> {
  const primary = new StubMemory("p", primaryResult);
  primary.finalizeImpl = async (sessionId) => `finalized-${sessionId}`;
  const secondary = new StubMemory("s", secondaryResult);
  const module = new CompositeMemoryModule({ primary, secondary });

  const result = await module.finalize(SESSION);
  assert.equal(result, `finalized-${SESSION}`);

  // A non-finalizable primary yields undefined without throwing.
  const inMemory = createInMemoryMemoryModule({});
  const compositeNonFinal = new CompositeMemoryModule({ primary: inMemory, secondary });
  assert.equal(await compositeNonFinal.finalize(SESSION), undefined);
}

async function testRealConcatWiring(): Promise<void> {
  // Mirrors the concat-mode setup in main.ts: a durable PersistentMemoryModule
  // primary + an InMemoryMemoryModule secondary, with named headers.
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

    // Both inner stores are updated (point 3: concat updates both stores).
    assert.equal(persistent.countForSession(SESSION), 1, "persistent primary updated");
    assert.equal(inMemory.countForSession(SESSION), 1, "in-memory secondary updated");

    // getContext() concatenates both labelled blocks, persistent first.
    const ctx = await module.getContext({ session_id: SESSION, user_id: "user-concat" });
    assert.match(ctx.text, /--- persistent memory ---/);
    assert.match(ctx.text, /--- in-memory memory ---/);
    const persistentIdx = ctx.text.indexOf("--- persistent memory ---");
    const inMemoryIdx = ctx.text.indexOf("--- in-memory memory ---");
    assert.ok(persistentIdx >= 0 && inMemoryIdx >= 0);
    assert.ok(persistentIdx < inMemoryIdx, "persistent block precedes in-memory block");
    assert.equal(ctx.hasMemory, true);

    // The composite's finalize() passthrough flushes the durable primary.
    const path = (await module.finalize(SESSION)) as string;
    assert.equal(typeof path, "string");
    assert.ok((path as string).endsWith(".json"), "durable primary finalize writes a document");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testConstructorRequiresModules();
  await testRememberForwardsToBoth();
  await testGetContextConcatenatesPrimaryFirst();
  await testGetContextUsesCustomHeaders();
  await testGetContextFailSafeKeepsOtherContext();
  await testRememberFailSafeDoesNotReject();
  await testFinalizePassthrough();
  await testRealConcatWiring();
  console.log("composite-memory.test.ts: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
