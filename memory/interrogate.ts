import { resolvePlannerModelProvider } from "../llm/cli-provider-selection.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPrompt } from "../prompt-builder.js";
import { buildPlanningPrompt } from "../planner-prompt.js";
import { prepareMemoryPrompt } from "../llm/memory-prompt.js";
import { createMemoryBackend } from "./backend-factory.js";
import { createSemanticQueryExpander } from "./semantic-query.js";
import { createRuntimeLlmAdapter, loadRuntimeEnvironment, resolveRuntimeLlmModel } from "../llm/application.js";
import { canonicalizeWorkspacePath, deriveWorkspaceId, resolvePrincipalId } from "./contracts-v2.js";

/** Entered before normal CLI setup: no planning, tools, task claims, or state writes. */
export async function interrogateMemory(options: {
  prompt: string; sessionId?: string; provider?: string; plannerModel?: string;
  allowAgentSourceModifications?: boolean;
}) {
  if (!options.prompt.trim()) throw new Error("Memory interrogation requires a nonempty prompt.");
  if (!options.sessionId?.trim()) throw new Error("Memory interrogation requires --session-id for the memories to inspect.");
  loadRuntimeEnvironment();
  const initialConfiguration = options.provider ? { provider: options.provider } : undefined;
  const modelConfig = resolveRuntimeLlmModel({ configuration: initialConfiguration });
  const selection = resolvePlannerModelProvider(options.plannerModel, modelConfig.provider);
  const configuration = selection ? { provider: selection.provider } : initialConfiguration;
  const model = selection?.model ?? modelConfig.model;
  const workspacePath = process.cwd();
  const read = (path: string) => readFileSync(resolve(workspacePath, path), "utf8");
  const instructions = read("CLAUDE.md");
  const base = buildPrompt({ commandPrompts: [], toolCallTldrs: [], commandLinePromptValue: options.prompt,
    template: read("prompts/build-prompt-skeleton.txt"), claudeInstructions: instructions,
    historyLimit: 0, selfModificationSection: read("prompts/self-modification-section.txt"),
    allowAgentSourceModifications: options.allowAgentSourceModifications === true });
  const input = buildPlanningPrompt(base, read("prompts/planning-prefix.txt"), instructions);
  const disabled = ["1", "true"].includes(process.env.ELAGENT_MEMORY_DISABLE ?? "");
  const backend = disabled ? null : createMemoryBackend({
    type: process.env.ELAGENT_MEMORY_TYPE,
    outputDir: process.env.ELAGENT_MEMORY_OUTPUT_DIR,
    filePath: process.env.ELAGENT_MEMORY_OUTPUT_PATH,
    eventStorePath: process.env.ELAGENT_MEMORY_EVENT_STORE_PATH,
    workspacePath,
    semanticExpander: process.env.ELAGENT_MEMORY_SEMANTIC === "0" ? undefined : createSemanticQueryExpander(() => createRuntimeLlmAdapter({ configuration }), model),
  });
  const workspaceId = deriveWorkspaceId(canonicalizeWorkspacePath(workspacePath));
  const scope = { workspaceId, principalId: resolvePrincipalId(workspaceId), sessionId: options.sessionId };
  try {
    const prepared = await prepareMemoryPrompt(input, options.sessionId, backend?.module, options.prompt);
    const health = backend?.healthSnapshot();
    if (health?.state === "recall-failed") throw new Error("Memory recall failed; inspect store configuration and permissions.");
    return {
      mode: "memory-interrogation", phase: "initial-planning", backend: backend?.kind ?? "disabled", scope,
      model, provider: selection?.provider ?? modelConfig.provider,
      note: "Initial planning prompt for this supplied request and memory snapshot. No task execution or final planning generation is performed. Future research tool results are not yet available.",
      memories: prepared.memory, messages: [{ role: "user", content: [{ type: "text", text: prepared.prompt }] }],
      prompt: prepared.prompt,
    };
  } finally { await backend?.close(scope); }
}
