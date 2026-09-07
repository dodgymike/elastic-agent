/**
 * MI-14 focused suite: memory health, durability, and efficiency metrics.
 *
 * Covers the four acceptance criteria with injected failures and synthetic
 * sessions:
 *
 *  - a failed durable append stays visible at the runtime boundary even when a
 *    cache/summary projection succeeds;
 *  - a deterministic fake run reconciles summary/compaction attempts and
 *    successful/failed auxiliary LLM requests;
 *  - the diagnostic summary and local report contain no raw remembered content
 *    and never echo session strings as labels;
 *  - counters remain bounded across many sessions and distinguish measured
 *    provider usage from estimates (unknown usage stays unknown, not zero).
 *
 * Follows the project's test conventions: plain `node:assert/strict`, a
 * `main().catch(...)` entrypoint, compiled with tsc and run with node.
 */

import assert from "node:assert/strict";
import {
  MemoryHealthMetrics,
  formatHealthDiagnostic,
  renderLocalHealthReport,
} from "../../src/memory/health-metrics.js";
import { InMemoryMemoryModule } from "../../src/memory/inMemory.js";
import { PersistentV2MemoryModule } from "../../src/memory/persistent-v2.js";
import type { MemoryEventStore } from "../../src/memory/event-store.js";
import type { RememberInput } from "../../src/memory/types.js";

const RAW_CONTENT_SENTINEL = "REMEMBERED-RAW-CONTENT-SENTINEL-42";
const RAW_SESSION_SENTINEL = "user-session-with-raw-content";

function rememberInput(sessionId: string, step = 1): RememberInput {
  return {
    context: { session_id: sessionId, user_id: "u1" },
    actions: [{ name: "Read" }],
    outcome: "completed",
    timestamp: "2025-01-01T00:00:00.000Z",
    extra: { step },
  };
}

/** A fake event store that always fails appends (durability failure). */
function failingStore(): MemoryEventStore {
  const store = {
    async append() {
      return { status: "failure", reason: "disk full" } as const;
    },
    async retrieve() {
      return { scope: { workspaceId: "ws", principalId: "p", sessionId: "s1" }, revision: 0, events: [], evidenceRefs: [], degraded: false } as const;
    },
    async initialize(scope: { workspaceId: string; principalId: string; sessionId: string }) {
      return { status: "ready", scope } as const;
    },
    async flush() {
      return { status: "durable", revision: 1 } as const;
    },
    async close() {
      return { status: "closed" } as const;
    },
  };
  return store as unknown as MemoryEventStore;
}

/** A fake event store whose appends succeed with a deterministic sequence. */
function durableStore(): MemoryEventStore {
  let sequence = 0;
  const store = {
    async append(_scope: unknown, event: { eventId: string }) {
      sequence += 1;
      return { status: "durable", eventId: event.eventId, sequence } as const;
    },
    async retrieve() {
      return { scope: { workspaceId: "ws", principalId: "p", sessionId: "s1" }, revision: 0, events: [], evidenceRefs: [], degraded: false } as const;
    },
    async initialize(scope: { workspaceId: string; principalId: string; sessionId: string }) {
      return { status: "ready", scope } as const;
    },
    async flush() {
      return { status: "durable", revision: sequence } as const;
    },
    async close() {
      return { status: "closed" } as const;
    },
  };
  return store as unknown as MemoryEventStore;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function testSnapshotShapeAndHealthyState(): Promise<void> {
  const metrics = new MemoryHealthMetrics("persistent-v2", {
    durability: "durable",
    storageSchemaVersion: 2,
  });
  metrics.setInitialized(true);
  metrics.setLastCommittedSequence(3);
  metrics.setPendingSummaryCursor(2);
  metrics.setRetainedConversations(4);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.backendType, "persistent-v2");
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.lastCommittedSequence, 3);
  assert.equal(snapshot.pendingSummaryCursor, 2);
  assert.equal(snapshot.durability, "durable");
  assert.equal(snapshot.storageSchemaVersion, 2);
  assert.equal(snapshot.state, "healthy");
  assert.equal(snapshot.counters.retainedConversations, 4);
}

