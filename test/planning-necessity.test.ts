import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, GenerateResponse, LlmAdapter } from "../llm/adapter-contract.js";
import { MultiTurnLlmRuntime } from "../llm/multi-turn-runtime.js";
import { determinePlanningNecessity, selectExecutionMode } from "../llm/planning-necessity.js";

/**
 * Routing/classification tests for the planning-necessity boundary. The
 * classifier is exercised through the real MultiTurnLlmRuntime with a fixture
 * adapter, so the compatibility response shape and prompt/response logging
 * paths are part of the test rather than bypassed by a hand-rolled mock.
 */

function queueAdapter(responses: string[]): { adapter: LlmAdapter; requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  const adapter: LlmAdapter = {
    provider: "fixture",
    capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
    async generate(request) {
      requests.push(request);
      const text = responses.shift() ?? "";
      const response: GenerateResponse = {
        model: request.model,
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        message: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
      };
      return response;
    },
  };
  return { adapter, requests };
}

function userPromptText(requests: GenerateRequest[], index: number): string {
  const message = requests[index]?.messages.find((candidate) => candidate.role === "user");
  assert.ok(message, "expected a user message");
  assert.ok("content" in message, "expected user message content");
  return (message as unknown as { content: readonly { text: string }[] }).content.map((part) => part.text).join("\n");
}

async function testRequiresPlanningTrueRoutesToPlanFlow(): Promise<void> {
  const { adapter, requests } = queueAdapter(['{"requiresPlanning":true,"reason":"cross-cutting multi-file refactor"}']);
  const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
  const result = await determinePlanningNecessity("Refactor the configuration handling across the codebase", runtime);

  assert.equal(result.requiresPlanning, true);
  assert.equal(result.reason, "cross-cutting multi-file refactor");
  assert.equal(selectExecutionMode(result), "plan-then-execute");

  assert.equal(requests.length, 1);
  const prompt = userPromptText(requests, 0);
  assert.ok(prompt.includes("RESPOND IN JSON FORMAT ONLY"), "classifier prompt should include the prompt file text");
  assert.ok(prompt.includes("Refactor the configuration handling across the codebase"), "classifier prompt should include the user request");
  console.log("  ok: requiresPlanning=true routes to plan-then-execute");
}

async function testRequiresPlanningFalseRoutesToSingleStep(): Promise<void> {
  const { adapter, requests } = queueAdapter(['{"requiresPlanning":false,"reason":"single low-risk file edit"}']);
  const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
  const result = await determinePlanningNecessity("Fix the typo in the README title", runtime);

  assert.equal(result.requiresPlanning, false);
  assert.equal(result.reason, "single low-risk file edit");
  assert.equal(selectExecutionMode(result), "single-step");

  assert.equal(requests.length, 1);
  const prompt = userPromptText(requests, 0);
  assert.ok(prompt.includes("Fix the typo in the README title"), "classifier prompt should include the user request");
  console.log("  ok: requiresPlanning=false routes to single-step");
}

async function testFencedJsonIsAccepted(): Promise<void> {
  const { adapter } = queueAdapter(['```json\n{"requiresPlanning":false,"reason":"markdown-fenced JSON"}\n```']);
  const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
  const result = await determinePlanningNecessity("Add a short note to CLAUDE.md", runtime);

  assert.equal(result.requiresPlanning, false);
  assert.equal(result.reason, "markdown-fenced JSON");
  assert.equal(selectExecutionMode(result), "single-step");
  console.log("  ok: fenced JSON classification is accepted");
}

async function testInvalidJsonFallsBackToPlanning(): Promise<void> {
  const { adapter, requests } = queueAdapter(["this is not json", "still not json", "nope"]);
  const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
  const result = await determinePlanningNecessity("Ship the release", runtime);

  assert.equal(result.requiresPlanning, true);
  assert.match(result.reason, /fell back to planning/);
  assert.equal(selectExecutionMode(result), "plan-then-execute");

  assert.equal(requests.length, 3, "classifier should retry up to the existing 3-attempt limit");
  assert.ok(userPromptText(requests, 1).includes("The previous response was not valid JSON"), "retry prompt should append the parse error");
  assert.ok(userPromptText(requests, 2).includes("The previous response was not valid JSON"), "second retry should append the parse error");
  console.log("  ok: invalid JSON retries then falls back to planning");
}

async function testMissingJsonFallsBackToPlanning(): Promise<void> {
  const { adapter, requests } = queueAdapter(["", "", ""]);
  const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
  const result = await determinePlanningNecessity("Do the thing", runtime);

  assert.equal(result.requiresPlanning, true);
  assert.match(result.reason, /fell back to planning/);
  assert.equal(selectExecutionMode(result), "plan-then-execute");
  assert.equal(requests.length, 3, "empty classifier responses should also exhaust the retry limit");
  console.log("  ok: missing JSON retries then falls back to planning");
}

async function testInvalidJsonRecoversOnRetry(): Promise<void> {
  const { adapter, requests } = queueAdapter(["not json", '{"requiresPlanning":true,"reason":"retry produced a valid classification"}']);
  const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
  const result = await determinePlanningNecessity("Deploy the service", runtime);

  assert.equal(result.requiresPlanning, true);
  assert.equal(result.reason, "retry produced a valid classification");
  assert.equal(selectExecutionMode(result), "plan-then-execute");
  assert.equal(requests.length, 2, "classifier should stop retrying once valid JSON is returned");
  console.log("  ok: invalid JSON recovers on the first retry");
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-planning-necessity-"));
  const originalLogPath = process.env.LLM_LOG_PATH;
  process.env.LLM_LOG_PATH = join(directory, "llm.log");
  try {
    await testRequiresPlanningTrueRoutesToPlanFlow();
    await testRequiresPlanningFalseRoutesToSingleStep();
    await testFencedJsonIsAccepted();
    await testInvalidJsonFallsBackToPlanning();
    await testMissingJsonFallsBackToPlanning();
    await testInvalidJsonRecoversOnRetry();
    console.log("Planning necessity classification and routing tests passed");
  } finally {
    if (originalLogPath === undefined) delete process.env.LLM_LOG_PATH;
    else process.env.LLM_LOG_PATH = originalLogPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
