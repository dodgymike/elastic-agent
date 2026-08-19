/**
 * Memory module index for the elastic-agent runtime.
 *
 * Re-exports the transport-agnostic memory contract (`memory/types.ts`) and
 * every concrete memory backend/factory from a single entry point so callers
 * can import one module instead of reaching into each backend file directly.
 *
 * Backends:
 *  - InMemoryMemoryModule (memory/inMemory.ts)      — volatile in-process store.
 *  - PersistentMemoryModule (memory/persistent.ts)  — durable end-of-plan store.
 *  - GraphMemoryModule (memory/graph-memory.ts)     — graph-backed relational store.
 *  - CompositeMemoryModule (memory/compositeMemory.ts) — concatenation wrapper
 *    (primary + secondary) used in "concatenation mode".
 *
 * Note: existing call sites still import from the individual backend files
 * (e.g. `./memory/inMemory.js`) for backwards compatibility; this index is an
 * additive convenience and does not change their behavior.
 */

export * from "./types.js";

export {
  InMemoryMemoryModule,
  createInMemoryMemoryModule,
  defaultHistorySummarizer,
  mergeContextResults,
} from "./inMemory.js";
export type {
  InMemoryMemoryOptions,
  MemoryEntry,
  MemorySummarizeInput,
  MemorySummarizer,
} from "./inMemory.js";

export {
  PersistentMemoryModule,
  createPersistentMemoryModule,
} from "./persistent.js";
export type {
  PersistentMemoryDocument,
  PersistentMemoryOptions,
  PersistentStepRecord,
} from "./persistent.js";

export { GraphMemoryModule, createGraphMemoryModule } from "./graph-memory.js";

export {
  CompositeMemoryModule,
  createCompositeMemoryModule,
  createConcatenationMemoryModule,
} from "./compositeMemory.js";
export type {
  CompositeContextHeaders,
  CompositeFailureReport,
  CompositeMemoryOptions,
  FinalizableMemoryModule,
} from "./compositeMemory.js";
