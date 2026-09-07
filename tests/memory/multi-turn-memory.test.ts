import assert from "node:assert/strict";
import { MultiTurnLlmRuntime, memoryContextSuffix } from "../../src/llm/multi-turn-runtime.js";
import type { GenerateRequest, LlmAdapter } from "../../src/llm/adapter-contract.js";
import type { ContextRequest, MemoryContextResult, MemoryModule } from "../../src/memory/types.js";

/** A fake MemoryModule that returns a fixed MemoryContextResult. */
class StubMemory implements MemoryModule {
  result: MemoryContextResult;
  calls: { sessionId: string }[] = [];
  constructor(result: MemoryContextResult) {
    this.result = result;
  }
  async remember(): Promise<void> {
    // not exercised by the runtime; only getContext is used for prompt context
  }
  async getContext(request: ContextRequest): Promise<MemoryContextResult> {
    this.calls.push({ sessionId: request.session_id });
    return this.result;
  }
}

/** A MemoryModule whose getContext rejects (to verify fail-safe behavior). */
class ThrowingMemory implements MemoryModule {
  async remember(): Promise<void> {}
  async getContext(): Promise<MemoryContextResult> {
    throw new Error("boom");
  }
}

/** Extract the initial (user) message text of a GenerateRequest. */
function initialText(request: GenerateRequest): string {
  const msg = request.messages[0];
  if (!msg || msg.role !== "user") return "";
  return msg.content[0]?.text ?? "";
}

async function main(): Promise<void> {
  // --- memoryContextSuffix pure helper ---
  assert.equal(memoryContextSuffix({ text: "remembered: read CLAUDE.md", matchedContexts: [], hasMemory: true }),
    "\n\n[SESSION MEMORY — additional context remembered from earlier in this session]\nremembered: read CLAUDE.md");
  assert.equal(memoryContextSuffix({ text: "", matchedContexts: [], hasMemory: true }), "");
  assert.equal(memoryContextSuffix({ text: "nope", matchedContexts: [], hasMemory: false }), "");
  assert.equal(memoryContextSuffix({ text: "   ", matchedContexts: [], hasMemory: true }), "");

  // --- a runtime with an attached MemoryModule injects context into the initial prompt ---
  const requests: GenerateRequest[] = [];
  const adapter: LlmAdapter = {
    provider: "fixture",
    capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
    async generate(request) {
      requests.push(request);
      return {
        id: "provider-1",
        model: request.model,
        finishReason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      };
    },
  };
  const memory = new StubMemory({ text: "remembered: inspected repo layout", matchedContexts: [], hasMemory: true });
  const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { memory, sessionId: "sess-1" });
  await runtime.create({ input: "perform work" });
  assert.equal(requests.length, 1);
  const first = initialText(requests[0]);
  assert.ok(first.startsWith("perform work"), "the original prompt must lead the request so the stable prefix is preserved");
  assert.ok(first.includes("[SESSION MEMORY — additional context remembered from earlier in this session]"), "memory context should be appended");
  assert.ok(first.includes("remembered: inspected repo layout"));
  assert.ok(first.endsWith("remembered: inspected repo layout"), "memory context should trail the original prompt");
  assert.deepEqual(memory.calls[0], { sessionId: "sess-1" });

  // --- changing the remembered text affects only the trailing memory suffix ---
  requests.length = 0;
  const changedMemory = new StubMemory({ text: "different remembered content", matchedContexts: [], hasMemory: true });
  const changedRuntime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, {
    memory: changedMemory,
    sessionId: "sess-changed",
  });
  await changedRuntime.create({ input: "perform work" });
  const changed = initialText(requests[0]);
  assert.ok(changed.startsWith("perform work"), "changing memory must not shift the leading user input");
  assert.ok(changed.includes("[SESSION MEMORY"), "the memory suffix should still be appended");
  assert.ok(changed.endsWith("different remembered content"), "the trailing suffix should reflect the new memory text");
  assert.ok(!changed.endsWith("remembered: inspected repo layout"), "the old memory text must not leak into the suffix");

  // --- a session_id on the request overrides the runtime-level session id ---
  requests.length = 0;
  await runtime.create({ input: "another", session_id: "sess-2" });
  assert.deepEqual(memory.calls[1], { sessionId: "sess-2" });

  // --- no context (hasMemory=false) leaves the prompt unchanged ---
  requests.length = 0;
  const emptyMemory = new StubMemory({ text: "", matchedContexts: [], hasMemory: false });
  const emptyRuntime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { memory: emptyMemory, sessionId: "sess-3" });
  await emptyRuntime.create({ input: "plain prompt" });
  assert.equal(initialText(requests[0]), "plain prompt");

  // --- attaching memory via attachMemory() enables context injection later ---
  requests.length = 0;
  const attachRuntime = new MultiTurnLlmRuntime(adapter, "fixture-model");
  await attachRuntime.create({ input: "before attach" });
  assert.equal(initialText(requests[0]), "before attach");
  assert.equal(attachRuntime.hasMemory(), false);
  attachRuntime.attachMemory(memory, "sess-4");
  assert.equal(attachRuntime.hasMemory(), true);
  await attachRuntime.create({ input: "after attach" });
  assert.ok(initialText(requests[1]).startsWith("after attach"), "the original prompt must stay first");
  assert.ok(initialText(requests[1]).endsWith("remembered: inspected repo layout"), "memory context should be appended after the prompt");

  // --- without a session id the runtime does not consult memory ---
  requests.length = 0;
  memory.calls.length = 0;
  const noSessionRuntime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { memory });
  await noSessionRuntime.create({ input: "no session" });
  assert.equal(initialText(requests[0]), "no session");
  assert.equal(memory.calls.length, 0, "getContext should not be called without a session id");

  // --- a rejected getContext is fail-safe: the prompt proceeds unchanged ---
  requests.length = 0;
  const logging: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logging.push(args); };
  try {
    const failingRuntime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, {
      memory: new ThrowingMemory(),
      sessionId: "sess-5",
    });
    await failingRuntime.create({ input: "still works" });
    assert.equal(initialText(requests[0]), "still works");
  } finally {
    console.error = realError;
  }
  const logged = String(logging.join(" "));
  assert.ok(logged.includes("boom"), `getContext failure should be logged non-fatally; got: ${logged}`);

  // --- backward compatibility: constructing with only adapter/model still works ---
  requests.length = 0;
  const legacyRuntime = new MultiTurnLlmRuntime(adapter, "fixture-model");
  await legacyRuntime.create({ input: "legacy" });
  assert.equal(initialText(requests[0]), "legacy");

  console.log("Multi-turn runtime memory-context integration tests passed");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
