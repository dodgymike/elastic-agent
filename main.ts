import { createRuntimeLlmAdapter } from "./llm/application.js";

const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) throw new Error("Usage: npm start -- <prompt>");

  const adapter = await createRuntimeLlmAdapter();
  const response = await adapter.generate({
    // This default is a DeepSeek Chat Completions model. Deployments may select
    // another enabled DeepSeek model without changing provider composition.
    model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  console.log(response.message.content.map((part) => part.text).join(""));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
