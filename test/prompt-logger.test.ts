import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmAdapter } from "../llm/adapter-contract.js";
import { MultiTurnLlmRuntime } from "../llm/multi-turn-runtime.js";
import {
  appendPromptLog,
  formatPrompt,
  PROMPT_REQUEST_TYPE_INITIAL,
  type PromptLogRecord,
} from "../llm/prompt-logger.js";

/** A simple adapter that echoes a plain text response (no tool call). */
function echoAdapter(): LlmAdapter {
  return {
    provider: "mock",
    capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
    async generate(value) {
      return {
        model: value.model,
        message: { role: "assistant", content: [{ type: "text", text: "Hello." }] },
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };
    },
  };
}

function readLog(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Verify the logger writes the prompt payload to prompt.log via the runtime. */
async function testWritesPromptContent(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-prompt-log-"));
  const logPath = join(directory, "prompt.log");
  const originalPath = process.env.PROMPT_LOG_PATH;
  process.env.PROMPT_LOG_PATH = logPath;
  const runtime = new MultiTurnLlmRuntime(echoAdapter(), "echo-model", undefined, { logPrompts: true });
  try {
    await runtime.create({ input: "A distinct prompt for the log." });
    assert.ok(existsSync(logPath), "prompt.log should be created when --log-prompts is on");
    const log = readLog(logPath);
    assert.ok(log.includes("requestType=initial"), "record should carry requestType tag");
    assert.ok(log.includes("model=echo-model"), "record should carry the model name");
    assert.ok(log.includes("A distinct prompt for the log."), "prompt content should be written verbatim");
    assert.ok(log.includes("--- PROMPT ---"), "record should include the PROMPT banner");
  } finally {
    if (originalPath === undefined) delete process.env.PROMPT_LOG_PATH;
    else process.env.PROMPT_LOG_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Verify subsequent calls append rather than overwrite the file. */
async function testAppendsAcrossMultipleCalls(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-prompt-append-"));
  const logPath = join(directory, "prompt.log");
  const originalPath = process.env.PROMPT_LOG_PATH;
  process.env.PROMPT_LOG_PATH = logPath;
  const runtime = new MultiTurnLlmRuntime(echoAdapter(), "append-model", undefined, { logPrompts: true });
  try {
    await runtime.create({ input: "first prompt" });
    const sizeAfterFirst = statSync(logPath).size;
    assert.ok(sizeAfterFirst > 0, "first call should produce a non-empty log");
    await runtime.create({ input: "second prompt" });
    await runtime.create({ input: "third prompt" });
    const log = readLog(logPath);
    assert.ok(log.includes("first prompt"), "first prompt should remain after appending");
    assert.ok(log.includes("second prompt"), "second prompt should be appended");
    assert.ok(log.includes("third prompt"), "third prompt should be appended");
    // Both records present -> append behavior (not overwrite).
    const records = log.split("=".repeat(64)).filter((block) => block.trim().length > 0);
    assert.equal(records.length, 3, "three calls should produce three log records");
  } finally {
    if (originalPath === undefined) delete process.env.PROMPT_LOG_PATH;
    else process.env.PROMPT_LOG_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Verify the disabled flag produces no log file and no error. */
async function testDisabledFlagProducesNoLog(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-prompt-disabled-"));
  const logPath = join(directory, "prompt.log");
  const originalPath = process.env.PROMPT_LOG_PATH;
  process.env.PROMPT_LOG_PATH = logPath;
  // logPrompts intentionally omitted / false.
  const runtimeDefault = new MultiTurnLlmRuntime(echoAdapter(), "m1");
  const runtimeExplicit = new MultiTurnLlmRuntime(echoAdapter(), "m2", undefined, { logPrompts: false });
  try {
    await runtimeDefault.create({ input: "should not be logged (default)" });
    await runtimeExplicit.create({ input: "should not be logged (explicit false)" });
    assert.ok(!existsSync(logPath), "prompt.log should NOT be created when logPrompts is off");
  } finally {
    if (originalPath === undefined) delete process.env.PROMPT_LOG_PATH;
    else process.env.PROMPT_LOG_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Verify a file write failure is swallowed and never crashes the flow. */
async function testWriteErrorDoesNotCrash(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-prompt-error-"));
  const logPath = join(directory, "missing-dir", "prompt.log");
  const originalPath = process.env.PROMPT_LOG_PATH;
  // A path whose parent directory is a file, so mkdirSync/appendFileSync fails.
  const badPath = join(directory, "blocked");
  process.env.PROMPT_LOG_PATH = join(badPath, "prompt.log");
  assert.doesNotThrow(() => appendPromptLog({
    timestamp: new Date().toISOString(),
    requestType: PROMPT_REQUEST_TYPE_INITIAL,
    model: "m",
    prompt: formatPrompt([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
  }));
  // The runtime path must also survive a write failure and still return a response.
  const runtime = new MultiTurnLlmRuntime(echoAdapter(), "fail-model", undefined, { logPrompts: true });
  try {
    const response = await runtime.create({ input: "still works" });
    assert.equal(typeof response.id, "string", "LLM flow must continue despite log write failure");
    assert.ok(response.output.some((output) => output.type === "message"), "response should still be produced");
  } finally {
    if (originalPath === undefined) delete process.env.PROMPT_LOG_PATH;
    else process.env.PROMPT_LOG_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Direct appendPromptLog unit coverage (record shape + banner). */
async function testAppendPromptLogDirect(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-prompt-direct-"));
  const logPath = join(directory, "prompt.log");
  const originalPath = process.env.PROMPT_LOG_PATH;
  process.env.PROMPT_LOG_PATH = logPath;
  const record: PromptLogRecord = {
    timestamp: "2024-01-01T00:00:00.000Z",
    requestType: PROMPT_REQUEST_TYPE_INITIAL,
    model: "direct-model",
    prompt: formatPrompt([{ role: "user", content: [{ type: "text", text: "direct write" }] }]),
  };
  try {
    appendPromptLog(record);
    const log = readLog(logPath);
    assert.ok(log.includes("[2024-01-01T00:00:00.000Z] requestType=initial model=direct-model"));
    assert.ok(log.includes("direct write"), "serialized prompt content should appear");
  } finally {
    if (originalPath === undefined) delete process.env.PROMPT_LOG_PATH;
    else process.env.PROMPT_LOG_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  await testWritesPromptContent();
  await testAppendsAcrossMultipleCalls();
  await testDisabledFlagProducesNoLog();
  await testWriteErrorDoesNotCrash();
  await testAppendPromptLogDirect();
  console.log("Prompt logger tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