async function testScopedFailuresSurviveUnrelatedSuccess(): Promise<void> {
  const metrics = new MemoryHealthMetrics("persistent-v2", { durability: "durable" });

  metrics.recordAppend({ status: "failure", sessionId: "s-a", reason: "disk full" });
  let snapshot = metrics.snapshot();
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.lastFailure?.operation, "append");
  assert.equal(snapshot.lastFailure?.sessionId, "s-a");

  // A summary/cache success must not clear the scoped append failure.
  metrics.recordSummaryAttempt(true);
  metrics.recordCompactionAttempt({});
  snapshot = metrics.snapshot();
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.lastFailure?.operation, "append");
  assert.equal(snapshot.counters.summaryAttempts, 1);
  assert.equal(snapshot.counters.compactionAttempts, 1);

  // Recovery of the same operation clears the failure and returns to healthy.
  metrics.recordAppend({ status: "durable", sessionId: "s-a", sequence: 1 });
  snapshot = metrics.snapshot();
  assert.equal(snapshot.state, "healthy");
  assert.equal(snapshot.lastFailure, null);
  assert.equal(snapshot.counters.appendDurable, 1);
  assert.equal(snapshot.counters.appendFailed, 1);
}

async function testRecallFailedAndNoRelevantMemoryAreDistinct(): Promise<void> {
  const metrics = new MemoryHealthMetrics("persistent-v2", { durability: "durable" });

  metrics.recordRetrieval({
    success: true,
    sessionId: "s1",
    cacheHit: false,
    candidates: 0,
    selected: 0,
    omitted: 0,
    hasMemory: false,
  });
  assert.equal(metrics.snapshot().state, "no-relevant-memory");

  metrics.recordRetrieval({ success: false, sessionId: "s1", reason: "retrieval failed" });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.state, "recall-failed");
  assert.equal(snapshot.counters.retrievalFailed, 1);
  assert.equal(snapshot.lastFailure?.operation, "retrieval");
}

async function testFailedDurableAppendVisibleDespiteCacheSuccess(): Promise<void> {
  const cache = new InMemoryMemoryModule();
  const module = new PersistentV2MemoryModule({
    store: failingStore(),
    delegate: cache,
    workspacePath: process.cwd(),
  });

  await module.remember(rememberInput("s1", 1));

  // The cache/summary projection succeeded, but the durable append failed.
  assert.equal(cache.countForSession("s1"), 1, "cache projection received the step");
  const snapshot = module.healthSnapshot();
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.counters.appendFailed, 1);
  assert.equal(snapshot.lastFailure?.operation, "append");
  assert.equal(snapshot.lastFailure?.sessionId, "s1");

  // A recovered append on a healthy store clears the scoped failure.
  const recovered = new PersistentV2MemoryModule({
    store: durableStore(),
    workspacePath: process.cwd(),
  });
  await recovered.remember(rememberInput("s1", 1));
  const recoveredSnapshot = recovered.healthSnapshot();
  assert.equal(recoveredSnapshot.state, "healthy");
  assert.equal(recoveredSnapshot.counters.appendDurable, 1);
  assert.equal(recoveredSnapshot.lastCommittedSequence, 1);
}

async function testReconcilesSummaryCompactionAndLlmRequests(): Promise<void> {
  const metrics = new MemoryHealthMetrics("persistent-v2", { durability: "durable" });

  metrics.recordSummaryAttempt(true);
  metrics.recordSummaryAttempt(true);
  metrics.recordSummaryAttempt(false);
  metrics.recordCompactionAttempt({ cancelled: true });
  metrics.recordCompactionAttempt({ stale: true });
  metrics.recordCompactionAttempt({});

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
    correlationId: "corr-1",
    purpose: "summary",
    provider: "fake",
    model: "fake-model",
    attempt: 2,
    succeeded: false,
    durationMs: 5,
    usage: { measured: true, inputTokens: 100 },
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

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.summaryAttempts, 3);
  assert.equal(snapshot.counters.summaryFailed, 1);
  assert.equal(snapshot.counters.compactionAttempts, 3);
  assert.equal(snapshot.counters.compactionCancelled, 1);
  assert.equal(snapshot.counters.staleResults, 1);

  assert.equal(snapshot.llmRequestSummary.total, 4);
  assert.equal(snapshot.llmRequestSummary.succeeded, 2);
  assert.equal(snapshot.llmRequestSummary.failed, 2);
  assert.equal(snapshot.llmRequestSummary.measured, 2);
  assert.equal(snapshot.llmRequestSummary.estimated, 1);
  assert.equal(snapshot.llmRequestSummary.unknown, 1, "unknown usage stays unknown, not zero");

  // The unknown-usage record must not fabricate zero token fields.
  const unknownRecord = snapshot.llmRequests.find((record) => record.correlationId === "corr-3");
  assert.ok(unknownRecord);
  assert.equal(unknownRecord.usage.measured, false);
  assert.equal("inputTokens" in unknownRecord.usage, false);
  assert.equal("estimatedInputTokens" in unknownRecord.usage, false);
}

