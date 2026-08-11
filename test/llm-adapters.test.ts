import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmAdapterError, type GenerateRequest, type LlmAdapter } from "../llm/adapter-contract.js";
import { LlmAdapterRegistry, resolveAdapterConfiguration } from "../llm/adapter-registry.js";
import { createRuntimeLlmAdapter, createRuntimeLlmRegistry, loadRuntimeEnvironment } from "../llm/application.js";
import { OpenAiAdapter } from "../llm/openai-adapter.js";
import { BedrockClaudeAdapter } from "../llm/bedrock-claude-adapter.js";
import { DeepSeekV4Adapter } from "../llm/deepseek-v4-adapter.js";

const request: GenerateRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: [{ type: "text", text: "System rules" }] },
    { role: "developer", content: [{ type: "text", text: "Developer rules" }] },
    { role: "user", content: [{ type: "text", text: "What is the weather?" }] },
    { role: "assistant", content: [{ type: "text", text: "Checking." }], toolCalls: [{ id: "call-1", name: "weather", arguments: { city: "Paris" } }] },
    { role: "tool", toolCallId: "call-1", content: { temperature: 22 }, isError: false },
  ],
  tools: [{ type: "function", name: "weather", description: "Looks up weather", parameters: { type: "object" } }],
  toolChoice: { name: "weather" },
  maxOutputTokens: 123,
  temperature: 0.25,
};

async function expectAdapterError(action: () => Promise<unknown>, provider: string, code: string, retryable: boolean): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof LlmAdapterError);
    const actual = error as LlmAdapterError;
    assert.equal(actual.provider, provider);
    assert.equal(actual.code, code);
    assert.equal(actual.retryable, retryable);
    return true;
  });
}

async function testRegistry(): Promise<void> {
  const adapter: LlmAdapter = {
    provider: "mock",
    capabilities: { toolCalling: false, systemMessages: true, developerMessages: true },
    async generate(value) {
      return { model: value.model, message: { role: "assistant", content: [] }, finishReason: "stop" };
    },
  };
  let factoryOptions: Readonly<Record<string, unknown>> | undefined;
  const registry = new LlmAdapterRegistry([{ provider: "mock", create: (options) => {
    factoryOptions = options;
    return adapter;
  } }]);

  assert.deepEqual(registry.providers(), ["mock"]);
  assert.equal(resolveAdapterConfiguration({ provider: " MOCK ", options: { enabled: true } }, { LLM_PROVIDER: "ignored" }).provider, "mock");
  assert.equal((await registry.createFromEnvironment({ options: { enabled: true } }, { LLM_PROVIDER: "mock" })).provider, "mock");
  assert.deepEqual(factoryOptions, { enabled: true });
  assert.ok(Object.isFrozen(factoryOptions));
  await assert.rejects(() => registry.create({ provider: "missing" }), /No LLM adapter factory/);
  assert.throws(() => registry.register({ provider: "MOCK", create: () => adapter }), /already registered/);
}

async function testRuntimeComposition(): Promise<void> {
  assert.deepEqual(createRuntimeLlmRegistry().providers(), ["bedrock-claude", "deepseek-v4", "openai"]);

  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-runtime-"));
  const filename = join(directory, ".env");
  const originalProvider = process.env.LLM_PROVIDER;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
    writeFileSync(filename, "LLM_PROVIDER=deepseek-v4\nDEEPSEEK_API_KEY=test-runtime-key\n", { mode: 0o600 });
    const environment = loadRuntimeEnvironment(filename);
    assert.equal(environment.LLM_PROVIDER, "deepseek-v4");
    assert.equal((await createRuntimeLlmAdapter({ environment })).provider, "deepseek-v4");
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function testOpenAi(): Promise<void> {
  let payload: Record<string, unknown> | undefined;
  let signal: AbortSignal | undefined;
  const client = { responses: { create: async (value: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    payload = value;
    signal = options?.signal;
    return {
      id: "response-1",
      model: "openai-model",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "It is sunny." }] },
        { type: "function_call", call_id: "call-2", name: "weather", arguments: '{"city":"Rome"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 2 } },
    };
  } } };
  const controller = new AbortController();
  const result = await new OpenAiAdapter(client).generate({ ...request, signal: controller.signal });
  assert.equal(result.id, "response-1");
  assert.equal(result.model, "openai-model");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.message, { role: "assistant", content: [{ type: "text", text: "It is sunny." }], toolCalls: [{ id: "call-2", name: "weather", arguments: { city: "Rome" } }] });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2 });
  assert.equal(payload?.store, false);
  assert.equal(payload?.tool_choice instanceof Object, true);
  assert.equal(signal, controller.signal);

  const failing = new OpenAiAdapter({ responses: { create: async () => { throw { status: 429, message: "slow down" }; } } });
  await expectAdapterError(() => failing.generate(request), "openai", "rate_limited", true);
}

