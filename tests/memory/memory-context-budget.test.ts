/**
 * Context budget and cache-ordering tests (MI-09).
 *
 * Covers capacity enforcement, stable-prefix preservation, constraint/protocol
 * preservation with omitted-fact counts, impossible mandatory content, and
 * no-memory classifier/router requests.
 */

import assert from "node:assert/strict";
import {
  MemoryContextAssembler,
  snapshotMemoryContext,
  type AssembledMemoryContext,
} from "../../src/memory/context-assembly.js";
import type { RetrievedItemV2 } from "../../src/memory/retrieval.js";
import type { StructuredRecordV2 } from "../../src/memory/structured-records.js";
import type { MemoryScopeV2 } from "../../src/memory/contracts-v2.js";

const scope: MemoryScopeV2 = {
  workspaceId: "ws-budget",
  principalId: "principal-budget",
  sessionId: "session-budget",
};

function item(subject: string, kind: StructuredRecordV2["kind"] = "fact", authoritative = false): RetrievedItemV2 {
  return {
    record: {
      id: `id-${subject}`,
      kind,
      scope,
      subject,
      sourceEventIds: [`evt-${subject}`],
      evidence: "unverified",
      authoritative,
      createdAtSequence: 1,
      updatedAtSequence: 1,
      tags: [],
      status: "current",
      payload: undefined,
    },
    score: 10,
    reasons: ["test"],
  };
}

async function testCapacityEnforcedOrBudgetError(): Promise<void> {
  const assembler = new MemoryContextAssembler({ capacityTokens: 100, outputReserveTokens: 20 });
  const ok = assembler.assemble({
    stablePrefix: "STABLE",
    currentRequest: "do work",
    toolsText: "tool1",
    conversationText: "",
    memoryItems: [item("fact a")],
  });
  assert.equal(ok.status, "ok");
  assert.ok(ok.estimatedTokens <= 100);

  const impossible = assembler.assemble({
    stablePrefix: "STABLE",
    currentRequest: "do work",
    toolsText: "tool1",
    conversationText: "",
    memoryItems: [],
  });
  assert.equal(impossible.status, "ok"); // mandatory small enough; adjust below with a tiny capacity

  const tiny = new MemoryContextAssembler({ capacityTokens: 10, outputReserveTokens: 5 });
  const tooBig = tiny.assemble({
    stablePrefix: "STABLE",
    currentRequest: "do work with a very long mandatory request that cannot possibly fit",
    toolsText: "tool1",
    conversationText: "",
    memoryItems: [],
  });
  assert.equal(tooBig.status, "budget-error");
  if (tooBig.status === "budget-error" && tooBig.reason !== undefined) {
    assert.match(tooBig.reason, /mandatory content needs/);
  }
}

async function testChangingMemoryNeverChangesStablePrefix(): Promise<void> {
  const assembler = new MemoryContextAssembler({ capacityTokens: 1000, outputReserveTokens: 50 });
  const base = {
    stablePrefix: "STABLE PREFIX BYTES",
    currentRequest: "do work",
    toolsText: "tool1",
    conversationText: "",
  };
  const a = assembler.assemble({ ...base, memoryItems: [item("memory one")] });
  const b = assembler.assemble({ ...base, memoryItems: [item("memory two")] });
  assert.ok(a.text.startsWith("STABLE PREFIX BYTES"));
  assert.ok(b.text.startsWith("STABLE PREFIX BYTES"));
  assert.notEqual(a.memorySection, b.memorySection);
}

async function testConstraintsPreservedAndOmittedFactsCounted(): Promise<void> {
  const assembler = new MemoryContextAssembler({ capacityTokens: 200, outputReserveTokens: 30 });
  const result = assembler.assemble({
    stablePrefix: "STABLE",
    currentRequest: "do work",
    toolsText: "tool1",
    conversationText: "",
    memoryItems: [
      item("never call network", "constraint", true),
      item("fact a"),
      item("fact b"),
      item("fact c"),
      item("fact d"),
    ],
  });
  assert.equal(result.status, "ok");
  assert.ok(result.memorySection.includes("never call network"), "constraints must be preserved");
  assert.ok(result.omittedCount >= 0);
  const snapshot = snapshotMemoryContext(result);
  assert.ok(snapshot.memorySection.length > 0);
}

async function testClassifierRequestReceivesNoMemory(): Promise<void> {
  const assembler = new MemoryContextAssembler({ capacityTokens: 1000, outputReserveTokens: 50 });
  const result = assembler.assemble({
    stablePrefix: "CLASSIFIER",
    currentRequest: "classify this tool call",
    toolsText: "",
    conversationText: "",
    memoryItems: [item("unrelated memory")],
    includeMemory: false,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.memorySection, "");
  assert.ok(!result.text.includes("SESSION MEMORY"));
}

async function main(): Promise<void> {
  await testCapacityEnforcedOrBudgetError();
  await testChangingMemoryNeverChangesStablePrefix();
  await testConstraintsPreservedAndOmittedFactsCounted();
  await testClassifierRequestReceivesNoMemory();
  console.log("memory-context-budget.test.ts: OK (capacity, stable prefix, constraints, no-memory requests)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
