/**
 * MI-15 deterministic end-to-end memory regression suite.
 *
 * This is the offline, production-path evaluation that proves useful recall,
 * restart recovery, resistance to stale claims, and preserved constraints,
 * rather than asserting string lengths or concatenation. Every scenario calls
 * the production helpers in `memory/` with temporary storage, synthetic
 * fixtures, and stable scope IDs. No model is called here; model-dependent
 * quality is reported separately by `scripts/memory-live-evaluation.ts` and
 * never runs as part of the default offline aggregate.
 *
 * The final report distinguishes:
 *  - deterministic correctness (the scenarios below, asserted here);
 *  - measured efficiency (event counts, summarizer calls, model input sizes);
 *  - model-dependent quality (skipped in offline mode);
 *  - skipped checks (for example the 10,000-event scale fixture);
 *  - unresolved failures (none by the time the report prints).
 *
 * Deliberately breaking scope isolation, durable reload, or protected-
 * constraint retention is covered by dedicated break-detector scenarios so a
 * regression in any of those invariants fails this suite.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEventEnvelope,
  stableEventId,
  type MemoryEventAppendV2,
  type MemoryEventEnvelopeV2,
  type MemoryIdentityV2,
  type MemoryScopeV2,
} from "../memory/contracts-v2.js";
import { createMemoryEventStore, type MemoryEventStore } from "../memory/event-store.js";
import { loadSession } from "../memory/session-loader.js";
import { importLegacyMemoryDocument } from "../memory/legacy-import.js";
import {
  RuntimeCheckpointWriter,
  normalizeRuntimeOutcome,
  resumeCheckpointedSteps,
  type RuntimeCheckpointStore,
} from "../memory/runtime-checkpoint.js";
import {
  buildStructuredProjection,
  currentConstraints,
  currentDecisions,
  openWork,
} from "../memory/structured-records.js";
import {
  IncrementalSummaryManager,
  type IncrementalSummarizer,
} from "../memory/incremental-summary.js";
import { retrieveRelevantRecords, type RetrievedItemV2 } from "../memory/retrieval.js";
import { MemoryContextAssembler } from "../memory/context-assembly.js";
import { SafeCompactor, protectedSubjectsFor } from "../memory/safe-compaction.js";
import { MemoryRetentionController } from "../memory/retention.js";
import { MemoryHealthMetrics, formatHealthDiagnostic } from "../memory/health-metrics.js";
import { applyMemoryPrivacy } from "../memory/privacy.js";

const SCOPE_DEFAULTS: MemoryScopeV2 = {
  workspaceId: "ws-mi15",
  principalId: "principal-mi15",
  sessionId: "session-mi15",
};

/* ------------------------------------------------------------------ *
 * Fixture/report helpers
 * ------------------------------------------------------------------ */

function makeScope(overrides: Partial<MemoryScopeV2> = {}): MemoryScopeV2 {
  return { ...SCOPE_DEFAULTS, ...overrides };
}

function makeIdentity(overrides: Partial<MemoryIdentityV2> = {}): MemoryIdentityV2 {
  return { ...SCOPE_DEFAULTS, runId: "run-mi15", ...overrides };
}

