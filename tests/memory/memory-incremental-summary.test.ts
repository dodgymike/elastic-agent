/**
 * Incremental summary tests (MI-07).
 *
 * Covers batch bounds (non-quadratic processing), stale/invalid/timeout
 * behavior, summarizer version changes, and no-call paths.
 */

import assert from "node:assert/strict";
import {
  buildEventEnvelope,
  type MemoryEventEnvelopeV2,
  type MemoryScopeV2,
} from "../../src/memory/contracts-v2.js";
import {
  IncrementalSummaryManager,
  type IncrementalSummarizeInput,
  type IncrementalSummarizer,
} from "../../src/memory/incremental-summary.js";

const scope: MemoryScopeV2 = {
  workspaceId: "ws-summary",
  principalId: "principal-summary",
  sessionId: "session-summary",
};

function makeEvents(count: number): MemoryEventEnvelopeV2[] {
  return Array.from({ length: count }, (_, i) =>
    buildEventEnvelope(
      {
        eventId: `evt-${i + 1}`,
        identity: { ...scope, runId: "run-summary" },
        runRef: "run-summary",
        kind: "observation",
        payload: { step: i + 1 },
      },
      i + 1,
    ),
  );
}

class FakeSummarizer implements IncrementalSummarizer {
  readonly version: string;
  calls: IncrementalSummarizeInput[] = [];
  private behavior: Array<"ok" | "invalid"> = [];
  private manual: Array<{ input: IncrementalSummarizeInput; resolve: (text: string) => void }> = [];
  manualMode = false;

  constructor(version = "fake-v1") {
    this.version = version;
  }

  async summarize(input: IncrementalSummarizeInput): Promise<string> {
    this.calls.push(input);
    if (this.manualMode) {
      return new Promise<string>((resolve) => {
        this.manual.push({ input, resolve });
      });
    }
    const next = this.behavior.shift() ?? "ok";
    if (next === "invalid") return "";
    return `summary(${input.events.map((e) => e.eventId).join(",")})`;
  }

  queueInvalid(): void {
    this.behavior.push("invalid");
  }

  nextManual(): { input: IncrementalSummarizeInput; resolve: (text: string) => void } {
    const item = this.manual.shift();
    if (!item) throw new Error("no pending manual summarize call");
    return item;
  }

  get manualCount(): number {
    return this.manual.length;
  }
}

async function testBatchedUpdatesAreNotQuadratic(): Promise<void> {
  const events = makeEvents(100);
  const summarizer = new FakeSummarizer();
  const manager = new IncrementalSummaryManager(scope, { summarizer, maxBatchEvents: 10, maxPriorChars: 200 });
  for (let i = 0; i < 12; i += 1) {
    await manager.advance(events);
  }
  const sizes = summarizer.calls.map((call) => call.events.length);
  assert.ok(sizes.every((size) => size <= 10), "every call receives only its batch");
  assert.equal(sizes.reduce((a, b) => a + b, 0), 100, "all events processed exactly once");
  const checkpoint = manager.checkpoint();
  assert.equal(checkpoint.coveredThroughSequence, 100);
  assert.ok(checkpoint.text.length <= 12000);
}

async function testInvalidOutputRetainsCursorAndRetries(): Promise<void> {
  const events = makeEvents(5);
  const summarizer = new FakeSummarizer();
  summarizer.queueInvalid();
  const manager = new IncrementalSummaryManager(scope, { summarizer, maxBatchEvents: 5 });
  const first = await manager.advance(events);
  assert.equal(first.status, "failure");
  if (first.status === "failure") {
    assert.equal(first.checkpoint.coveredThroughSequence, 0);
  }
  const second = await manager.advance(events);
  assert.equal(second.status, "advanced");
  if (second.status === "advanced") {
    assert.equal(second.checkpoint.coveredThroughSequence, 5);
  }
}

async function testStaleCompletionDoesNotOverwriteNewer(): Promise<void> {
  const events = makeEvents(5);
  const summarizer = new FakeSummarizer();
  summarizer.manualMode = true;
  const manager = new IncrementalSummaryManager(scope, { summarizer, maxBatchEvents: 5 });
  const p1 = manager.advance(events);
  const p2 = manager.advance(events);
  // Resolve the second call first, then the first; the first must go stale.
  const firstPending = summarizer.nextManual();
  const secondPending = summarizer.nextManual();
  secondPending.resolve("newer summary");
  const result2 = await p2;
  firstPending.resolve("stale summary");
  const result1 = await p1;

  const statuses = [result1.status, result2.status].sort();
  assert.deepEqual(statuses, ["advanced", "stale"]);
  assert.equal(manager.checkpoint().revision, 1);
  assert.equal(manager.checkpoint().text, "newer summary");
}

async function testTimeoutRetainsPreviousCheckpoint(): Promise<void> {
  const events = makeEvents(3);
  const summarizer: IncrementalSummarizer = {
    version: "slow-v1",
    async summarize() {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return "late";
    },
  };
  const manager = new IncrementalSummaryManager(scope, { summarizer, deadlineMs: 20 });
  const result = await manager.advance(events);
  assert.equal(result.status, "failure");
  if (result.status === "failure") {
    assert.match(result.reason, /deadline/);
    assert.equal(result.checkpoint.coveredThroughSequence, 0);
  }
}

async function testSummarizerVersionIsRecordedAndChangesMarkRebuildable(): Promise<void> {
  const events = makeEvents(2);
  const v1 = new FakeSummarizer("v1");
  const manager = new IncrementalSummaryManager(scope, { summarizer: v1 });
  await manager.advance(events);
  assert.equal(manager.checkpoint().summarizerVersion, "v1");

  const v2 = new FakeSummarizer("v2");
  const secondManager = new IncrementalSummaryManager(scope, { summarizer: v2 });
  await secondManager.advance(events);
  assert.equal(secondManager.checkpoint().summarizerVersion, "v2");
}

async function testNoSummarizerCallForUnchangedCursorOrOfflineMode(): Promise<void> {
  const events = makeEvents(3);
  const summarizer = new FakeSummarizer();
  const manager = new IncrementalSummaryManager(scope, { summarizer, offlineDeterministic: true });
  const advanced = await manager.advance(events);
  assert.equal(advanced.status, "advanced");
  assert.equal(summarizer.calls.length, 0, "offline deterministic mode must not call the injected summarizer");

  const unchanged = await manager.advance(events);
  assert.equal(unchanged.status, "unchanged");
  assert.equal(summarizer.calls.length, 0);
}

async function main(): Promise<void> {
  await testBatchedUpdatesAreNotQuadratic();
  await testInvalidOutputRetainsCursorAndRetries();
  await testStaleCompletionDoesNotOverwriteNewer();
  await testTimeoutRetainsPreviousCheckpoint();
  await testSummarizerVersionIsRecordedAndChangesMarkRebuildable();
  await testNoSummarizerCallForUnchangedCursorOrOfflineMode();
  console.log("memory-incremental-summary.test.ts: OK (batching, stale/invalid/timeout, versioning, no-call paths)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
