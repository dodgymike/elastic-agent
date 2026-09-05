import assert from "node:assert/strict";
import {
  resolvePlannerModelOverride,
  resolvePlannerModelProvider,
} from "../llm/cli-provider-selection.js";
import {
  resolveModelConfiguration,
  supportedModelsForProvider,
  supportedProviders,
} from "../llm/model-defaults.js";

/**
 * Planner-model override and provider auto-selection tests.
 *
 * These tests pin the CLI boundary that main.ts wires into the shared
 * MultiTurnLlmRuntime (`client`). main.ts constructs exactly one runtime from
 * the resolved planner provider/model pair:
 *
 *   client = new MultiTurnLlmRuntime(
 *     await createRuntimeLlmAdapter({ configuration: plannerProviderConfiguration }),
 *     plannerRuntimeModel,
 *     ...
 *   );
 *
 * and then shares that same `client` with the auxiliary LLM paths:
 *
 *   - tool-safety classifier  (safetyOptions.runtime = client)
 *   - git-command router      (routeGitExecuteCommand(command, { runtime: client, ... }))
 *   - planning-necessity      (determinePlanningNecessity(originalPrompt, client, ...))
 *
 * Consequently, when `--planner-model` auto-selects a different provider, those
 * auxiliary calls run through the resolved provider's adapter, not the default
 * provider's adapter. (The classifier additionally keeps its own separately
 * resolved `model` from `--classifier-model`; its transport/runtime comes from
 * the shared `client`.) The resolver tests below cover the selection boundary
 * that produces `plannerProviderConfiguration` / `plannerRuntimeModel`; the
 * shared-runtime coupling itself lives in main.ts and is exercised end-to-end
 * by test/planner-model-cli.test.js.
 */

