// Tests for the memory-compaction detection-and-compaction component
// (memory/memoryCompaction.ts). These verify:
//   - the pure threshold test (below/at/above 50% of the context window);
//   - on trigger, the highest model is called with the compaction prompt and
//     the plan+memory, and the returned compressed summary replaces the
//     original;
//   - fail-open behavior: a failing model call or an invalid/empty response
//     preserves the original memory and reports an error (never throws);
//   - the example session id 'aaaa-1112-0001' flows through the compactor.
import assert from "node:assert/strict";
import type { GenerateRequest, GenerateResponse, LlmAdapter } from "../llm/adapter-contract.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  MemoryCompactor,
  MEMORY_COMPACTION_THRESHOLD,
  renderMemoryCompactionPrompt,
  shouldCompactMemory,
  validateCompactedSummary,
  type CompactionSummaryStore,
} from "../memory/memoryCompaction.js";

const COMPACTION_PROMPT =
  "[MEMORY-COMPACTION]\nCompress without losing important details.\nPlan: ${plan}\nMemory: ${memory}\n";

class FakeStore implements CompactionSummaryStore {
  summaries = new Map<string, string>();
  getSummary(sessionId: string): string | undefined {
    return this.summaries.get(sessionId);
  }
  setSummary(sessionId: string, summary: string): void {
    this.summaries.set(sessionId, summary);
  }
}

class FakeAdapter implements LlmAdapter {
  provider = "fake";
  capabilities = { toolCalling: false, systemMessages: true, developerMessages: false };
  calls: { model: string; request: GenerateRequest }[] = [];
  responses: { text: string } | null = { text: "compact result" };
  fail = false;

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.calls.push({ model: request.model, request });
    if (this.fail) {
      throw new Error("provider boom");
    }
    return {
      model: request.model,
      finishReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: this.responses?.text ?? "" }] },
    };
  }
}

async function testThresholdBoundary(): Promise<void> {
  // Context window 100 chars. Summary length / window must be *strictly > 0.5*.
  assert.equal(shouldCompactMemory(50, 100), false, "exactly 50% must not compact");
  assert.equal(shouldCompactMemory(51, 100), true, ">50% must compact");
  assert.equal(shouldCompactMemory(49, 100), false, "below 50% must not compact");
  assert.equal(shouldCompactMemory(0, 100), false, "empty summary must not compact");
  assert.equal(shouldCompactMemory(100, 100), true, "100% must compact");
  assert.equal(shouldCompactMemory(50, 100, MEMORY_COMPACTION_THRESHOLD), false, "uses default 0.5 threshold");
  assert.equal(DEFAULT_CONTEXT_WINDOW, 120000, "default context window is 120k");
  console.log("  ok: threshold boundary at exactly 50% (not compact), >50% (compact)");
}

async function testRenderPrompt(): Promise<void> {
  const rendered = renderMemoryCompactionPrompt(COMPACTION_PROMPT, { steps: 3 }, "memory text");
  assert.match(rendered, /Plan: {"steps":3}/, "plan literal is interpolated");
  assert.match(rendered, /Memory: memory text/, "memory is interpolated");
  assert.doesNotMatch(rendered, /\$\{plan\}|\$\{memory\}/, "placeholders are replaced");
  console.log("  ok: prompt renders plan and memory placeholders");
}

async function testCompactionTriggersWithHighestModel(): Promise<void> {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  store.summaries.set("aaaa-1112-0001", "x".repeat(60));
  const compactor = new MemoryCompactor({
    store,
    adapter,
    highestModel: "deepseek-v4-pro",
    promptTemplate: COMPACTION_PROMPT,
    contextWindow: 100,
    threshold: 0.5,
  });

  const outcome = await compactor.maybeCompact("aaaa-1112-0001", "plan abc");
  assert.equal(outcome.attempted, true, "threshold exceeded so an attempt is made");
  assert.equal(outcome.compacted, true, "compact result replaces memory");
  assert.equal(store.summaries.get("aaaa-1112-0001"), "compact result", "summary replaced with compressed text");
  assert.equal(adapter.calls.length, 1, "adapter called once");
  assert.equal(adapter.calls[0].model, "deepseek-v4-pro", "highest model used");
  const firstMessage = adapter.calls[0].request.messages[0] as { content?: readonly { text?: string }[] };
  const prompt = firstMessage.content?.[0]?.text ?? "";
  assert.match(prompt, /plan abc/, "plan passed to compaction prompt");
  assert.match(prompt, /x{10}/, "memory passed to compaction prompt");
  console.log("  ok: threshold trigger calls highest model with plan+memory and replaces summary");
}

