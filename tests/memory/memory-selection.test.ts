/**
 * Focused tests for the memory backend SELECTION semantics wired through the
 * unified composition factory (src/memory/backend-factory.ts), which src/main.ts uses
 * for ELAGENT_MEMORY_TYPE.
 *
 * The factory is the single source of truth for selection, so this test pins:
 *
 *   - default (ELAGENT_MEMORY_TYPE unset)              -> persistent legacy
 *   - "in-memory"                                      -> volatile InMemoryMemoryModule
 *   - "graph"                                          -> GraphMemoryModule projection
 *   - "concat" | "both"                                -> CompositeMemoryModule
 *                                                         (persistent owner + in-memory projection)
 *   - "persistent-v2"                                  -> opt-in PersistentV2MemoryModule
 *   - any unrecognized value                           -> MemoryBackendSelectionError
 *
 * Follows the project's test conventions: plain `node:assert/strict`, a
 * `main().catch(...)` entrypoint, compiled with tsc and run with node.
 */

import assert from "node:assert/strict";
import {
  MemoryBackendSelectionError,
  createMemoryBackend,
  resolveMemoryTypeSelection,
} from "../../src/memory/backend-factory.js";
import { CompositeMemoryModule } from "../../src/memory/compositeMemory.js";
import { GraphMemoryModule } from "../../src/memory/graph-memory.js";
import { InMemoryMemoryModule } from "../../src/memory/inMemory.js";
import { PersistentMemoryModule } from "../../src/memory/persistent.js";
import { PersistentV2MemoryModule } from "../../src/memory/persistent-v2.js";

async function testDefaultIsPersistentLegacy(): Promise<void> {
  const handle = createMemoryBackend({});
  assert.equal(handle.kind, "persistent");
  assert.ok(
    handle.module instanceof PersistentMemoryModule,
    "default backend must be the persistent legacy module",
  );
  assert.ok(
    !(handle.module instanceof InMemoryMemoryModule),
    "default backend must NOT be the in-memory module",
  );
  // remember() is in-process; durability is only established at finalize.
  assert.equal(handle.capabilities.durable, false);
}

async function testExplicitSelections(): Promise<void> {
  assert.ok(createMemoryBackend({ type: "in-memory" }).module instanceof InMemoryMemoryModule);
  assert.ok(createMemoryBackend({ type: "graph" }).module instanceof GraphMemoryModule);
  assert.ok(createMemoryBackend({ type: "concat" }).module instanceof CompositeMemoryModule);
  assert.ok(createMemoryBackend({ type: "both" }).module instanceof CompositeMemoryModule);
}

async function testConcatSelectionIsCompositeOverPersistentAndInMemory(): Promise<void> {
  const handle = createMemoryBackend({ type: "concat" });
  const composite = handle.module as CompositeMemoryModule;
  assert.ok(composite instanceof CompositeMemoryModule, "concat wraps a CompositeMemoryModule");
  assert.equal(handle.capabilities.durable, false, "legacy persistent owner is not per-append durable");
  assert.ok(handle.compactionStore !== null, "compaction routes through the composite to the owner");
}

async function testPersistentV2IsOptIn(): Promise<void> {
  const handle = createMemoryBackend({ type: "persistent-v2" });
  assert.ok(handle.module instanceof PersistentV2MemoryModule, "persistent-v2 selects the event-store bridge");
  assert.equal(handle.capabilities.durable, true, "persistent-v2 appends are durable");
}

async function testUnknownSelectionRejected(): Promise<void> {
  assert.throws(() => createMemoryBackend({ type: "bogus" }), MemoryBackendSelectionError);
  assert.throws(() => resolveMemoryTypeSelection("bogus"), /unrecognized memory backend type/);
  assert.equal(resolveMemoryTypeSelection(undefined), "persistent");
  assert.equal(resolveMemoryTypeSelection(""), "persistent");
}

async function main(): Promise<void> {
  await testDefaultIsPersistentLegacy();
  await testExplicitSelections();
  await testConcatSelectionIsCompositeOverPersistentAndInMemory();
  await testPersistentV2IsOptIn();
  await testUnknownSelectionRejected();
  console.log("memory-selection.test.ts: OK (factory default=persistent; all selections; persistent-v2 opt-in; unknown rejected)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