(() => {
  // ------------------------------------------------------------------
  // 1. No flag preserves the selected provider's default planner model.
  //    resolvePlannerModelOverride returns undefined for the omitted flag and
  //    resolvePlannerModelProvider returns undefined so main.ts falls back to
  //    modelConfiguration.model (the provider default).
  // ------------------------------------------------------------------
  assert.equal(resolvePlannerModelOverride(undefined), undefined);
  assert.equal(resolvePlannerModelProvider(undefined, "openai"), undefined);
  assert.equal(resolvePlannerModelProvider(undefined, "deepseek-v4"), undefined);
  assert.deepEqual(resolveModelConfiguration("openai"), {
    provider: "openai",
    model: "gpt-4.1-mini",
    environmentVariable: "OPENAI_MODEL",
  });
  assert.deepEqual(resolveModelConfiguration("deepseek-v4"), {
    provider: "deepseek-v4",
    model: "deepseek-v4-pro",
    environmentVariable: "DEEPSEEK_MODEL",
  });
  assert.deepEqual(resolveModelConfiguration("bedrock-claude"), {
    provider: "bedrock-claude",
    model: "anthropic.claude-sonnet-4-20250514-v1:0",
    environmentVariable: "BEDROCK_CLAUDE_MODEL",
  });

  // ------------------------------------------------------------------
  // 2. --planner-model that is already in the selected provider's catalog
  //    stays with that provider.
  // ------------------------------------------------------------------
  assert.equal(resolvePlannerModelOverride("  gpt-4.1  "), "gpt-4.1");
  assert.deepEqual(resolvePlannerModelProvider("gpt-4.1", "openai"), {
    provider: "openai",
    model: "gpt-4.1",
  });
  assert.deepEqual(resolvePlannerModelProvider("deepseek-v4-pro", "deepseek-v4"), {
    provider: "deepseek-v4",
    model: "deepseek-v4-pro",
  });
  assert.deepEqual(resolvePlannerModelProvider("claude-sonnet-5", "bedrock-claude"), {
    provider: "bedrock-claude",
    model: "claude-sonnet-5",
  });

  // ------------------------------------------------------------------
  // 3. DeepSeek v4 Pro / Flash model IDs auto-select the DeepSeek provider
  //    even when a different provider is currently selected.
  // ------------------------------------------------------------------
  assert.deepEqual(resolvePlannerModelProvider("deepseek-v4-pro", "openai"), {
    provider: "deepseek-v4",
    model: "deepseek-v4-pro",
  });
  assert.deepEqual(resolvePlannerModelProvider("deepseek-v4-flash", "bedrock-claude"), {
    provider: "deepseek-v4",
    model: "deepseek-v4-flash",
  });
  assert.deepEqual(resolvePlannerModelProvider("deepseek-v4-flash", "OPENAI"), {
    provider: "deepseek-v4",
    model: "deepseek-v4-flash",
  });

  // ------------------------------------------------------------------
  // 4. Claude Opus / Sonnet 5 model IDs auto-select the AWS/Bedrock provider.
  // ------------------------------------------------------------------
  assert.deepEqual(resolvePlannerModelProvider("claude-sonnet-5", "openai"), {
    provider: "bedrock-claude",
    model: "claude-sonnet-5",
  });
  assert.deepEqual(resolvePlannerModelProvider("claude-opus-5", "deepseek-v4"), {
    provider: "bedrock-claude",
    model: "claude-opus-5",
  });
  // The requested model is trimmed before matching.
  assert.deepEqual(resolvePlannerModelProvider("  claude-opus-5  ", "deepseek-v4"), {
    provider: "bedrock-claude",
    model: "claude-opus-5",
  });

  // ------------------------------------------------------------------
  // 5. Unknown model fails with an actionable error listing every supported
  //    planner model instead of silently falling back.
  // ------------------------------------------------------------------
  let unknownMessage = "";
  try {
    resolvePlannerModelProvider("gpt-99", "openai");
    assert.fail("expected an unknown planner model to throw");
  } catch (error) {
    unknownMessage = error instanceof Error ? error.message : String(error);
  }
  assert.match(unknownMessage, /No provider supports planner model 'gpt-99'/);
  assert.match(unknownMessage, /Supported planner models:/);
  for (const expected of [
    "gpt-4.1-mini",
    "gpt-4.1",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "claude-sonnet-5",
    "claude-opus-5",
    "anthropic.claude-sonnet-4-20250514-v1:0",
    "anthropic.claude-opus-4-20250514-v1:0",
  ]) {
    assert.ok(unknownMessage.includes(expected), `expected '${expected}' in: ${unknownMessage}`);
  }
  assert.throws(
    () => resolvePlannerModelProvider("gpt-99", "openai"),
    /No provider supports planner model 'gpt-99'/,
  );

  // ------------------------------------------------------------------
  // 6. Deterministic precedence for duplicate/ambiguous model IDs.
  //    supportedProviders() is sorted by provider ID, the currently selected
  //    provider is consulted first, and repeated resolutions return the same
  //    result. If two catalogs ever advertise one model ID, the current
  //    provider wins; otherwise the lexicographically smallest provider ID in
  //    the sorted catalog wins — identically on every run.
  // ------------------------------------------------------------------
  assert.deepEqual(supportedProviders(), ["bedrock-claude", "deepseek-v4", "openai"]);

  // Current-provider-first precedence.
  assert.deepEqual(resolvePlannerModelProvider("deepseek-v4-pro", "deepseek-v4"), {
    provider: "deepseek-v4",
    model: "deepseek-v4-pro",
  });

  // Repeated resolution is stable.
  const first = resolvePlannerModelProvider("claude-sonnet-5", "openai");
  const second = resolvePlannerModelProvider("claude-sonnet-5", "openai");
  assert.deepEqual(first, second);
  assert.deepEqual(first, { provider: "bedrock-claude", model: "claude-sonnet-5" });

  // Catalog content for the requested models.
  assert.deepEqual(supportedModelsForProvider("deepseek-v4"), [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
  ]);
  assert.ok(supportedModelsForProvider("bedrock-claude").includes("claude-sonnet-5"));
  assert.ok(supportedModelsForProvider("bedrock-claude").includes("claude-opus-5"));

  // ------------------------------------------------------------------
  // 7. CLI validation boundary: blank/whitespace values are rejected with a
  //    clear message, and a supplied value is trimmed.
  // ------------------------------------------------------------------
  assert.throws(
    () => resolvePlannerModelOverride(""),
    /--planner-model requires a non-empty model ID/,
  );
  assert.throws(
    () => resolvePlannerModelOverride("   "),
    /--planner-model requires a non-empty model ID/,
  );
  assert.throws(
    () => resolvePlannerModelProvider("   ", "openai"),
    /--planner-model requires a non-empty model ID/,
  );
  assert.equal(resolvePlannerModelOverride("  deepseek-v4-pro  "), "deepseek-v4-pro");

  console.log("Planner model selection tests passed.");
})();
