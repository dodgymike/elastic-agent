/**
 * Deterministic lexical retrieval tests (MI-08).
 *
 * Covers file/task relevance, deduplication, superseded/unauthorized
 * filtering, deterministic ordering, limits, and empty queries.
 */

import assert from "node:assert/strict";
import {
  buildEventEnvelope,
  stableEventId,
  type MemoryEventEnvelopeV2,
  type MemoryScopeV2,
} from "../../src/memory/contracts-v2.js";
import {
  buildStructuredProjection,
  type StructuredRecordV2,
} from "../../src/memory/structured-records.js";
import {
  retrieveRelevant,
  retrieveRelevantRecords,
} from "../../src/memory/retrieval.js";

const scope: MemoryScopeV2 = {
  workspaceId: "ws-retrieval",
  principalId: "principal-retrieval",
  sessionId: "session-retrieval",
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
      identity: { ...scope, runId: "run-retrieval" },
      runRef: "run-retrieval",
      kind,
      ...(payload !== undefined ? { payload: payload as never } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    },
    sequence,
  );
}

async function testFileRelevanceExcludesDistractors(): Promise<void> {
  const events = [
    makeEvent("evt-a1", "fact", 1, { text: "file A uses sqlite" }, { asserted: "completed", verification: "verified" }),
    makeEvent("evt-b1", "fact", 2, { text: "file B uses redis" }),
    makeEvent("evt-a2", "decision", 3, { subject: "file A decision: use WAL" }),
    makeEvent("evt-constraint", "constraint", 4, {
      structured: { subject: "always verify file A", authoritative: true },
    }),
  ];
  const projection = buildStructuredProjection(scope, events);
  const result = retrieveRelevant(projection, {
    scope,
    queryText: "work on file A",
    referencedFiles: ["file A"],
    limit: 5,
  });
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    const subjects = result.items.map((item) => item.record.subject);
    assert.ok(subjects.some((s) => s.includes("file A")), "file A items should be selected");
    assert.equal(result.items[0].record.kind, "constraint", "constraints are selected first");
    const firstA = subjects.findIndex((s) => s.includes("file A"));
    const firstB = subjects.findIndex((s) => s.includes("file B"));
    assert.ok(firstA < firstB, "file A relevance must rank above file B distractors");
  }
}

async function testIdenticalProjectionsDeduplicate(): Promise<void> {
  const events = [
    makeEvent("evt-a1", "fact", 1, { text: "file A uses sqlite" }, { asserted: "completed", verification: "verified" }),
  ];
  const first = buildStructuredProjection(scope, events);
  const second = buildStructuredProjection(scope, events);
  const combined: StructuredRecordV2[] = [...first.records, ...second.records];
  const result = retrieveRelevantRecords(scope, combined, {
    scope,
    queryText: "file A",
    limit: 10,
  });
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    const ids = result.items.map((item) => item.record.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate projections must appear once");
  }
}

async function testSupersededAndUnauthorizedAreFiltered(): Promise<void> {
  const oldDecisionId = stableEventId(scope, "structured:decision:evt-old");
  const events = [
    makeEvent("evt-old", "decision", 1, { subject: "use in-memory" }),
    makeEvent("evt-new", "decision", 2, {
      structured: { subject: "use sqlite", supersedes: [oldDecisionId] },
    }),
  ];
  const projection = buildStructuredProjection(scope, events);
  const current = retrieveRelevant(projection, { scope, queryText: "use", limit: 5 });
  assert.equal(current.status, "ok");
  if (current.status === "ok") {
    assert.equal(current.items.length, 1);
    assert.equal(current.items[0].record.subject, "use sqlite");
  }

  const history = retrieveRelevant(projection, { scope, queryText: "use", limit: 5, includeHistory: true });
  assert.equal(history.status, "ok");
  if (history.status === "ok") {
    assert.equal(history.items.length, 2);
  }

  const otherScope = { ...scope, workspaceId: "other-workspace" };
  const other = retrieveRelevant(projection, { scope: otherScope, queryText: "use", limit: 5 });
  assert.equal(other.status, "ok");
  if (other.status === "ok") {
    assert.equal(other.items.length, 0, "records from unauthorized scopes must never appear");
  }
}

async function testDeterministicTiesAndLimits(): Promise<void> {
  const events = Array.from({ length: 10 }, (_, i) =>
    makeEvent(`evt-t${i}`, "fact", i + 1, { text: `fact ${String.fromCharCode(97 + i)}` }),
  );
  const projection = buildStructuredProjection(scope, events);
  const first = retrieveRelevant(projection, { scope, limit: 5 });
  const second = retrieveRelevant(projection, { scope, limit: 5 });
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  if (first.status === "ok" && second.status === "ok") {
    assert.equal(first.items.length, 5, "output limit enforced");
    assert.deepEqual(
      first.items.map((i) => i.record.subject),
      second.items.map((i) => i.record.subject),
      "tie ordering must be deterministic",
    );
  }
}

async function testEmptyQueryStillReturnsConstraintsAndOpenWork(): Promise<void> {
  const events = [
    makeEvent("evt-constraint", "constraint", 1, {
      structured: { subject: "never call network", authoritative: true },
    }),
    makeEvent("evt-open", "observation", 2, { openTasks: ["task-7"] }),
    makeEvent("evt-fact", "fact", 3, { text: "some fact" }),
  ];
  const projection = buildStructuredProjection(scope, events);
  const result = retrieveRelevant(projection, { scope, limit: 10 });
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    const kinds = result.items.map((item) => item.record.kind);
    assert.ok(kinds.includes("constraint"));
    assert.ok(kinds.includes("open-task"));
    assert.ok(kinds.includes("fact"));
  }
}

async function testVerifiedEvidenceBeatsNewerUnverifiedClaims(): Promise<void> {
  const events = [
    makeEvent("evt-verified", "fact", 1, {
      structured: { recordKind: "fact", subject: "alpha state", tags: ["alpha"] },
    }, { asserted: "completed", verification: "verified" }),
    makeEvent("evt-unverified", "fact", 2, {
      structured: { recordKind: "fact", subject: "alpha state", tags: ["alpha"] },
    }, { asserted: "completed", verification: "unverified" }),
  ];
  const projection = buildStructuredProjection(scope, events);
  const result = retrieveRelevant(projection, { scope, queryText: "alpha", limit: 10 });
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    const alphaItems = result.items.filter((item) => item.record.subject === "alpha state");
    assert.equal(alphaItems.length, 1, "conflicting same-subject facts deduplicate deterministically");
    assert.equal(alphaItems[0].record.evidence, "verified", "verified evidence ranks above newer unverified claims");
  }
}

async function main(): Promise<void> {
  await testFileRelevanceExcludesDistractors();
  await testIdenticalProjectionsDeduplicate();
  await testSupersededAndUnauthorizedAreFiltered();
  await testDeterministicTiesAndLimits();
  await testEmptyQueryStillReturnsConstraintsAndOpenWork();
  await testVerifiedEvidenceBeatsNewerUnverifiedClaims();
  console.log("memory-retrieval.test.ts: OK (relevance, dedup, filtering, ordering, limits, empty query, evidence ranking)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
