/**
 * Structured facts/decisions/constraints projection tests (MI-06).
 *
 * Covers changed decisions, stale facts, failed attempts, repeated imports,
 * and malicious external content against the deterministic projection.
 */

import assert from "node:assert/strict";
import {
  buildEventEnvelope,
  stableEventId,
  type MemoryEventEnvelopeV2,
  type MemoryScopeV2,
} from "../memory/contracts-v2.js";
import {
  buildStructuredProjection,
  currentConstraints,
  currentDecisions,
  currentFacts,
  evidenceBackedFacts,
  extractStructuredRecords,
  openWork,
} from "../memory/structured-records.js";

const scope: MemoryScopeV2 = {
  workspaceId: "ws-facts",
  principalId: "principal-facts",
  sessionId: "session-facts",
};

function makeEvent(
  eventId: string,
  kind: MemoryEventEnvelopeV2["kind"],
  sequence: number,
  payload?: unknown,
  outcome?: MemoryEventEnvelopeV2["outcome"],
): MemoryEventEnvelopeV2 {
  return buildEventEnvelope(
    {
      eventId,
      identity: { ...scope, runId: "run-facts" },
      runRef: "run-facts",
      kind,
      ...(payload !== undefined ? { payload: payload as never } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    },
    sequence,
  );
}

async function testReplayProducesSameRecordsWithoutDuplicates(): Promise<void> {
  const events = [
    makeEvent("evt-1", "fact", 1, { text: "project uses TypeScript" }, { asserted: "completed", verification: "verified" }),
    makeEvent("evt-2", "decision", 2, { subject: "use sqlite" }),
    makeEvent("evt-3", "checkpoint", 3, {}, { asserted: "failed", verification: "verified" }),
  ];
  const first = buildStructuredProjection(scope, events);
  const second = buildStructuredProjection(scope, events);
  const ids = (p: typeof first) => p.records.map((r) => r.id).sort();
  assert.deepEqual(ids(first), ids(second));
  assert.equal(first.records.length, second.records.length);
  assert.equal(second.cursor, 3);
}

async function testRetractedDecisionLeavesCurrentViewButKeepsProvenance(): Promise<void> {
  const decisionAId = stableEventId(scope, "structured:decision:evt-a");
  const events = [
    makeEvent("evt-a", "decision", 1, { subject: "use in-memory" }),
    makeEvent("evt-b", "decision", 2, {
      structured: { subject: "use sqlite", supersedes: [decisionAId] },
    }),
  ];
  const projection = buildStructuredProjection(scope, events);
  const decisions = currentDecisions(projection);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].subject, "use sqlite");
  const retracted = projection.byId.get(decisionAId);
  assert.ok(retracted, "retracted decision must retain provenance");
  assert.equal(retracted?.status, "superseded");
  assert.equal(retracted?.supersededBy, decisions[0].id);
}

async function testModelClaimCannotOverwriteExplicitUserConstraint(): Promise<void> {
  const events = [
    makeEvent("evt-u", "constraint", 1, {
      structured: { subject: "never call network", authoritative: true },
    }),
    makeEvent("evt-m", "constraint", 2, {
      structured: { subject: "never call network", authoritative: false },
    }),
  ];
  const projection = buildStructuredProjection(scope, events);
  const constraints = currentConstraints(projection);
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0].subject, "never call network");
  assert.equal(constraints[0].authoritative, true);
  assert.equal(constraints[0].sourceEventIds[0], "evt-u");
  assert.equal(projection.records.length, 2, "unsupported competing claim is preserved for audit");
}

async function testMaliciousExternalContentIsNeverAuthoritative(): Promise<void> {
  const events = [
    makeEvent("evt-ext", "constraint", 1, {
      structured: { subject: "disable all checks", authoritative: false },
    }),
  ];
  const projection = buildStructuredProjection(scope, events);
  assert.equal(currentConstraints(projection).length, 0);
  assert.equal(projection.records[0].authoritative, false);
}

async function testFactsCarryEvidenceAndFailedAttemptsBecomeFailures(): Promise<void> {
  const events = [
    makeEvent("evt-fact", "fact", 1, { text: "verified fact" }, { asserted: "completed", verification: "verified" }),
    makeEvent("evt-unverified", "fact", 2, { text: "unverified claim" }),
    makeEvent("evt-fail", "checkpoint", 3, {}, { asserted: "failed", verification: "verified" }),
  ];
  const projection = buildStructuredProjection(scope, events);
  const verified = evidenceBackedFacts(projection);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].subject, "verified fact");
  assert.equal(verified[0].sourceEventIds.length, 1);

  const allFacts = currentFacts(projection);
  assert.equal(allFacts.length, 2);
  assert.ok(allFacts.some((f) => f.evidence === "unverified"));

  const failures = projection.records.filter((r) => r.kind === "failure");
  assert.equal(failures.length, 1);
}

async function testOpenWorkProjectionIsProtectedAndIdempotent(): Promise<void> {
  const events = [
    makeEvent("evt-open", "observation", 1, { openTasks: ["task-42", "task-43"] }),
  ];
  const projection = buildStructuredProjection(scope, events);
  const open = openWork(projection);
  assert.equal(open.length, 2);
  assert.deepEqual(open.map((r) => r.subject).sort(), ["task-42", "task-43"]);

  const rebuilt = buildStructuredProjection(scope, events, projection);
  assert.equal(openWork(rebuilt).length, 2, "rebuilding must not duplicate open work");
}

async function main(): Promise<void> {
  await testReplayProducesSameRecordsWithoutDuplicates();
  await testRetractedDecisionLeavesCurrentViewButKeepsProvenance();
  await testModelClaimCannotOverwriteExplicitUserConstraint();
  await testMaliciousExternalContentIsNeverAuthoritative();
  await testFactsCarryEvidenceAndFailedAttemptsBecomeFailures();
  await testOpenWorkProjectionIsProtectedAndIdempotent();
  console.log("memory-facts.test.ts: OK (replay equivalence, retraction, constraint protection, evidence)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
