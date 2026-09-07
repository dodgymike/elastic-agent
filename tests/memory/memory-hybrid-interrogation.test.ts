import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentV2MemoryModule } from "../../src/memory/persistent-v2.js";
import { createMemoryEventStore } from "../../src/memory/event-store.js";
import { deriveWorkspaceId, canonicalizeWorkspacePath, resolvePrincipalId } from "../../src/memory/contracts-v2.js";
import { prepareMemoryPrompt } from "../../src/llm/memory-prompt.js";
import { MultiTurnLlmRuntime } from "../../src/llm/multi-turn-runtime.js";
import { createSemanticQueryExpander } from "../../src/memory/semantic-query.js";
import type { LlmAdapter, GenerateRequest } from "../../src/llm/adapter-contract.js";
async function main() {
 const directory = mkdtempSync(join(tmpdir(), "memory-hybrid-"));
 const store = createMemoryEventStore({ filePath: join(directory, "events.sqlite") });
 const workspaceId = deriveWorkspaceId(canonicalizeWorkspacePath(directory));
 const scope = { workspaceId, principalId: resolvePrincipalId(workspaceId), sessionId: "test" };
 process.env.LLM_LOG_PATH = join(directory, "llm.log");
 try {
  for (const [id, text, sessionId] of [["auth", "authentication credential token renewal", "test"], ["db", "database storage sqlite", "test"], ["other", "authentication other tenant", "other"]]) {
   const result = await store.append({ ...scope, sessionId }, { eventId: id, identity: { ...scope, sessionId, runId: "run" }, runRef: "run", kind: "fact", payload: { text } });
   assert.equal(result.status, "durable");
  }
  let fail = false;
  const memory = new PersistentV2MemoryModule({ store, workspacePath: directory, semanticExpander: async () => { if (fail) throw new Error("provider down"); return ["authentication", "credential"]; } });
  const result = await memory.getContext({ session_id: "test", queryText: "login" });
  assert.equal(result.retrieval?.status, "ok");
  assert.match(result.text, /credential/);
  assert.doesNotMatch(result.text, /sqlite|other tenant/);
  if (result.retrieval?.status === "ok") assert.match(result.retrieval.items[0].reasons.join(" "), /semantic expansion/);
  fail = true;
  const fallback = await memory.getContext({ session_id: "test", queryText: "database" });
  assert.match(fallback.text, /sqlite/);
  if (fallback.retrieval?.status === "ok") assert.equal(fallback.retrieval.semanticStatus, "fallback");
  fail = false;
  const budgeted = await memory.getContext({ session_id: "test", queryText: "login", maxChars: 2 });
  assert.equal(budgeted.text, "");
  const captured: GenerateRequest[] = [];
  const adapter: LlmAdapter = { provider: "fake", capabilities: { toolCalling: true, systemMessages: true, developerMessages: true }, generate: async request => {
   captured.push(request); return { model: "fake", finishReason: "stop", message: { role: "assistant", content: [{ type: "text", text: '["authentication","credential"]' }] } };
  } };
  const expanded = await createSemanticQueryExpander(async () => adapter, "fake")("login");
  assert.deepEqual(expanded, ["authentication", "credential"]);
  assert.doesNotMatch(JSON.stringify(captured[0]), /sqlite|token renewal/);
  const preview = await prepareMemoryPrompt("CLAUDE instructions\n\nlogin", "test", memory);
  const runtime = new MultiTurnLlmRuntime(adapter, "fake", undefined, { memory, sessionId: "test" });
  await runtime.create({ input: "CLAUDE instructions\n\nlogin" });
  const message = captured.at(-1)!.messages[0];
  assert.ok(message.role === "user");
  assert.equal(message.content[0].text, preview.prompt);
  assert.ok(preview.prompt.startsWith("CLAUDE instructions"));
  console.log("Hybrid retrieval, scope isolation, fallback, whole-record budgets, semantic expansion, and live/preview prompt parity passed.");
 } finally { await store.close(scope); rmSync(directory, {recursive:true,force:true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