async function testBedrock(): Promise<void> {
  let payload: Record<string, unknown> | undefined;
  let abortSignal: AbortSignal | undefined;
  const client = { converse: async (value: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => {
    payload = value;
    abortSignal = options?.abortSignal;
    return {
      $metadata: { requestId: "request-1" },
      stopReason: "tool_use",
      output: { message: { content: [{ text: "Using tool." }, { toolUse: { toolUseId: "call-3", name: "weather", input: { city: "Berlin" } } }] } },
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, cacheReadInputTokens: 1 },
    };
  } };
  const controller = new AbortController();
  const result = await new BedrockClaudeAdapter(client).generate({ ...request, signal: controller.signal });
  assert.equal(result.id, "request-1");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.message.toolCalls, [{ id: "call-3", name: "weather", arguments: { city: "Berlin" } }]);
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 3, totalTokens: 11, cachedInputTokens: 1 });
  assert.deepEqual(payload?.system, [{ text: "System rules" }, { text: "Developer instructions:\nDeveloper rules" }]);
  assert.equal((payload?.messages as Array<Record<string, unknown>>).length, 3);
  assert.deepEqual((payload?.toolConfig as { toolChoice: unknown }).toolChoice, { tool: { name: "weather" } });
  assert.equal(abortSignal, controller.signal);

  const failing = new BedrockClaudeAdapter({ converse: async () => { throw { $metadata: { httpStatusCode: 403 }, message: "denied" }; } });
  await expectAdapterError(() => failing.generate(request), "bedrock-claude", "authentication", false);
}

async function testDeepSeek(): Promise<void> {
  let url = "";
  let init: RequestInit | undefined;
  const fetcher = async (input: string, value: RequestInit): Promise<Response> => {
    url = input;
    init = value;
    return new Response(JSON.stringify({
      id: "chat-1",
      model: "deepseek-v4-pro",
      choices: [{ finish_reason: "tool_calls", message: { content: "Calling tool.", tool_calls: [{ id: "call-4", type: "function", function: { name: "weather", arguments: '{"city":"Tokyo"}' } }] } }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, prompt_cache_hit_tokens: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const result = await new DeepSeekV4Adapter("test-key", "https://deepseek.example/v1/", fetcher).generate(request);
  assert.equal(url, "https://deepseek.example/v1/chat/completions");
  assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
  const sent = JSON.parse(init?.body as string) as { messages: Array<{ role: string; content: string }>; tool_choice: unknown };
  assert.deepEqual(sent.messages.slice(0, 2), [{ role: "system", content: "System rules" }, { role: "system", content: "Developer instructions:\nDeveloper rules" }]);
  assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "weather" } });
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.message.toolCalls, [{ id: "call-4", name: "weather", arguments: { city: "Tokyo" } }]);
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2, totalTokens: 9, cachedInputTokens: 1 });

  const failing = new DeepSeekV4Adapter("test-key", "https://deepseek.example/v1", async () => new Response("busy", { status: 503, statusText: "Busy" }));
  await expectAdapterError(() => failing.generate(request), "deepseek-v4", "unavailable", true);
}

/** Build a DeepSeek adapter whose fetcher returns the supplied function arguments verbatim. */
function deepSeekWithArguments(argumentsValue: string): DeepSeekV4Adapter {
  const fetcher = async (): Promise<Response> => new Response(JSON.stringify({
    id: "chat-repair",
    model: "deepseek-v4-pro",
    choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "call-r", type: "function", function: { name: "weather", arguments: argumentsValue } }] } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  return new DeepSeekV4Adapter("test-key", "https://deepseek.example/v1", fetcher);
}

