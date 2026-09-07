import type { MemoryModule, MemoryContextResult } from "../memory/types.js";
import { redactMemoryText } from "../memory/privacy.js";

export function memoryContextSuffix(result: MemoryContextResult): string {
  if (!result.hasMemory || !result.text.trim()) return "";
  return `\n\n[SESSION MEMORY — additional context remembered from earlier in this session]\n${result.text.trim()}`;
}
/** Shared by live initial generations and memory interrogation; recall exactly once. */
export async function prepareMemoryPrompt(input: string, sessionId: string, memory?: MemoryModule, queryText = input) {
  const result = memory ? await memory.getContext({ session_id: sessionId, queryText }) : { text: "", matchedContexts: [], hasMemory: false };
  return { prompt: input + redactMemoryText(memoryContextSuffix(result)), memory: result };
}
