import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmAdapterError, type LlmAdapter } from "../llm/adapter-contract.js";
import { MultiTurnLlmRuntime } from "../llm/multi-turn-runtime.js";

/** Adapter that echoes a distinctive response and reports usage. */
function echoAdapter(finalToolCall = false): LlmAdapter {
  return {
    provider: "mock",
    capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
    async generate(value) {
      const lastUser = [...value.messages].reverse().find((message) => message.role === "user" || message.role === "tool");
      const text = `Echoing ${value.messages.length} messages: ${JSON.stringify(lastUser)}`;
      const message = finalToolCall
        ? { role: "assistant" as const, content: [{ type: "text" as const, text: "Calling tool." }], toolCalls: [{ id: "call-x", name: "Write", arguments: { path: "a.txt", content: "hello" } }] }
        : { role: "assistant" as const, content: [{ type: "text" as const, text }] };
      return {
        model: value.model,
        message,
        finishReason: finalToolCall ? "tool_calls" : "stop",
        usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15, cachedInputTokens: 2 },
      };
    },
  };
}

function readLog(path: string): string {
  return readFileSync(path, "utf-8");
}

async function testLlmLog(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-llm-log-"));
  const logPath = join(directory, "llm.log");
  const originalPath = process.env.LLM_LOG_PATH;
  process.env.LLM_LOG_PATH = logPath;
  // First response produces a tool call (call-x), enabling a valid continuation.
  const runtime = new MultiTurnLlmRuntime(echoAdapter(true), "echo-model");
  try {
    // Initial (planning-style) request with a long, multi-line prompt.
    const firstLine = "Task: write a file.";
    const secondLine = "line2 with some content";
    const filler = `${secondLine}\n`.repeat(100); // long body that must not be truncated.
    const longPrompt = `${firstLine}\n${filler}`;
    const response = await runtime.create({ input: longPrompt });
    assert.equal(typeof response.id, "string");
    assert.ok(response.output.some((output) => output.type === "function_call"), "initial response should carry the tool call");

    // Tool continuation request builds from the prior response ID, referencing
    // the tool call the adapter produced in the first response.
    const continuation = await runtime.create({
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: "call-x", output: JSON.stringify({ ok: true }) }],
    });
    assert.equal(typeof continuation.id, "string");

    // The log file must exist and be non-empty.
    assert.ok(existsSync(logPath), "llm.log should be created");
    const log = readLog(logPath);

    // Every request should be captured as a separated record.
    const records = log.split("=".repeat(64)).filter((block) => block.trim().length > 0);
    assert.equal(records.length, 2, "expected two logged records (initial + continuation)");

    // Request type tags reflect initial vs tool continuation.
    assert.match(records[0], /requestType=initial/);
    assert.match(records[1], /requestType=tool-continuation/);

    // Model name is recorded.
    assert.match(records[0], /model=echo-model/);

    // The full (untruncated) prompt is captured. It is serialized as JSON, so
    // literal newlines become escaped `\n`; assert the first line (no newline)
    // appears verbatim and that all 100 repeated filler lines appear, proving
    // the prompt body was not truncated.
    assert.ok(records[0].includes(firstLine), "first prompt line should be present");
    const escapedFiller = (secondLine + "\\n").repeat(100);
    assert.ok(records[0].includes(escapedFiller), "prompt body should not be truncated (all 100 filler lines captured)");

    // The full response text and the tool call are captured.
    assert.ok(records[0].includes("Calling tool."), "response text should be logged");
    assert.ok(records[0].includes('"name": "Write"'), "tool call name should be logged");

    // Usage is recorded for both entries.
    assert.match(records[0], /"inputTokens":\s*11/);
    assert.match(records[1], /"inputTokens":\s*11/);
  } finally {
    if (originalPath === undefined) delete process.env.LLM_LOG_PATH;
    else process.env.LLM_LOG_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function testInitialLog(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-llm-log-init-"));
  const logPath = join(directory, "llm.log");
  const originalPath = process.env.LLM_LOG_PATH;
  process.env.LLM_LOG_PATH = logPath;
  // Plain text reply (no tool call) for an initial request.
  const runtime = new MultiTurnLlmRuntime(echoAdapter(false), "echo-model");
  try {
    const response = await runtime.create({ input: "Simple request." });
    assert.equal(typeof response.id, "string");
    const log = readLog(logPath);
    assert.ok(log.includes("requestType=initial"), "plain text request should be tagged initial");
    assert.ok(log.includes("Echoing 1 messages"), "plain text response should be logged");
  } finally {
    if (originalPath === undefined) delete process.env.LLM_LOG_PATH;
    else process.env.LLM_LOG_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function testLlmAdapterErrorPrintsPrompt(): Promise<void> {
  const originalConsoleError = console.error;
  let captured = "";
  console.error = ((...args: unknown[]) => {
    captured += `${args.map(String).join(" ")}\n`;
  }) as typeof console.error;
  const failingAdapter: LlmAdapter = {
    provider: "deepseek-v4",
    capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
    async generate() {
      throw new LlmAdapterError("deepseek-v4", "provider", "DeepSeek returned an invalid JSON response.");
    },
  };
  const runtime = new MultiTurnLlmRuntime(failingAdapter, "deepseek-model");
  try {
    await assert.rejects(runtime.create({ input: "prompt that caused the failure" }), /invalid JSON response/);
    assert.ok(captured.includes("[LLM ADAPTER ERROR]"), "adapter errors should print a marker");
    assert.ok(captured.includes("prompt that caused the failure"), "adapter errors should print the prompt that caused the error");
  } finally {
    console.error = originalConsoleError;
  }
}

async function testLlmLogToolCallResponse(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-llm-log-tool-"));
  const logPath = join(directory, "llm.log");
  const originalPath = process.env.LLM_LOG_PATH;
  process.env.LLM_LOG_PATH = logPath;
  // Adapter emits a tool call so we can validate tool calls appear in the response.
  const runtime = new MultiTurnLlmRuntime(echoAdapter(true), "tool-model");
  try {
    await runtime.create({ input: "Please write a file." });
    const log = readLog(logPath);
    assert.ok(log.includes("Calling tool."), "tool-call response text should be logged");
    assert.ok(log.includes('"name": "Write"'), "tool call name should be logged");
    assert.ok(log.includes('"path": "a.txt"'), "tool call arguments should be logged");
  } finally {
    if (originalPath === undefined) delete process.env.LLM_LOG_PATH;
    else process.env.LLM_LOG_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  await testLlmLog();
  await testInitialLog();
  await testLlmAdapterErrorPrintsPrompt();
  await testLlmLogToolCallResponse();
  console.log("LLM log fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
