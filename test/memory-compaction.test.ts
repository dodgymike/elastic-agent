// Tests for the memory-compaction detection-and-compaction component
// (memory/memoryCompaction.ts). These verify:
//   - the pure threshold test (below/at/above 50% of the context window);
//   - on trigger, the highest model is called with the compaction prompt and
//     the plan+memory, and the returned compressed summary replaces the
//     original;
//   - fail-open behavior: a failing model call or an invalid/empty response
//     preserves the original memory and reports an error (never throws);
//   - the example session id 'aaaa-1112-0001' flows through the compactor;
//   - the real in-memory backend participates in compaction via its
//     getSummary/setSummary aliases (store-binding gap regression);
//   - a fixture-driven end-to-end flow loads the real prompts/memory-compaction.md
//     and the test/fixtures/memory-aaaa-1112-0001.json fixture, triggers
//     compaction, and asserts the prompt file content, plan+memory passthrough,
//     and summary replacement.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

import { InMemoryMemoryModule } from "../memory/inMemory.js";

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

async function testRealInMemoryBackendCompacts(): Promise<void> {
  // The real runtime backend (InMemoryMemoryModule) exposes the compactor's
  // read/set surface via the getSummary/setSummary aliases for its native
  // summaryForSession/setSummaryForSession. Verify the compactor runs directly
  // against the real backend (not just the test FakeStore), so runtime
  // compaction is not silently disabled at wiring time.
  const module = new InMemoryMemoryModule();
  const adapter = new FakeAdapter();
  // Seed the session summary through the backend's native setter.
  module.setSummaryForSession("aaaa-1112-0001", "x".repeat(60));
  // The backend must satisfy the compactor store contract.
  assert.equal(typeof (module as unknown as CompactionSummaryStore).getSummary, "function", "backend exposes getSummary alias");
  assert.equal(typeof (module as unknown as CompactionSummaryStore).setSummary, "function", "backend exposes setSummary alias");

  const compactor = new MemoryCompactor({
    store: module as unknown as CompactionSummaryStore,
    adapter,
    highestModel: "deepseek-v4-pro",
    promptTemplate: COMPACTION_PROMPT,
    contextWindow: 100,
    threshold: 0.5,
  });
  const outcome = await compactor.maybeCompact("aaaa-1112-0001", "plan rt");
  assert.equal(outcome.attempted, true, "threshold exceeded so an attempt is made");
  assert.equal(outcome.compacted, true, "compact result replaces memory on the real backend");
  assert.equal(module.summaryForSession("aaaa-1112-0001"), "compact result", "real backend summary replaced");
  assert.equal(module.getSummary("aaaa-1112-0001"), "compact result", "getSummary alias reflects the replacement");
  const prompt = adapter.calls[0].request.messages[0] as { content?: readonly { text?: string }[] };
  assert.match(prompt.content?.[0]?.text ?? "", /plan rt/, "plan passed to compaction prompt");
  assert.match(prompt.content?.[0]?.text ?? "", /x{10}/, "memory passed to compaction prompt");
  console.log("  ok: real in-memory backend participates in compaction via getSummary/setSummary aliases");
}

async function testFixtureDrivenFullFlow(): Promise<void> {
  // Load the real compaction prompt and the canned fixture for session
  // aaaa-1112-0001 (mirrors docs/examples/elastic-agent-memory-aaaa-1112-0001.json
  // with safe, synthetic values). Never touches data.json.
  // These tests run from the repo root (see the test:memory-compaction npm
  // script), so process.cwd() resolves the source prompt and fixture files.
  const promptTemplate = readFileSync(join(process.cwd(), "prompts", "memory-compaction.md"), "utf-8");
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "test", "fixtures", "memory-aaaa-1112-0001.json"), "utf-8"),
  ) as {
    session_id: string;
    plan: string;
    summary: string;
  };
  assert.equal(fixture.session_id, "aaaa-1112-0001", "fixture targets the example session id");

  // (1) Build a session whose memory summary exceeds 50% of the context window.
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  // Use a deterministic over-threshold summary for the session.
  const bigSummary = fixture.summary + " " + "filler ".repeat(40);
  store.summaries.set(fixture.session_id, bigSummary);
  const window = 200;
  assert.equal(
    shouldCompactMemory(bigSummary.length, window, 0.5),
    true,
    "seeded memory exceeds 50% of the test context window",
  );

  // (2)+(3) Trigger compaction against the real adapter stub (highest model).
  adapter.responses = { text: "compacted fixture memory" };
  const compactor = new MemoryCompactor({
    store,
    adapter,
    highestModel: "deepseek-v4-pro",
    promptTemplate,
    contextWindow: window,
    threshold: 0.5,
  });
  const outcome = await compactor.maybeCompact(fixture.session_id, fixture.plan);

  // (4) The real prompt file was rendered with both the plan and the memory, and
  // the highest model was used.
  assert.equal(outcome.attempted, true, "threshold exceeded so compaction is attempted");
  assert.equal(outcome.compacted, true, "compacted output replaces the memory");
  assert.equal(adapter.calls.length, 1, "adapter called once");
  assert.equal(adapter.calls[0].model, "deepseek-v4-pro", "highest model used for compaction");
  const rendered = adapter.calls[0].request.messages[0] as { content?: readonly { text?: string }[] };
  const prompt = rendered.content?.[0]?.text ?? "";
  assert.match(prompt, /MEMORY-COMPACTION/, "real prompt file content is used");
  assert.match(prompt, /without losing important details/, "real prompt's compression contract is used");
  assert.match(prompt, /active plan/, "real prompt's plan section is present");
  assert.match(prompt, /current session memory to compress/, "real prompt's memory section is present");
  assert.match(prompt, new RegExp(fixture.plan.split("\n")[0]), "plan is interpolated into the prompt");
  // The memory summary must appear verbatim (all of it) so the compactor can
  // compress the actual stored memory. Escape only regex-special characters.
  const memorySample = bigSummary.slice(0, 40);
  const escaped = memorySample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(prompt, new RegExp(escaped), "stored memory is interpolated verbatim");

  // (5) The compacted output replaced the memory for the session.
  assert.equal(store.summaries.get(fixture.session_id), "compacted fixture memory", "compacted summary replaces original");
  assert.ok(bigSummary.length > "compacted fixture memory".length, "compaction shrank the memory");
  console.log("  ok: fixture-driven full flow uses real prompt + highest model, passes plan+memory, replaces summary");
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
  await testRealInMemoryBackendCompacts();
  await testFixtureDrivenFullFlow();
  console.log("Memory-compaction tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