async function testBelowThresholdDoesNotCallModel(): Promise<void> {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  store.summaries.set("s", "short");
  const compactor = new MemoryCompactor({
    store,
    adapter,
    highestModel: "m",
    promptTemplate: COMPACTION_PROMPT,
    contextWindow: 100,
    threshold: 0.5,
  });
  const outcome = await compactor.maybeCompact("s", "plan");
  assert.equal(outcome.attempted, false);
  assert.equal(outcome.compacted, false);
  assert.equal(adapter.calls.length, 0, "model not called below threshold");
  assert.equal(store.summaries.get("s"), "short", "memory unchanged");
  console.log("  ok: below-threshold memory is left alone (no model call)");
}

async function testModelFailurePreservesMemory(): Promise<void> {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  store.summaries.set("f", "y".repeat(60));
  adapter.fail = true;
  const compactor = new MemoryCompactor({
    store,
    adapter,
    highestModel: "m",
    promptTemplate: COMPACTION_PROMPT,
    contextWindow: 100,
  });
  let threw = false;
  let outcome;
  try {
    outcome = await compactor.maybeCompact("f", "plan");
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "failed model call must not throw (fail open)");
  assert.equal(outcome?.compacted, false, "no compaction on model failure");
  assert.equal(store.summaries.get("f"), "y".repeat(60), "original memory preserved on failure");
  assert.ok(outcome?.error && /provider boom/.test(outcome.error), "actionable diagnostic logged");
  console.log("  ok: model failure preserves original memory and reports an error");
}

async function testInvalidOutputPreservesMemory(): Promise<void> {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  store.summaries.set("i", "z".repeat(60));
  adapter.responses = { text: "```json\n{\"bad\": true}\n```" };
  const compactor = new MemoryCompactor({
    store,
    adapter,
    highestModel: "m",
    promptTemplate: COMPACTION_PROMPT,
    contextWindow: 100,
  });
  const outcome = await compactor.maybeCompact("i", "plan");
  assert.equal(outcome.compacted, false, "invalid (fenced) output is rejected");
  assert.equal(store.summaries.get("i"), "z".repeat(60), "original memory preserved on invalid output");
  console.log("  ok: invalid output preserves original memory");
}

async function testValidateCompactedSummary(): Promise<void> {
  assert.equal(validateCompactedSummary("  summary "), "summary");
  assert.equal(validateCompactedSummary(""), null);
  assert.equal(validateCompactedSummary("   \n  "), null);
  assert.equal(validateCompactedSummary('{"a":1}'), null, "JSON rejected");
  assert.equal(validateCompactedSummary("[1,2]"), null, "JSON array rejected");
  assert.equal(validateCompactedSummary("```text\ncode\n```"), null, "fenced rejected");
  console.log("  ok: compacted-summary validation accepts text, rejects JSON/empty/fenced");
}

async function testNoMockShrinkIsRejected(): Promise<void> {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  const big = "y".repeat(70);
  store.summaries.set("n", big);
  adapter.responses = { text: big }; // not shorter -> not accepted
  const compactor = new MemoryCompactor({
    store,
    adapter,
    highestModel: "m",
    promptTemplate: COMPACTION_PROMPT,
    contextWindow: 100,
  });
  const outcome = await compactor.maybeCompact("n", "plan");
  assert.equal(outcome.compacted, false, "compaction that does not shrink is rejected");
  assert.equal(store.summaries.get("n"), big, "original preserved");
  console.log("  ok: a compaction that did not shrink is rejected (original preserved)");
}

async function main(): Promise<void> {
  await testThresholdBoundary();
  await testRenderPrompt();
  await testCompactionTriggersWithHighestModel();
  await testBelowThresholdDoesNotCallModel();
  await testModelFailurePreservesMemory();
  await testInvalidOutputPreservesMemory();
  await testValidateCompactedSummary();
  await testNoMockShrinkIsRejected();
  console.log("Memory-compaction tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
