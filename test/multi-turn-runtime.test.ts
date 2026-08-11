import assert from "node:assert/strict";
import { MultiTurnLlmRuntime } from "../llm/multi-turn-runtime.js";
import type { GenerateRequest, LlmAdapter } from "../llm/adapter-contract.js";

async function main(): Promise<void> {
const requests: GenerateRequest[] = [];
const adapter: LlmAdapter = {
  provider: "fixture",
  capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
  async generate(request) {
    requests.push(request);
    if (requests.length === 1) {
      return {
        id: "provider-first",
        model: request.model,
        finishReason: "tool_calls",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 1 },
        message: { role: "assistant", content: [{ type: "text", text: "I will inspect." }], toolCalls: [{ id: "call-1", name: "Read", arguments: { path: "CLAUDE.md" } }] },
      };
    }
    return {
      id: "provider-second",
      model: request.model,
      finishReason: "stop",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    };
  },
};

const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
const first = await runtime.create({ input: "perform work", tools: [{ type: "function", name: "Read", parameters: { type: "object" } }] });
assert.equal(first.id, "compat-1");
assert.deepEqual(first.usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 1 } });
assert.deepEqual(first.output[1], { type: "function_call", call_id: "call-1", name: "Read", arguments: '{"path":"CLAUDE.md"}' });
const second = await runtime.create({ previous_response_id: first.id, input: [{ type: "function_call_output", call_id: "call-1", output: '{"content":"instructions"}' }] });
assert.equal(second.id, "compat-2");
assert.equal(second.output[0].type, "message");
assert.equal(requests.length, 2);
assert.equal(requests[1].messages.length, 3);
assert.deepEqual(requests[1].messages[2], { role: "tool", toolCallId: "call-1", content: { content: "instructions" }, isError: false });
await assert.rejects(runtime.create({ previous_response_id: "missing", input: [] }), /unknown previous_response_id/);
console.log("Multi-turn compatibility runtime tests passed");

}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