async function testMetricsAndReportContainNoRawContentOrSessionStrings(): Promise<void> {
  const metrics = new MemoryHealthMetrics("persistent-v2", { durability: "durable" });
  metrics.recordFailure("append", RAW_SESSION_SENTINEL, `${RAW_CONTENT_SENTINEL} disk full`);

  const diagnostic = formatHealthDiagnostic(metrics.snapshot());
  assert.equal(diagnostic.includes(RAW_CONTENT_SENTINEL), false, "diagnostic never carries raw content");
  assert.equal(diagnostic.includes(RAW_SESSION_SENTINEL), false, "diagnostic never carries session strings");

  const report = renderLocalHealthReport([
    {
      sessionId: RAW_SESSION_SENTINEL,
      appendCount: 1,
      inputTokens: 120,
      retrievalCandidates: 4,
      retrievalSelected: 2,
      summaryAttempts: 1,
      compactionAttempts: 0,
      llmRequestCount: 1,
      totalLlmDurationMs: 10,
    },
  ]);
  assert.equal(report.includes(RAW_SESSION_SENTINEL), false, "report never echoes session ids");
  assert.equal(report.includes(RAW_CONTENT_SENTINEL), false, "report never carries raw content");
  assert.match(report, /inputGrowth=120/);
  assert.match(report, /retrievalEffectiveness=50\.0%/);
  assert.match(report, /totalLlmLatency=10ms/);
}

async function testCountersBoundedAcrossManySessions(): Promise<void> {
  const metrics = new MemoryHealthMetrics("persistent-v2", {
    durability: "durable",
    maxLlmRequests: 5,
  });

  for (let index = 0; index < 10; index += 1) {
    metrics.recordLlmRequest({
      correlationId: `corr-${index}`,
      purpose: "summary",
      provider: "fake",
      model: "fake-model",
      attempt: 1,
      succeeded: true,
      durationMs: 1,
      usage: { measured: false, estimatedInputTokens: 10 },
    });
  }
  assert.equal(metrics.snapshot().llmRequests.length, 5, "LLM request records stay bounded");

  for (let index = 0; index < 1000; index += 1) {
    metrics.recordAppend({ status: "durable", sessionId: `session-${index}`, sequence: index + 1 });
  }
  // One final failure is retained as the scoped latest failure; counters are
  // plain numbers and never grow per-session labels.
  metrics.recordAppend({ status: "failure", sessionId: "session-999", reason: "disk full" });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.appendAttempts, 1001);
  assert.equal(snapshot.counters.appendDurable, 1000);
  assert.equal(snapshot.counters.appendFailed, 1);
  assert.equal(snapshot.lastFailure?.sessionId, "session-999");
  assert.equal(snapshot.llmRequests.length, 5, "many sessions do not grow the LLM ring");
  assert.equal(snapshot.llmRequestSummary.total, 10);
}

async function main(): Promise<void> {
  await testSnapshotShapeAndHealthyState();
  await testScopedFailuresSurviveUnrelatedSuccess();
  await testRecallFailedAndNoRelevantMemoryAreDistinct();
  await testFailedDurableAppendVisibleDespiteCacheSuccess();
  await testReconcilesSummaryCompactionAndLlmRequests();
  await testMetricsAndReportContainNoRawContentOrSessionStrings();
  await testCountersBoundedAcrossManySessions();
  console.log("memory-health.test.ts: OK (health snapshot, scoped failures, bounded metrics, local report)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
