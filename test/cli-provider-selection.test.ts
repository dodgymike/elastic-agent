import assert from "node:assert/strict";
import { selectCliProvider } from "../llm/cli-provider-selection.js";

const fromFlag = selectCliProvider(
  ["--provider", " OpenAI ", "summarize", "this"],
  { LLM_PROVIDER: "deepseek-v4" },
);
assert.deepEqual(fromFlag.configuration, { provider: "openai" });
assert.deepEqual(fromFlag.remainingArgs, ["summarize", "this"]);

const fromEqualsFlag = selectCliProvider(["--provider=bedrock-claude", "prompt"]);
assert.deepEqual(fromEqualsFlag.configuration, { provider: "bedrock-claude" });
assert.deepEqual(fromEqualsFlag.remainingArgs, ["prompt"]);

const fromEnvironment = selectCliProvider(["prompt", "--other-option"], { LLM_PROVIDER: " DEEPSEEK-V4 " });
assert.deepEqual(fromEnvironment.configuration, { provider: "deepseek-v4" });
assert.deepEqual(fromEnvironment.remainingArgs, ["prompt", "--other-option"]);

assert.throws(
  () => selectCliProvider(["prompt"]),
  /set --provider <provider-id> or LLM_PROVIDER/,
);
assert.throws(
  () => selectCliProvider(["--provider"]),
  /--provider requires a provider ID/,
);
assert.throws(
  () => selectCliProvider(["--provider=openai", "--provider", "deepseek-v4"]),
  /--provider may be specified only once/,
);
assert.throws(
  () => selectCliProvider(["--provider", "NOT VALID"]),
  /LLM provider must use lowercase letters/,
);

console.log("CLI provider selection tests passed.");