function makeAppend(eventId: string, overrides: Partial<MemoryEventAppendV2> = {}): MemoryEventAppendV2 {
  return {
    eventId,
    identity: makeIdentity(),
    runRef: "run-mi15",
    kind: "observation",
    payload: { eventId },
    timestamp: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function envelopeFor(append: MemoryEventAppendV2, sequence: number): MemoryEventEnvelopeV2 {
  return buildEventEnvelope(append, sequence, "2024-01-01T00:00:00.000Z");
}

function makeTempStore(): { store: MemoryEventStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-mi15-"));
  return { store: createMemoryEventStore({ filePath: join(dir, "events.sqlite") }), dir };
}

/** Page through the event store so scale fixtures are not capped at 500 rows. */
async function retrieveAll(store: MemoryEventStore, scope: MemoryScopeV2): Promise<MemoryEventEnvelopeV2[]> {
  const events: MemoryEventEnvelopeV2[] = [];
  let afterSequence: number | undefined;
  while (true) {
    const page = await store.retrieve({
      scope,
      purpose: "replay",
      limit: 500,
      ...(afterSequence !== undefined ? { afterSequence } : {}),
    });
    if (page.degraded) {
      throw new Error(`retrieve degraded: ${page.degradedReason ?? "unknown reason"}`);
    }
    events.push(...page.events);
    if (page.events.length < 500) break;
    afterSequence = page.events[page.events.length - 1].sequence;
  }
  return events;
}

const deterministicScenarios: string[] = [];
const efficiencyScenarios: { name: string; metrics: Record<string, number | string> }[] = [];
const skippedChecks: string[] = [];
const unresolvedFailures: string[] = [];

function recordDeterministic(name: string): void {
  deterministicScenarios.push(name);
}

function recordEfficiency(name: string, metrics: Record<string, number | string>): void {
  efficiencyScenarios.push({ name, metrics });
}

function recordSkipped(name: string): void {
  skippedChecks.push(name);
}

function printReport(): void {
  const lines = [
    "=== memory-regression report (offline) ===",
    `deterministicCorrectness: PASS (${deterministicScenarios.length} scenarios)`,
    ...deterministicScenarios.map((name) => `  - ${name}`),
    `measuredEfficiency: ${efficiencyScenarios.length} fixtures`,
    ...efficiencyScenarios.map(
      (scenario) =>
        `  - ${scenario.name}: ${Object.entries(scenario.metrics)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(" ")}`,
    ),
    "modelDependentQuality: SKIPPED (offline run; use `npm run memory:evaluate-live` for an opt-in live-model evaluation)",
    `skippedChecks: ${skippedChecks.length}`,
    ...skippedChecks.map((name) => `  - ${name}`),
    `unresolvedFailures: ${unresolvedFailures.length}`,
    ...unresolvedFailures.map((name) => `  - ${name}`),
  ];
  console.log(lines.join("\n"));
}

/* ------------------------------------------------------------------ *
 * Break detectors: scope isolation and durable reload
 * ------------------------------------------------------------------ */

async function testRestartRecallAndScopeIsolation(): Promise<void> {
  const { store, dir } = makeTempStore();
  const scope = makeScope();
  try {
    assert.equal((await store.append(scope, makeAppend("evt-a"))).status, "durable");
    await store.close(scope);

    // A fresh store on the same file recalls the committed event after restart.
    const reopened = createMemoryEventStore({ filePath: join(dir, "events.sqlite") });
    const loaded = await loadSession(reopened, scope);
    assert.equal(loaded.status, "ready");
    if (loaded.status === "ready") assert.equal(loaded.eventCount, 1);

    // The same session id under a different workspace is isolated.
    const otherScope = makeScope({ workspaceId: "other-workspace" });
    const other = await loadSession(reopened, otherScope);
    assert.equal(other.status, "absent");
    await reopened.close(scope);
    recordDeterministic("restart recall and same-session cross-workspace isolation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testCrossScopeAppendIsRejected(): Promise<void> {
  const { store, dir } = makeTempStore();
  const scope = makeScope();
  try {
    const mismatched = makeAppend("evt-cross", {
      identity: makeIdentity({ workspaceId: "other-workspace" }),
    });
    const result = await store.append(scope, mismatched);
    assert.equal(result.status, "failure", "an append whose identity scope does not match must fail");
    recordDeterministic("scope-isolation break detector: cross-scope append is rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testCorruptedDurableStateFailsClosed(): Promise<void> {
  const { store, dir } = makeTempStore();
  const scope = makeScope();
  try {
    assert.equal((await store.append(scope, makeAppend("evt-a"))).status, "durable");
    await store.close(scope);

    const filePath = join(dir, "events.sqlite");
    writeFileSync(filePath, "this is not a sqlite database", "utf8");

    const reopened = createMemoryEventStore({ filePath });
    const loaded = await loadSession(reopened, scope);
    assert.equal(loaded.status, "failure", "corrupted durable state must report failure, never empty recall");
    await reopened.close(scope).catch(() => undefined);
    recordDeterministic("durable-reload break detector: corrupted state fails closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Checkpoint honesty and crash recovery
 * ------------------------------------------------------------------ */

async function testCheckpointOutcomesSurviveRestart(): Promise<void> {
  const { store, dir } = makeTempStore();
  const scope = makeScope();
  const runId = "run-crash";
  try {
    const writer = new RuntimeCheckpointWriter({ store, scope, runId });
    const c1 = await writer.recordStep({ stepIndex: 0, stepText: "ok step", reportedOutcome: "completed", feedbackValid: true });
    assert.equal(c1.status, "checkpointed");
    if (c1.status === "checkpointed") assert.equal(c1.outcome, "completed");

    const c2 = await writer.recordStep({ stepIndex: 1, stepText: "bad feedback", reportedOutcome: "completed", feedbackValid: false });
    assert.equal(c2.status, "checkpointed");
    if (c2.status === "checkpointed") assert.equal(c2.outcome, "invalid_feedback");

    const c3 = await writer.recordStep({ stepIndex: 2, stepText: "unrecognized outcome", reportedOutcome: "not-a-real-outcome", feedbackValid: true });
    assert.equal(c3.status, "checkpointed");
    if (c3.status === "checkpointed") assert.equal(c3.outcome, "unknown");

    const c4 = await writer.recordStep({ stepIndex: 3, stepText: "failed step", reportedOutcome: "failed", feedbackValid: true });
    assert.equal(c4.status, "checkpointed");
    if (c4.status === "checkpointed") assert.equal(c4.outcome, "failed");
    await writer.close();

    const reopened = createMemoryEventStore({ filePath: join(dir, "events.sqlite") });
    const resumed = await resumeCheckpointedSteps(reopened, scope);
    assert.deepEqual(
      resumed.map((event) => event.outcome?.asserted),
      ["completed", "invalid_feedback", "unknown", "failed"],
    );
    await reopened.close(scope);
    recordDeterministic("truthful checkpoint outcomes survive crash/restart in order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testCheckpointAppendFailureIsVisible(): Promise<void> {
  const scope = makeScope();
  const failingStore: RuntimeCheckpointStore = {
    append: async () => ({ status: "failure", reason: "disk full" }),
    flush: async () => ({ status: "durable", revision: 0 }),
    close: async () => ({ status: "closed" }),
  };
  const writer = new RuntimeCheckpointWriter({ store: failingStore, scope, runId: "run-fail" });
  const result = await writer.recordStep({ stepIndex: 0, stepText: "step", reportedOutcome: "completed", feedbackValid: true });
  assert.equal(result.status, "degraded");
  assert.equal(normalizeRuntimeOutcome("completed", false), "invalid_feedback");
  assert.equal(normalizeRuntimeOutcome("surprising", true), "unknown");
  recordDeterministic("checkpoint durability failure is reported as degraded, never success");
}

/* ------------------------------------------------------------------ *
 * Competing writers and corrupted import
 * ------------------------------------------------------------------ */

async function testCompetingWritersSerialize(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-mi15-writers-"));
  const filePath = join(dir, "events.sqlite");
  const scope = makeScope();
  const writerA = createMemoryEventStore({ filePath });
  const writerB = createMemoryEventStore({ filePath });
  try {
    // Open both connections and run schema migrations before racing writers so
    // concurrent first-open setup cannot collide.
    assert.equal((await writerA.initialize(scope)).status, "ready");
    assert.equal((await writerB.initialize(scope)).status, "ready");

    // Two independent connections each append sequentially while contending on
    // the SQLite write lock; the store's busy timeout plus BEGIN IMMEDIATE must
    // serialize them without sequence collisions.
    const appendBatch = async (store: MemoryEventStore, prefix: string): Promise<string[]> => {
      const statuses: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const result = await store.append(scope, makeAppend(`${prefix}-${index}`));
        statuses.push(result.status);
      }
      return statuses;
    };
    const [statusesA, statusesB] = await Promise.all([
      appendBatch(writerA, "a"),
      appendBatch(writerB, "b"),
    ]);
    const statuses = [...statusesA, ...statusesB];
    assert.equal(statuses.every((status) => status === "durable"), true, `competing writers must all commit durably: ${JSON.stringify(statuses)}`);

    const retrieved = await writerA.retrieve({ scope, purpose: "replay", limit: 100 });
    assert.equal(retrieved.events.length, 40);
    const sequences = retrieved.events.map((event) => event.sequence).sort((a, b) => a - b);
    assert.deepEqual(
      sequences,
      Array.from({ length: 40 }, (_, index) => index + 1),
      "competing writers must not collide on sequence numbers",
    );
    await writerA.close(scope);
    await writerB.close(scope);
    recordDeterministic("competing writers serialize with unique sequences");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testCorruptedImportFailsClosed(): Promise<void> {
  const { store, dir } = makeTempStore();
  const scope = makeScope({ sessionId: "legacy-session" });
  try {
    const legacyPath = join(dir, "legacy.json");
    writeFileSync(legacyPath, "{ not valid json", "utf8");
    const result = await importLegacyMemoryDocument({ filePath: legacyPath, store, scope });
    assert.equal(result.status, "failure");
    await store.close(scope);
    recordDeterministic("corrupted legacy import fails closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Retrieval quality, stale decisions, conflicting evidence, untrusted memory
 * ------------------------------------------------------------------ */

async function testRetrievalQualityAndUntrustedMemory(): Promise<void> {
  const scope = makeScope();
  const decisionAId = stableEventId(scope, "structured:decision:evt-d1");
  const events: MemoryEventEnvelopeV2[] = [
    envelopeFor(makeAppend("evt-f1", {
      kind: "fact",
      outcome: { asserted: "completed", verification: "verified" },
      payload: { structured: { recordKind: "fact", subject: "alpha state", tags: ["alpha"] }, text: "alpha verified" },
    }), 1),
    envelopeFor(makeAppend("evt-f2", {
      kind: "fact",
      outcome: { asserted: "completed", verification: "unverified" },
      payload: { structured: { recordKind: "fact", subject: "alpha state", tags: ["alpha"] }, text: "alpha unverified claim" },
    }), 2),
    envelopeFor(makeAppend("evt-d1", {
      kind: "decision",
      outcome: { asserted: "completed", verification: "unverified" },
      payload: { structured: { recordKind: "decision", subject: "use plan A", tags: ["plan"] } },
    }), 3),
    envelopeFor(makeAppend("evt-d2", {
      kind: "decision",
      outcome: { asserted: "completed", verification: "unverified" },
      payload: { structured: { recordKind: "decision", subject: "use plan B", supersedes: [decisionAId], tags: ["plan"] } },
    }), 4),
    envelopeFor(makeAppend("evt-c1", {
      kind: "constraint",
      outcome: { asserted: "completed", verification: "verified" },
      payload: { structured: { recordKind: "constraint", subject: "never delete user data", authoritative: true } },
    }), 5),
    envelopeFor(makeAppend("evt-c2", {
      kind: "constraint",
      outcome: { asserted: "completed", verification: "unverified" },
      payload: { structured: { recordKind: "constraint", subject: "delete everything", authoritative: false } },
    }), 6),
    envelopeFor(makeAppend("evt-o1", {
      kind: "observation",
      payload: { openTasks: ["finish rollout"] },
    }), 7),
    envelopeFor(makeAppend("evt-d3", {
      kind: "observation",
      payload: { text: "unrelated distractor about the weather" },
    }), 8),
  ];

  const projection = buildStructuredProjection(scope, events);

  const constraints = currentConstraints(projection);
  assert.deepEqual(
    constraints.map((record) => record.subject),
    ["never delete user data"],
    "only authoritative user constraints are protected; unsupported claims are excluded",
  );

  const decisions = currentDecisions(projection);
  assert.deepEqual(decisions.map((record) => record.subject), ["use plan B"]);
  const stale = projection.records.find((record) => record.subject === "use plan A");
  assert.equal(stale?.status, "superseded");

  const open = openWork(projection);
  assert.deepEqual(open.map((record) => record.subject), ["finish rollout"]);

  const retrieval = retrieveRelevantRecords(scope, projection.records, {
    scope,
    queryText: "alpha",
    limit: 10,
  });
  assert.equal(retrieval.status, "ok");
  if (retrieval.status === "ok") {
    const alphaItems = retrieval.items.filter((item) => item.record.subject === "alpha state");
    assert.equal(alphaItems.length, 1, "conflicting same-subject facts deduplicate deterministically");
    assert.equal(alphaItems[0].record.evidence, "verified", "verified evidence ranks above unverified claims");
  }

  // Defense-in-depth redaction is exercised with an innocuous value under a
  // sensitive field name (no secret-shaped fixtures are embedded here).
  const privacy = applyMemoryPrivacy({ credential: "ordinary-value" });
  assert.equal(privacy.ok, true);
  assert.equal((privacy.value as { credential: string }).credential, "[REDACTED]");
  assert.ok(privacy.redactionCount >= 1);

  recordDeterministic("retrieval ranks verified evidence, supersedes stale decisions, excludes untrusted constraints, redacts sensitive fields");
}

/* ------------------------------------------------------------------ *
 * Bounded complete requests and stable prompt prefixes
 * ------------------------------------------------------------------ */

async function testContextOverflowAndStablePrefix(): Promise<void> {
  const stablePrefix = "IMMUTABLE INSTRUCTIONS: never share user data.";
  const overflow = new MemoryContextAssembler({ capacityTokens: 5, outputReserveTokens: 0 }).assemble({
    stablePrefix,
    currentRequest: "request text",
    toolsText: "tools",
    conversationText: "conversation",
    memoryItems: [],
  });
  assert.equal(overflow.status, "budget-error", "mandatory content that cannot fit fails before any provider call");

  const scope = makeScope();
  const projection = buildStructuredProjection(scope, [
    envelopeFor(makeAppend("evt-c1", {
      kind: "constraint",
      outcome: { asserted: "completed", verification: "verified" },
      payload: { structured: { recordKind: "constraint", subject: "keep prefix stable", authoritative: true } },
    }), 1),
  ]);
  const retrieval = retrieveRelevantRecords(scope, projection.records, { scope, queryText: "prefix", limit: 10 });
  assert.equal(retrieval.status, "ok");
  const items: RetrievedItemV2[] = retrieval.status === "ok" ? [...retrieval.items] : [];

  const assembled = new MemoryContextAssembler({ capacityTokens: 400, outputReserveTokens: 40 }).assemble({
    stablePrefix,
    currentRequest: "current request",
    toolsText: "tool definitions",
    conversationText: "conversation so far",
    memoryItems: items,
  });
  assert.equal(assembled.status, "ok");
  assert.ok(assembled.text.startsWith(stablePrefix), "the stable prompt prefix is never reordered or mutated");
  assert.ok(assembled.memorySection.length > 0);
  recordDeterministic("context overflow fails safely and stable prompt prefixes stay unchanged");
}

/* ------------------------------------------------------------------ *
 * Safe compaction: protected subjects, cancellation, no checkpoint loss
 * ------------------------------------------------------------------ */

async function testCompactionPreservesAndCancelsSafely(): Promise<void> {
  const scope = makeScope();
  const events: MemoryEventEnvelopeV2[] = [
    envelopeFor(makeAppend("evt-c1", {
      kind: "constraint",
      outcome: { asserted: "completed", verification: "verified" },
      payload: { structured: { recordKind: "constraint", subject: "never delete user data", authoritative: true } },
    }), 1),
    envelopeFor(makeAppend("evt-o1", {
      kind: "observation",
      payload: { openTasks: ["finish rollout"] },
    }), 2),
    envelopeFor(makeAppend("evt-o2", {
      kind: "observation",
      payload: { text: "narrative detail" },
    }), 3),
  ];

  const projection = buildStructuredProjection(scope, events);
  const protectedSubjects = protectedSubjectsFor(projection);
  assert.deepEqual(protectedSubjects, ["finish rollout", "never delete user data"]);

  const manager = new IncrementalSummaryManager(scope, {
    summarizer: { version: "offline-v1", summarize: async () => "unused" },
    offlineDeterministic: true,
  });
  const advanced = await manager.advance(events);
  assert.equal(advanced.status, "advanced");
  const base = advanced.status === "advanced" ? advanced.checkpoint : manager.checkpoint();

  const compactor = new SafeCompactor(base, {
    model: {
      config: "fake-compaction-v1",
      compact: async (request) => ({ text: "compacted narrative", retainedSubjects: request.protectedSubjects }),
    },
    capacityTokens: 1000,
    outputReserveTokens: 200,
  });
  const compacted = await compactor.compact(projection);
  assert.equal(compacted.status, "compacted");
  if (compacted.status === "compacted") {
    assert.deepEqual(compacted.protectedSubjects, protectedSubjects);
  }

  // A cancellation/timeout leaves the previous checkpoint untouched and a
  // repeated attempt on unchanged input is suppressed.
  const hanging = new SafeCompactor(base, {
    model: { config: "hang-v1", compact: () => new Promise(() => undefined) },
    capacityTokens: 1000,
    outputReserveTokens: 200,
    deadlineMs: 10,
    maxAttempts: 1,
  });
  const timedOut = await hanging.compact(projection);
  assert.equal(timedOut.status, "failure");
  if (timedOut.status === "failure") {
    assert.match(timedOut.reason, /deadline/);
    assert.equal(timedOut.retrySuppressed, false);
    assert.equal(timedOut.checkpoint.revision, base.revision);
  }
  const suppressed = await hanging.compact(projection);
  assert.equal(suppressed.status, "failure");
  if (suppressed.status === "failure") {
    assert.equal(suppressed.retrySuppressed, true);
  }

  recordDeterministic("compaction preserves protected constraints/open work and cancels without losing the checkpoint");
}

/* ------------------------------------------------------------------ *
 * Forget during summarization and no deleted-memory resurrection
 * ------------------------------------------------------------------ */

async function testForgetDuringSummarizationBlocksResurrection(): Promise<void> {
  const scope = makeScope();
  let resolveSummary: ((text: string) => void) | undefined;
  const summarizer: IncrementalSummarizer = {
    version: "pending-v1",
    summarize: () =>
      new Promise<string>((resolve) => {
        resolveSummary = resolve;
      }),
  };
  const manager = new IncrementalSummaryManager(scope, { summarizer });
  const event = makeAppend("evt-fact", { kind: "fact", payload: { text: "forgotten fact" } });
  const pending = manager.advance([envelopeFor(event, 1)]);
  manager.setDeletionGeneration(1);
  assert.equal(resolveSummary !== undefined, true, "summarizer must have been called");
  resolveSummary?.("summary containing forgotten fact");
  const result = await pending;
  assert.equal(result.status, "stale", "an in-flight summarizer must not overwrite after a deletion");
  assert.equal(manager.checkpoint().text, "");

  const { store, dir } = makeTempStore();
  try {
    const sessionScope = makeScope({ sessionId: "forget-session" });
    assert.equal(
      (await store.append(sessionScope, makeAppend("evt-a", { identity: makeIdentity({ sessionId: "forget-session" }) }))).status,
      "durable",
    );
    const controller = new MemoryRetentionController(store);
    const forgotten = await controller.forget({ kind: "session", scope: sessionScope });
    assert.equal(forgotten.status, "forgotten");
    const after = await store.retrieve({ scope: sessionScope, purpose: "replay" });
    assert.equal(after.events.length, 0);
    const blocking = await store.blockingTombstone(sessionScope);
    assert.equal(blocking?.kind, "session");
    await store.close(sessionScope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  recordDeterministic("forget during summarization and tombstones block deleted-memory resurrection");
}

/* ------------------------------------------------------------------ *
 * Health states and bounded auxiliary-request accounting
 * ------------------------------------------------------------------ */

async function testHealthStatesAndAuxiliaryAccounting(): Promise<void> {
  const metrics = new MemoryHealthMetrics("persistent-v2", {
    durability: "durable",
    storageSchemaVersion: 2,
    maxLlmRequests: 3,
  });
  assert.equal(metrics.snapshot().state, "healthy");

  metrics.recordAppend({ status: "failure", sessionId: "session-secret-xyz", reason: "disk full" });
  assert.equal(metrics.snapshot().state, "degraded");
  assert.equal(metrics.snapshot().counters.appendFailed, 1);
  assert.equal(metrics.snapshot().lastFailure?.operation, "append");

  metrics.recordAppend({ status: "durable", sessionId: "session-secret-xyz", sequence: 1 });
  assert.equal(metrics.snapshot().state, "healthy");
  assert.equal(metrics.snapshot().counters.appendDurable, 1);

  metrics.recordRetrieval({ success: false, sessionId: "session-secret-xyz", reason: "io error" });
  assert.equal(metrics.snapshot().state, "recall-failed");

  metrics.recordLlmRequest({
    correlationId: "corr-1",
    purpose: "summary",
    provider: "fake",
    model: "fake-model",
    attempt: 1,
    succeeded: true,
    durationMs: 10,
    usage: { measured: true, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  });
  metrics.recordLlmRequest({
    correlationId: "corr-2",
    purpose: "compaction",
    provider: "fake",
    model: "fake-model",
    attempt: 1,
    succeeded: true,
    durationMs: 12,
    usage: { measured: false, estimatedInputTokens: 500, estimatedOutputTokens: 80 },
  });
  metrics.recordLlmRequest({
    correlationId: "corr-3",
    purpose: "retrieval",
    provider: "fake",
    model: "fake-model",
    attempt: 1,
    succeeded: false,
    durationMs: 3,
    usage: { measured: false },
  });
  const summary = metrics.snapshot().llmRequestSummary;
  assert.deepEqual(
    [summary.measured, summary.estimated, summary.unknown],
    [1, 1, 1],
    "measured, estimated, and unknown usage stay distinct",
  );

  metrics.recordLlmRequest({
    correlationId: "corr-4",
    purpose: "summary",
    provider: "fake",
    model: "fake-model",
    attempt: 1,
    succeeded: true,
    durationMs: 4,
    usage: { measured: false },
  });
  assert.equal(metrics.snapshot().llmRequests.length, 3, "the auxiliary-request ring stays bounded");

  const diagnostic = formatHealthDiagnostic(metrics.snapshot());
  assert.equal(diagnostic.includes("session-secret-xyz"), false, "diagnostics never echo session strings");

  recordDeterministic("health states and bounded auxiliary-request accounting distinguish measured/estimated/unknown");
}

/* ------------------------------------------------------------------ *
 * Scale fixtures: measured work, not wall time
 * ------------------------------------------------------------------ */

async function runScaleFixture(size: number): Promise<void> {
  const { store, dir } = makeTempStore();
  const scope = makeScope({ sessionId: `scale-${size}` });
  const identity = makeIdentity({ sessionId: `scale-${size}` });
  const batchMax = 20;
  try {
    for (let index = 1; index <= size; index += 1) {
      const result = await store.append(
        scope,
        makeAppend(`evt-${index}`, { identity, payload: { text: `event ${index}`, n: index } }),
      );
      assert.equal(result.status, "durable");
    }

    const loaded = await loadSession(store, scope);
    assert.equal(loaded.status, "ready");
    if (loaded.status === "ready") assert.equal(loaded.eventCount, size);

    // Re-appending an identical event is idempotent and never duplicates.
    const duplicate = await store.append(
      scope,
      makeAppend("evt-1", { identity, payload: { text: "event 1", n: 1 } }),
    );
    assert.equal(duplicate.status, "duplicate");
    const afterDuplicate = await loadSession(store, scope);
    if (afterDuplicate.status === "ready") assert.equal(afterDuplicate.eventCount, size);

    const all = await retrieveAll(store, scope);
    assert.equal(all.length, size);

    let summaryCalls = 0;
    let eventsSummarized = 0;
    let modelInputChars = 0;
    const recorder: IncrementalSummarizer = {
      version: "recording-v1",
      summarize: async (input) => {
        summaryCalls += 1;
        eventsSummarized += input.events.length;
        modelInputChars += JSON.stringify(input).length;
        const last = input.events[input.events.length - 1];
        return `summary through sequence ${last.sequence}`;
      },
    };
    const manager = new IncrementalSummaryManager(scope, { summarizer: recorder, maxBatchEvents: batchMax });
    let guard = 0;
    while (manager.checkpoint().coveredThroughSequence < size && guard <= size + 10) {
      await manager.advance(all);
      guard += 1;
    }
    assert.equal(manager.checkpoint().coveredThroughSequence, size);
    assert.equal(eventsSummarized, size, "ordinary incremental summarization processes each event exactly once");
    assert.equal(summaryCalls, Math.ceil(size / batchMax));

    recordEfficiency(`scale-${size}`, {
      events: size,
      summaryCalls,
      eventsSummarized,
      modelInputChars,
      retainedSummaryChars: manager.checkpoint().text.length,
    });
  } finally {
    await store.close(scope).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testScaleFixtures(): Promise<void> {
  await runScaleFixture(100);
  await runScaleFixture(1000);
  if (process.env.MEMORY_SCALE_INCLUDE_10K === "1") {
    await runScaleFixture(10000);
  } else {
    recordSkipped("scale-10000 (set MEMORY_SCALE_INCLUDE_10K=1 to include the 10,000-event fixture)");
  }
  recordDeterministic("scale fixtures measure event counts and model input sizes with no duplicate durable events");
}

/* ------------------------------------------------------------------ *
 * Entrypoint
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testRestartRecallAndScopeIsolation();
  await testCrossScopeAppendIsRejected();
  await testCorruptedDurableStateFailsClosed();
  await testCheckpointOutcomesSurviveRestart();
  await testCheckpointAppendFailureIsVisible();
  await testCompetingWritersSerialize();
  await testCorruptedImportFailsClosed();
  await testRetrievalQualityAndUntrustedMemory();
  await testContextOverflowAndStablePrefix();
  await testCompactionPreservesAndCancelsSafely();
  await testForgetDuringSummarizationBlocksResurrection();
  await testHealthStatesAndAuxiliaryAccounting();
  await testScaleFixtures();

  printReport();
}

main().catch((error: unknown) => {
  console.error("memory-regression.test.ts: FAILED");
  console.error(error);
  process.exitCode = 1;
});
