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

export {
  DEFAULT_CONTEXT_WINDOW,
  MemoryCompactor,
  MEMORY_COMPACTION_THRESHOLD,
  renderMemoryCompactionPrompt,
  shouldCompactMemory,
  validateCompactedSummary,
} from "./memoryCompaction.js";
export type {
  CompactionOutcome,
  CompactionSummaryStore,
  MemoryCompactorOptions,
} from "./memoryCompaction.js";

export {
  MEMORY_EVENT_SCHEMA_VERSION,
  assertScopeMatches,
  buildEventEnvelope,
  canonicalizeWorkspacePath,
  computeEventDigest,
  deriveWorkspaceId,
  freshEventId,
  isJsonSafe,
  parseEventEnvelope,
  resolveLocalPrincipalId,
  resolvePrincipalId,
  scopeFromIdentity,
  scopesEqual,
  serializeEventEnvelope,
  stableEventId,
  validateEventAppend,
  validateEventEnvelope,
  validateIdentity,
  validateOutcome,
  validateRetrievalPurpose,
  validateScope,
} from "./contracts-v2.js";
export type {
  MemoryAppendResultV2,
  MemoryCapabilitiesV2,
  MemoryCloseResultV2,
  MemoryEventAppendV2,
  MemoryEventEnvelopeV2,
  MemoryEventKindV2,
  MemoryFlushResultV2,
  MemoryIdentityV2,
  MemoryInitResultV2,
  MemoryModuleV2,
  MemoryOutcomeAssertionV2,
  MemoryOutcomeV2,
  MemoryRetrieveRequestV2,
  MemoryRetrieveResultV2,
  MemoryRetrievalPurposeV2,
  MemoryScopeV2,
  MemoryVerificationLevelV2,
} from "./contracts-v2.js";

export { LegacyMemoryModuleAdapter, adaptLegacyMemoryModule } from "./legacy-compat.js";

export {
  MEMORY_PRIVACY_POLICY_VERSION,
  UnsafeMemoryStatePathError,
  applyMemoryPrivacy,
  assertSafeMemoryStatePath,
  deriveMemoryTrust,
  isAuthoritativeTrust,
  memoryPrivacyPolicyMetadata,
  redactMemoryText,
  sanitizeMemoryJson,
  validateTrustCategory,
} from "./privacy.js";
export type {
  MemoryPrivacyOptions,
  MemoryPrivacyResult,
  MemoryRecordTrust,
  MemoryTrustCategory,
} from "./privacy.js";
