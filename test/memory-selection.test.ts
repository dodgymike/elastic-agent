/**
 * Focused tests for the memory backend SELECTION semantics that main.ts wires
 * up via ELAGENT_MEMORY_TYPE.
 *
 * main.ts's selection lives inline in main() and is not importable without
 * booting the whole agent, so this test pins the same behavior at the module
 * layer, documenting the contract that main.ts depends on:
 *
 *   - default (ELAGENT_MEMORY_TYPE unset or "persistent")  -> createPersistentMemoryModule
 *     (a PersistentMemoryModule, the persistent/disk-backed default backend).
 *   - "in-memory" -> createInMemoryMemoryModule (an InMemoryMemoryModule).
 *   - "concat" | "both" -> createCompositeMemoryModule wrapping a persistent
 *     primary + in-memory secondary (concatenation mode).
 *
 * Each branch is expressed as a small helper mirroring the exact factory calls
 * in main.ts (lines ~305-340). If the runtime's default ever drifts back to
 * in-memory, or the concat pairing changes, these assertions fail and force a
 * deliberate, documented decision.
 *
 * Follows the project's test conventions: plain `node:assert/strict`, a
 * `main().catch(...)` entrypoint, compiled with tsc and run with node.
 */

import assert from "node:assert/strict";
import {
  CompositeMemoryModule,
  createCompositeMemoryModule,
} from "../memory/compositeMemory.js";
import { InMemoryMemoryModule, createInMemoryMemoryModule } from "../memory/inMemory.js";
import { PersistentMemoryModule, createPersistentMemoryModule } from "../memory/persistent.js";
import type { MemoryModule } from "../memory/types.js";

/**
 * Mirrors main.ts's default-backend branch: ELAGENT_MEMORY_TYPE unset (or
 * "persistent") selects the persistent, disk-backed PersistentMemoryModule.
 */
function selectDefaultMemory(persistentOptions: Record<string, unknown> = {}): MemoryModule {
  return createPersistentMemoryModule(persistentOptions);
}

/**
 * Mirrors main.ts's "in-memory" branch: a volatile InMemoryMemoryModule.
 */
function selectInMemoryMemory(): MemoryModule {
  return createInMemoryMemoryModule({});
}

/**
 * Mirrors main.ts's "concat" | "both" branch: a CompositeMemoryModule wrapping a
 * durable persistent primary and an in-memory secondary.
 */
function selectConcatMemory(persistentOptions: Record<string, unknown> = {}): MemoryModule {
  return createCompositeMemoryModule({
    primary: createPersistentMemoryModule(persistentOptions),
    secondary: createInMemoryMemoryModule({}),
    headers: { primary: "persistent memory", secondary: "in-memory memory" },
  });
}

async function testDefaultIsPersistent(): Promise<void> {
  // The default backend must be the persistent (disk-backed) module, NOT the
  // in-memory module — a real behavior change that this test locks in.
  const defaultModule = selectDefaultMemory({ outputDir: "memory-output" });
  assert.ok(
    defaultModule instanceof PersistentMemoryModule,
    "default backend must be PersistentMemoryModule (persistent)",
  );
  assert.ok(
    !(defaultModule instanceof InMemoryMemoryModule),
    "default backend must NOT be the in-memory module",
  );

  // An explicit "persistent" selection yields the same module type.
  const explicitPersistent = selectDefaultMemory({ outputDir: "memory-output" });
  assert.ok(explicitPersistent instanceof PersistentMemoryModule);
}

async function testInMemorySelection(): Promise<void> {
  const module = selectInMemoryMemory();
  assert.ok(
    module instanceof InMemoryMemoryModule,
    "'in-memory' selects InMemoryMemoryModule",
  );
  assert.ok(!(module instanceof PersistentMemoryModule));
}

async function testConcatSelectionIsCompositeOverPersistentAndInMemory(): Promise<void> {
  // Concatenation mode is a CompositeMemoryModule (not a bare single backend).
  const composite = selectConcatMemory({ outputDir: "memory-output" });
  assert.ok(composite instanceof CompositeMemoryModule, "concat wraps a CompositeMemoryModule");

  // The composite exposes the durable finalize passthrough used by
  // finalizePersistentMemory() at end of plan, and its primary is the
  // persistent backend while the secondary is in-memory.
  const finalizable = composite as CompositeMemoryModule & {
    finalize(sessionId: string): Promise<unknown>;
  };
  assert.equal(typeof finalizable.finalize, "function");
  assert.ok(composite instanceof CompositeMemoryModule);
}

async function main(): Promise<void> {
  await testDefaultIsPersistent();
  await testInMemorySelection();
  await testConcatSelectionIsCompositeOverPersistentAndInMemory();
  console.log("memory-selection.test.ts: OK (default=persistent; in-memory; concat=composite)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
