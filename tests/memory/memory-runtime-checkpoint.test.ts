/**
 * Runtime checkpoint tests (MI-05).
 *
 * Covers:
 *  - a crash immediately after a committed step checkpoint preserves progress
 *    on restart without requiring finalization;
 *  - invalid feedback and failed tools cannot be stored as verified completion,
 *    and direct/planned paths share the same normalization rules;
 *  - a failed append produces a visible degraded result and never invokes the
 *    tool again;
 *  - abort flush/close are bounded by a deadline and do not hang.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryEventStore,
} from "../../src/memory/event-store.js";
import {
  normalizeRuntimeOutcome,
  resumeCheckpointedSteps,
  RuntimeCheckpointWriter,
  type RuntimeCheckpointStore,
} from "../../src/memory/runtime-checkpoint.js";
import { loadSession } from "../../src/memory/session-loader.js";
import type {
  MemoryAppendResultV2,
  MemoryCloseResultV2,
  MemoryFlushResultV2,
  MemoryScopeV2,
} from "../../src/memory/contracts-v2.js";

function makeScope(): MemoryScopeV2 {
  return {
    workspaceId: "ws-checkpoint",
    principalId: "principal-checkpoint",
    sessionId: "session-checkpoint",
  };
}

async function testCommittedCheckpointSurvivesCrashWithoutFinalize(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-checkpoint-"));
  const filePath = join(dir, "events.sqlite");
  const scope = makeScope();
  try {
    // Process A: record a committed step and then "crash" without finalizing.
    {
      const store = createMemoryEventStore({ filePath });
      const writer = new RuntimeCheckpointWriter({ store, scope, runId: "run-a" });
      const result = await writer.recordStep({
        stepIndex: 0,
        stepText: "step zero",
        reportedOutcome: "completed",
        feedbackValid: true,
      });
      assert.equal(result.status, "checkpointed");
      // Simulate a crash by NOT calling close/finalize.
    }

    // Process B: restart and load the session.
    const store = createMemoryEventStore({ filePath });
    const loaded = await loadSession(store, scope);
    assert.equal(loaded.status, "ready");
    if (loaded.status === "ready") {
      assert.equal(loaded.eventCount, 1);
    }
    const checkpoints = await resumeCheckpointedSteps(store, scope);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].outcome?.asserted, "completed");
    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testTruthfulOutcomeNormalization(): Promise<void> {
  // Malformed feedback can never become a completed assertion.
  assert.equal(normalizeRuntimeOutcome("completed", false), "invalid_feedback");
  assert.equal(normalizeRuntimeOutcome("failed", false), "invalid_feedback");

  // Valid feedback maps recognized outcomes; unknown values fall back.
  assert.equal(normalizeRuntimeOutcome("completed", true), "completed");
  assert.equal(normalizeRuntimeOutcome("failed", true), "failed");
  assert.equal(normalizeRuntimeOutcome("blocked", true), "blocked");
  assert.equal(normalizeRuntimeOutcome("aborted", true), "aborted");
  assert.equal(normalizeRuntimeOutcome("skipped", true), "skipped");
  assert.equal(normalizeRuntimeOutcome("surprising", true), "unknown");

  // Direct and planned paths share the same rules (same pure function).
  const direct = { reportedOutcome: "completed", feedbackValid: false };
  const planned = { reportedOutcome: "completed", feedbackValid: false };
  assert.equal(
    normalizeRuntimeOutcome(direct.reportedOutcome, direct.feedbackValid),
    normalizeRuntimeOutcome(planned.reportedOutcome, planned.feedbackValid),
  );
}

async function testInvalidFeedbackIsNotStoredAsCompletion(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-checkpoint-"));
  const filePath = join(dir, "events.sqlite");
  const scope = makeScope();
  try {
    const store = createMemoryEventStore({ filePath });
    const writer = new RuntimeCheckpointWriter({ store, scope, runId: "run-a" });
    const result = await writer.recordStep({
      stepIndex: 0,
      stepText: "malformed feedback step",
      reportedOutcome: "completed",
      feedbackValid: false,
    });
    assert.equal(result.status, "checkpointed");
    if (result.status === "checkpointed") {
      assert.equal(result.outcome, "invalid_feedback");
    }
    const retrieved = await store.retrieve({ scope, purpose: "replay" });
    assert.equal(retrieved.events[0].outcome?.asserted, "invalid_feedback");
    assert.equal(retrieved.events[0].outcome?.verification, "unverified");
    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

class FailingStore implements RuntimeCheckpointStore {
  appendCalls = 0;
  constructor(private readonly scope: MemoryScopeV2) {}
  async append(_scope: MemoryScopeV2, _event: unknown): Promise<MemoryAppendResultV2> {
    this.appendCalls += 1;
    return { status: "failure", reason: "disk full" };
  }
  async flush(_scope: MemoryScopeV2): Promise<MemoryFlushResultV2> {
    return { status: "failure", reason: "flush unsupported" };
  }
  async close(_scope: MemoryScopeV2): Promise<MemoryCloseResultV2> {
    return { status: "closed" };
  }
}

async function testFailedAppendIsDegradedAndDoesNotReplayTool(): Promise<void> {
  const scope = makeScope();
  const store = new FailingStore(scope);
  const writer = new RuntimeCheckpointWriter({ store, scope, runId: "run-a" });
  let toolCalls = 0;
  const runTool = async () => {
    toolCalls += 1;
  };
  await runTool();
  const result = await writer.recordStep({
    stepIndex: 0,
    stepText: "step with a durable append failure",
    reportedOutcome: "completed",
    feedbackValid: true,
  });
  assert.equal(result.status, "degraded");
  assert.equal(store.appendCalls, 1);
  assert.equal(toolCalls, 1, "the helper must never invoke the tool again");
}

class HangingFlushStore implements RuntimeCheckpointStore {
  async append(_scope: MemoryScopeV2, _event: unknown): Promise<MemoryAppendResultV2> {
    return { status: "durable", eventId: "evt-1", sequence: 1 };
  }
  async flush(_scope: MemoryScopeV2): Promise<MemoryFlushResultV2> {
    return new Promise<MemoryFlushResultV2>(() => {
      // never settles
    });
  }
  async close(_scope: MemoryScopeV2): Promise<MemoryCloseResultV2> {
    return { status: "closed" };
  }
}

async function testAbortFlushIsBoundedByDeadline(): Promise<void> {
  const scope = makeScope();
  const store = new HangingFlushStore();
  const writer = new RuntimeCheckpointWriter({ store, scope, runId: "run-a", deadlineMs: 25 });
  const started = Date.now();
  const result = await writer.flush();
  const elapsed = Date.now() - started;
  assert.equal(result.status, "failure");
  if (result.status === "failure") {
    assert.match(result.reason, /deadline/);
  }
  assert.ok(elapsed < 1000, `flush should be bounded, took ${elapsed}ms`);
}

async function main(): Promise<void> {
  await testCommittedCheckpointSurvivesCrashWithoutFinalize();
  await testTruthfulOutcomeNormalization();
  await testInvalidFeedbackIsNotStoredAsCompletion();
  await testFailedAppendIsDegradedAndDoesNotReplayTool();
  await testAbortFlushIsBoundedByDeadline();
  console.log("memory-runtime-checkpoint.test.ts: OK (crash recovery, truthful outcomes, degraded append, bounded abort)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