/** Adapter fixture whose first call returns unrepairable JSON arguments and whose second returns valid arguments. */
function deepSeekWithRetry(argumentsValues: [string, string]): {
  adapter: DeepSeekV4Adapter;
  calls: Array<{ payload: { messages: Array<{ role: string; content: string }> }; url: string }>;
} {
  const calls: Array<{ payload: { messages: Array<{ role: string; content: string }> }; url: string }> = [];
  let attempt = 0;
  const fetcher = async (input: string, init: RequestInit): Promise<Response> => {
    attempt++;
    const payload = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> };
    calls.push({ payload, url: input });
    const args = argumentsValues[Math.min(attempt, argumentsValues.length) - 1];
    return new Response(JSON.stringify({
      id: `chat-retry-${attempt}`,
      model: "deepseek-v4-pro",
      choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: `call-r${attempt}`, type: "function", function: { name: "weather", arguments: args } }] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { adapter: new DeepSeekV4Adapter("test-key", "https://deepseek.example/v1", fetcher), calls };
}

async function testDeepSeekJsonRepair(): Promise<void> {
  // Common LLM-produced malformations that fail strict JSON.parse but are repaired.
  const cases: Array<[string, Record<string, unknown>]> = [
    // Trailing comma.
    ['{"city":"Paris","temp":22,}', { city: "Paris", temp: 22 }],
    // Unquoted keys.
    ['{city: "Paris", temp: 22}', { city: "Paris", temp: 22 }],
    // Single-quoted keys and string values.
    ["{'city': 'Paris', 'temp': 22}", { city: "Paris", temp: 22 }],
    // Single quotes plus unquoted values and undefined.
    ["{city: 'Paris', note: undefined}", { city: "Paris", note: null }],
    // Comments and trailing prose wrapped around an object.
    ["Here is the result: { city: 'Paris', /* ok */ temp: 22, } // done", { city: "Paris", temp: 22 }],
  ];
  for (const [raw, expected] of cases) {
    const result = await deepSeekWithArguments(raw).generate(request);
    assert.deepEqual(result.message.toolCalls, [{ id: "call-r", name: "weather", arguments: expected }], `repairing: ${raw}`);
  }

  // Trailing garbage removal: prose/markup appended after the object's closing
  // brace must be trimmed without corrupting the object, even when that garbage
  // itself contains brace characters or the payload's string values embed
  // braces. `outerObjectEnd` locates the real top-level closing brace rather
  // than relying on `lastIndexOf("}")`.
  const trailingGarbageCases: Array<[string, Record<string, unknown>]> = [
    // Simple trailing comment.
    ['{"city":"Paris"} // Enjoy', { city: "Paris" }],
    // Trailing prose containing a stray closing brace (would break lastIndexOf).
    ['{"city":"Paris"} done } more', { city: "Paris" }],
    // Leading prose plus trailing prose.
    ["Here is the result: {\"city\":\"Paris\"} Regards, Bob.", { city: "Paris" }],
    // Trailing markup with braces after a value that itself contains a brace.
    ['{"content":"a}b"} trailing } more', { content: "a}b" }],
    // Nested object: trailing garbage must not strip the nested closing braces.
    ['{"nested":{"a":"b"},"x":1} trailing', { nested: { a: "b" }, x: 1 }],
  ];
  for (const [raw, expected] of trailingGarbageCases) {
    const result = await deepSeekWithArguments(raw).generate(request);
    assert.deepEqual(result.message.toolCalls, [{ id: "call-r", name: "weather", arguments: expected }], `trailing garbage: ${raw}`);
  }

  // Progressive truncation: output truncated mid-way through a value/string
  // cannot be repaired by simple brace balancing (the unterminated string
  // swallows the balance scan). The adapter must walk backward, truncating at
  // structural boundaries, re-completing delimiters, and recover the longest
  // valid prefix.
  const truncationCases: Array<[string, Record<string, unknown>]> = [
    // Truncated mid-string value: unterminated `content` string.
    ['{"city":"Paris","content":"The file is at', { city: "Paris" }],
    // Truncated before a value: `temp` key has no value.
    ['{"city":"Paris","temp":', { city: "Paris" }],
    // Truncated after `temp` key name.
    ['{"city":"Paris","temp', { city: "Paris" }],
    // Truncated inside a comma-separated list (would have had more fields).
    ['{"city":"Paris","temp":22,', { city: "Paris", temp: 22 }],
    // Truncated mid-write-content (realistic: content string cut off).
    ['{"path":"a.txt","content":"line1\\nline2', { path: "a.txt" }],
    // Truncated nested object: array of files cut off mid-list.
    ['{"files":[{"path":"a.txt","content":"hi"},{"path":"b.txt","cont', { files: [{ path: "a.txt", content: "hi" }] }],
    // Truncated mid-array value.
    ['{"items":["a","b","c', { items: ["a", "b"] }],
    // Truncation with a trailing comma after complete value.
    ['{"path":"a.txt","content":"done",', { path: "a.txt", content: "done" }],
    // Truncated multi-line content with embedded brace inside the string.
    ['{"path":"src/app.ts","content":"export function foo() {\\n  return {', { path: "src/app.ts" }],
  ];
  for (const [raw, expected] of truncationCases) {
    const result = await deepSeekWithArguments(raw).generate(request);
    assert.deepEqual(result.message.toolCalls, [{ id: "call-r", name: "weather", arguments: expected }], `progressive truncation: ${raw}`);
  }

  // Retry with prompt hint: when repair of tool-call arguments fails on the
  // first call, the adapter retries the API call exactly once with an appended
  // system hint asking for pure JSON, and returns the repaired result.
  {
    const { adapter, calls } = deepSeekWithRetry(["not json at all", '{"city":"Paris","temp":22}']);
    const result = await adapter.generate(request);
    assert.deepEqual(result.message.toolCalls, [{ id: "call-r2", name: "weather", arguments: { city: "Paris", temp: 22 } }]);
    assert.equal(calls.length, 2, "retry should issue exactly two API calls");
    assert.equal(calls[0].url, "https://deepseek.example/v1/chat/completions");
    assert.equal(calls[1].url, "https://deepseek.example/v1/chat/completions");
    // The retry payload must carry the JSON purity hint as a trailing system message.
    const firstMessages = calls[0].payload.messages;
    const retryMessages = calls[1].payload.messages;
    assert.equal(retryMessages.length, firstMessages.length + 1, "retry adds one hint message");
    const hint = retryMessages[retryMessages.length - 1];
    assert.equal(hint.role, "system");
    assert.match(hint.content, /pure, well-formed JSON/i);
    assert.match(hint.content, /no markdown code fences/i);
  }

  // Retry also fails: when both the first call and the retry return unrepairable
  // arguments, the adapter propagates the (retry) provider error and only issues
  // two calls total.
  {
    const { adapter, calls } = deepSeekWithRetry(["not json at all", "still not json"]);
    await assert.rejects(() => adapter.generate(request), (error: unknown) => {
      assert.ok(error instanceof LlmAdapterError);
      assert.equal(error.provider, "deepseek-v4");
      assert.equal(error.code, "provider");
      assert.equal(error.retryable, false);
      assert.match(error.message, /invalid JSON arguments/);
      assert.match(error.message, /All parsing strategies failed/);
      return true;
    });
    assert.equal(calls.length, 2, "retry should still limit to two calls when both fail");
  }

  // Unrepairable input on both calls (single-argument fixture returns the same
  // value each time) must still raise a provider error (not crash) and surface
  // the raw arguments plus the attempted strategies in the message for debugging.
  const rawArguments = "not json at all";
  const broken = deepSeekWithArguments(rawArguments);
  await assert.rejects(() => broken.generate(request), (error: unknown) => {
    assert.ok(error instanceof LlmAdapterError);
    assert.equal(error.provider, "deepseek-v4");
    assert.equal(error.code, "provider");
    assert.equal(error.retryable, false);
    assert.match(error.message, /invalid JSON arguments/);
    assert.match(error.message, /weather/);
    assert.match(error.message, /Raw arguments for debugging/);
    assert.ok(error.message.includes(rawArguments), `error should include raw arguments: ${error.message}`);
    assert.match(error.message, /All parsing strategies failed/);
    return true;
  });

  // Valid JSON must be parsed identically (no regression).
  const valid = await deepSeekWithArguments('{"city":"Oslo","temp":5}').generate(request);
  assert.deepEqual(valid.message.toolCalls, [{ id: "call-r", name: "weather", arguments: { city: "Oslo", temp: 5 } }]);
}

(async () => {
  await testRegistry();
  await testRuntimeComposition();
  await testOpenAi();
  await testBedrock();
  await testDeepSeek();
  await testDeepSeekJsonRepair();
  console.log("LLM adapter fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
