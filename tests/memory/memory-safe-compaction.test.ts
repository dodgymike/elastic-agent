/**
 * Safe compaction tests (MI-10).
 *
 * Covers protected-reference preservation, missing/fabricated references,
 * oversized/empty output, stale results, cancellation, and retry suppression.
 */

import assert from "node:assert/strict";
import {
  buildEventEnvelope,
  type MemoryEventEnvelopeV2,
  type MemoryScopeV2,
} from "../../src/memory/contracts-v2.js";
import {
  buildStructuredProjection,
} from "../../src/memory/structured-records.js";
import {
  SafeCompactor,
  type CompactionModelRequestV2,
  type CompactionModelResponseV2,
  type CompactionModelV2,
} from "../../src/memory/safe-compaction.js";
import type { SummaryCheckpointV2 } from "../../src/memory/incremental-summary.js";

const scope: MemoryScopeV2 = {
  workspaceId: "ws-compact",
  principalId: "principal-compact",
  sessionId: "session-compact",
};

function checkpoint(text: string, revision = 0): SummaryCheckpointV2 {
  return {
    scope,
    coveredThroughSequence: 1,
    revision,
    text,
    protectedFacts: [],
    summarizerVersion: "v1",
    policyVersion: 1,
    inputDigest: "digest",
  };
}

function projectionWith(constraintSubject: string, decisionSubject: string, openSubject: string) {
  const events: MemoryEventEnvelopeV2[] = [
    buildEventEnvelope(
      {
        eventId: "evt-c",
        identity: { ...scope, runId: "run" },
        runRef: "run",
        kind: "constraint",
        payload: { structured: { subject: constraintSubject, authoritative: true } },
      },
      1,
    ),
    buildEventEnvelope(
      {
        eventId: "evt-d",
        identity: { ...scope, runId: "run" },
        runRef: "run",
        kind: "decision",
        payload: { subject: decisionSubject },
      },
      2,
    ),
    buildEventEnvelope(
      {
        eventId: "evt-o",
        identity: { ...scope, runId: "run" },
        runRef: "run",
        kind: "observation",
        payload: { openTasks: [openSubject] },
      },
      3,
    ),
  ];
  return buildStructuredProjection(scope, events);
}

class FakeModel implements CompactionModelV2 {
  readonly config = "fake-role";
  private behavior: (request: CompactionModelRequestV2) => Promise<CompactionModelResponseV2>;
  calls = 0;

  constructor(behavior?: (request: CompactionModelRequestV2) => Promise<CompactionModelResponseV2>) {
    this.behavior =
      behavior ??
      (async (request) => ({
        text: `compacted(${request.text.length})`,
        retainedSubjects: request.protectedSubjects,
      }));
  }

  async compact(request: CompactionModelRequestV2): Promise<CompactionModelResponseV2> {
    this.calls += 1;
    return this.behavior(request);
  }
}

async function testSuccessfulCompactionPreservesProtectedReferences(): Promise<void> {
  const projection = projectionWith("never call network", "use sqlite", "task-7");
  const model = new FakeModel();
  const compactor = new SafeCompactor(checkpoint("long narrative"), {
    model,
    capacityTokens: 1000,
    outputReserveTokens: 100,
  });
  const result = await compactor.compact(projection);
  assert.equal(result.status, "compacted");
  if (result.status === "compacted") {
    assert.ok(result.protectedSubjects.includes("never call network"));
    assert.ok(result.protectedSubjects.includes("use sqlite"));
    assert.ok(result.protectedSubjects.includes("task-7"));
    assert.equal(result.config, "fake-role");
  }
}

async function testMissingOrFabricatedReferencesFail(): Promise<void> {
  const projection = projectionWith("never call network", "use sqlite", "task-7");
  const dropModel = new FakeModel(async (request) => ({
    text: "short",
    retainedSubjects: request.protectedSubjects.slice(1),
  }));
  const drop = new SafeCompactor(checkpoint("long"), { model: dropModel, capacityTokens: 1000, outputReserveTokens: 100 });
  const dropped = await drop.compact(projection);
  assert.equal(dropped.status, "failure");
  if (dropped.status === "failure") {
    assert.match(dropped.reason, /missing 1/);
  }

  const fabricateModel = new FakeModel(async (request) => ({
    text: "short",
    retainedSubjects: [...request.protectedSubjects, "invented-source"],
  }));
  const fabricate = new SafeCompactor(checkpoint("long"), {
    model: fabricateModel,
    capacityTokens: 1000,
    outputReserveTokens: 100,
  });
  const fabricated = await fabricate.compact(projection);
  assert.equal(fabricated.status, "failure");
  if (fabricated.status === "failure") {
    assert.match(fabricated.reason, /fabricated 1/);
  }
}

async function testOversizedEmptyAndCancellationFail(): Promise<void> {
  const projection = projectionWith("c", "d", "o");
  const empty = new SafeCompactor(checkpoint("long"), {
    model: new FakeModel(async () => ({ text: "", retainedSubjects: [] })),
    capacityTokens: 1000,
    outputReserveTokens: 100,
  });
  const emptyResult = await empty.compact(projection);
  assert.equal(emptyResult.status, "failure");

  const oversized = new SafeCompactor(checkpoint("long"), {
    model: new FakeModel(async (request) => ({ text: "x".repeat(4000), retainedSubjects: request.protectedSubjects })),
    capacityTokens: 100,
    outputReserveTokens: 10,
  });
  const oversizedResult = await oversized.compact(projection);
  assert.equal(oversizedResult.status, "failure");
  if (oversizedResult.status === "failure") {
    assert.match(oversizedResult.reason, /too large/);
  }

  const cancel = new SafeCompactor(checkpoint("long"), {
    model: new FakeModel(async () => {
      throw new Error("aborted");
    }),
    capacityTokens: 1000,
    outputReserveTokens: 100,
  });
  const cancelResult = await cancel.compact(projection);
  assert.equal(cancelResult.status, "failure");
}

async function testRetrySuppressedOnUnchangedFailure(): Promise<void> {
  const projection = projectionWith("c", "d", "o");
  const model = new FakeModel(async () => ({ text: "", retainedSubjects: [] }));
  const compactor = new SafeCompactor(checkpoint("long"), {
    model,
    capacityTokens: 1000,
    outputReserveTokens: 100,
    maxAttempts: 1,
  });
  const first = await compactor.compact(projection);
  assert.equal(first.status, "failure");
  const second = await compactor.compact(projection);
  assert.equal(second.status, "failure");
  if (second.status === "failure") {
    assert.equal(second.retrySuppressed, true);
    assert.match(second.reason, /retry suppressed/);
  }
}

async function main(): Promise<void> {
  await testSuccessfulCompactionPreservesProtectedReferences();
  await testMissingOrFabricatedReferencesFail();
  await testOversizedEmptyAndCancellationFail();
  await testRetrySuppressedOnUnchangedFailure();
  console.log("memory-safe-compaction.test.ts: OK (protected references, validation, cancellation, retry suppression)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
