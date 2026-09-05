import assert from "node:assert/strict";
import { resolveRuntimeLlmModel } from "../llm/application.js";
import {
  resolveHighestModelConfiguration,
  resolveModelConfiguration,
} from "../llm/model-defaults.js";

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
    model: "deepseek-v4-pro",
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

  // Highest-model resolution (used by memory compaction). The "highest" model
  // is the strongest available for the selected provider (compaction prefers
  // higher capability than the per-step default model). Each provider exposes
  // a dedicated `*_MODEL_HIGHEST` override derived from its model variable.
  assert.deepEqual(resolveHighestModelConfiguration("openai"), {
    provider: "openai",
    model: "gpt-4.1",
    environmentVariable: "OPENAI_MODEL_HIGHEST",
  });
  assert.deepEqual(resolveHighestModelConfiguration("bedrock-claude"), {
    provider: "bedrock-claude",
    model: "anthropic.claude-opus-4-20250514-v1:0",
    environmentVariable: "BEDROCK_CLAUDE_MODEL_HIGHEST",
  });
  assert.deepEqual(resolveHighestModelConfiguration("deepseek-v4"), {
    provider: "deepseek-v4",
    model: "deepseek-v4-pro",
    environmentVariable: "DEEPSEEK_MODEL_HIGHEST",
  });

  // The dedicated highest override wins over the highest default.
  assert.equal(resolveHighestModelConfiguration("openai", {
    OPENAI_MODEL_HIGHEST: "gpt-5",
  }).model, "gpt-5");
  assert.equal(resolveHighestModelConfiguration("deepseek-v4", {
    DEEPSEEK_MODEL_HIGHEST: "deepseek-v4-ultra",
  }).model, "deepseek-v4-ultra");

  // Cross-provider isolation: only the selected provider's highest variable is
  // consulted; another provider's setting must not leak in.
  assert.equal(resolveHighestModelConfiguration("deepseek-v4", {
    OPENAI_MODEL_HIGHEST: "gpt-5",
    BEDROCK_CLAUDE_MODEL_HIGHEST: "anthropic.claude-opus",
  }).model, "deepseek-v4-pro");

  // A blank highest override is rejected rather than silently falling back.
  assert.throws(
    () => resolveHighestModelConfiguration("openai", { OPENAI_MODEL_HIGHEST: "   " }),
    /OPENAI_MODEL_HIGHEST must be a non-empty model ID when set/,
  );
  // Unknown providers have no highest model either.
  assert.throws(
    () => resolveHighestModelConfiguration("custom-provider"),
    /No default model is configured for LLM provider 'custom-provider'/,
  );

  console.log("Model default configuration tests passed.");
})();
