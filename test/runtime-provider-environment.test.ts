import assert from "node:assert/strict";
import { createRuntimeLlmAdapter, createRuntimeLlmRegistry } from "../llm/application.js";

const environmentVariables = [
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentVariables.map((name) => [name, process.env[name]]),
) as Record<(typeof environmentVariables)[number], string | undefined>;

function clearProviderEnvironment(): void {
  for (const name of environmentVariables) delete process.env[name];
}

(async () => {
  try {
    assert.deepEqual(createRuntimeLlmRegistry().providers(), ["bedrock-claude", "deepseek-v4", "openai"]);

    clearProviderEnvironment();
    process.env.OPENAI_API_KEY = "test-openai-key";
    assert.equal((await createRuntimeLlmAdapter({
      envFile: false,
      environment: { LLM_PROVIDER: "openai" },
    })).provider, "openai");

    clearProviderEnvironment();
    process.env.AWS_REGION = "us-east-1";
    assert.equal((await createRuntimeLlmAdapter({
      envFile: false,
      environment: { LLM_PROVIDER: "bedrock-claude" },
    })).provider, "bedrock-claude");

    clearProviderEnvironment();
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    assert.equal((await createRuntimeLlmAdapter({
      envFile: false,
      environment: { LLM_PROVIDER: "deepseek-v4" },
    })).provider, "deepseek-v4");

    process.env.OPENAI_API_KEY = "test-openai-key";
    assert.equal((await createRuntimeLlmAdapter({
      envFile: false,
      environment: { LLM_PROVIDER: "deepseek-v4" },
      configuration: { provider: "openai" },
    })).provider, "openai");

    console.log("Runtime provider environment tests passed.");
  } finally {
    for (const name of environmentVariables) {
      const value = originalEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
