import assert from "node:assert/strict";
import { resolveRuntimeLlmModel } from "../llm/application.js";
import { resolveModelConfiguration } from "../llm/model-defaults.js";

(() => {
  assert.deepEqual(resolveModelConfiguration("openai"), {
    provider: "openai",
    model: "gpt-4.1-mini",
    environmentVariable: "OPENAI_MODEL",
  });
  assert.deepEqual(resolveModelConfiguration("bedrock-claude"), {
    provider: "bedrock-claude",
    model: "anthropic.claude-sonnet-4-20250514-v1:0",
    environmentVariable: "BEDROCK_CLAUDE_MODEL",
  });
  assert.deepEqual(resolveModelConfiguration("deepseek-v4"), {
    provider: "deepseek-v4",
    model: "deepseek-chat",
    environmentVariable: "DEEPSEEK_MODEL",
  });

  assert.equal(resolveModelConfiguration("openai", {
    OPENAI_MODEL: "gpt-4.1",
    DEEPSEEK_MODEL: "must-not-be-read",
  }).model, "gpt-4.1");
  assert.equal(resolveModelConfiguration("bedrock-claude", {
    BEDROCK_CLAUDE_MODEL: "anthropic.claude-sonnet-4-20250514-v1:0",
    OPENAI_MODEL: "must-not-be-read",
  }).model, "anthropic.claude-sonnet-4-20250514-v1:0");
  assert.equal(resolveModelConfiguration("deepseek-v4", {
    DEEPSEEK_MODEL: "deepseek-v4-flash",
    OPENAI_MODEL: "must-not-be-read",
  }).model, "deepseek-v4-flash");

  assert.equal(resolveRuntimeLlmModel({
    envFile: false,
    environment: { LLM_PROVIDER: "deepseek-v4", DEEPSEEK_MODEL: "deepseek-v4-pro" },
    configuration: { provider: "openai" },
  }).model, "gpt-4.1-mini");

  assert.throws(
    () => resolveModelConfiguration("openai", { OPENAI_MODEL: "  " }),
    /OPENAI_MODEL must be a non-empty model ID when set/,
  );
  assert.throws(
    () => resolveModelConfiguration("custom-provider"),
    /No default model is configured for LLM provider 'custom-provider'/,
  );

  console.log("Model default configuration tests passed.");
})();
