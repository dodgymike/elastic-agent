# Project Memory

## Tool error trends

- ERROR_TRENDS.md documents observed tool use error patterns and their resolution status.
- Key patterns: Spec Keeper API route contract drift (resolved), Agent Bus connectivity (blocked), full TypeScript build failures (blocked), deleted-main2 lifecycle test (blocked), and missing DeepSeek API key (blocked).
- The document tracks which tools currently work and which have known failures for handoff continuity.

## Tool-call terminal rendering

- Tool-call terminal rendering is centralized in `tool-renderer.ts` (unified
  `ToolName(args)` label plus green/red circle, stdout/stderr ordering, and
  per-tool renderers) and `tool-timer.ts` (in-place elapsed timer with ANSI
  line clearing).
- `dispatchToolCall` in `main.ts` emits the pending label before argument
  parsing, runs the safety classifier, starts the timer, and routes
  success/failure output through the shared render helper. No
  `[TOOL] Pending:`/`[SUCCESS]`/`[ERROR]` text prefixes are emitted for tool
  calls.
- The legacy `main2.js`-scoped rendering test is being migrated to the new
  dispatch structure rather than retained against the deleted executor.

## Provider runtime migration handoff

- The provider selection and compatibility-layer work remains **in progress**; do not claim runtime verification is complete.
- Partial verification is recorded only. The full build still fails and must be resolved before completion.
- The focused tool-rendering test also fails while `main2.js` is deleted; decide whether the legacy executor should be retained, the test should be migrated, or the test should be retired as part of an approved scope change.
- Uncommitted `main2.js` deletion and `main-llm-chooser.ts` must not be included in a record-only commit until they are independently verified.

## Bootstrap execution-plan lessons (context preservation)

These are the durable lessons from the bootstrap execution plan (tracked in Spec Keeper task `af085d8c`) and MUST be reused by future tasks. Full details, observed instances, and recovery evidence live in ERROR_TRENDS.md; this section is the condensed memory.

1. **Repeated DeepSeek JSON-parsing failures (steps 1-3).** LLM tool-call argument strings are not schema-guaranteed. Do not keep patching isolated one-off fallbacks; use a layered, best-effort repair chain (brace/bracket balance, leading-prose strip, trailing-garbage trim, progressive truncation, quote tolerance) plus a single clean retry with a pure-JSON hint. Verified: parse-failure probe 33/33 passing; `npm run test:llm-adapters` passes. Commits: `99ab88c`, `be722d9`, `8e1458f`, `e29612b`, `44e11ef`, `a72acb9`.
2. **Truncation with large code blocks (steps 2-3).** The truncation-to-stdout hypothesis for the Write invalid-JSON error is INCORRECT: tool-call arguments flow directly from the API response, never through stdout. Validate a causal hypothesis against the code before implementing a fix. Documented in investigation task `1d78a8a9`; work consolidated under `43b3c126`.
3. **Repeated attempts on the same task (step 3).** Before resuming a failed/blocked step, re-verify whether the recorded blocker is still live. A cleared blocker should unblock the task, not be re-reported (see `select-deepseek-adapter-configuration`, reconciled stale blocked state). Prefer changing approach over repeating the same failing method a third time.
4. **File Writing Strategy (step 4):** Never write large files in one call; chunk into smaller pieces. `tools/Write.ts` now writes in 64 KiB chunks (`WRITE_CHUNK_SIZE`) at byte offsets of the complete UTF-8 Buffer so multi-byte sequences stay contiguous, preserving atomicity and the overwrite/read_hash contract. Commit `bdc0464`. The Write tool refuses overwrite without a fresh `read_hash` + `overwrite:true`.
5. **Verification (step 5):** Always verify written files compile/parse before committing. Use `npm run test:llm-adapters`, `node --check`, `git diff --check`, and hash/round-trip checks for large writes.
6. **Error Recovery (step 6):** When a task fails, try a different approach rather than repeating the same method. Commit `25ded0e` documents this principle in ERROR_TRENDS.md with three concrete observed instances.
7. **Progress Tracking (step 7):** Use Spec Keeper notes/status to track iterations and avoid redundant attempts. Keep serial step notes (probe progress 11→13→20→24→33) and snapshot recovery status so downstream steps and future runs skip already-recovered work.
8. **Context Preservation (step 8, this section):** Consolidate lessons learned into durable memory (MEMORY.md + ERROR_TRENDS.md) so future tasks inherit them rather than rediscovering failures.

## Coordination

- Spec Keeper is the authoritative task/decision/handoff system for this project (`elastic-agent`).
- Agent Bus is not currently configured because `AGENT_BUS_BASE_URL` is absent; this does not block the legacy renderer task.
- Spec Keeper bookkeeping requires a URL-safe project slug; the project is `elastic-agent`. The Spec Keeper client reads credentials from the local secret store `.spec.local.json` (default `SPEC_KEEPER_CONFIG_PATH`); pass `projectSlug: "elastic-agent"` explicitly when the secret store lacks a project slug.

## Runtime memory module (in-process, LLM-summarized)

A new, transport-agnostic **memory module** ships under `memory/` and is wired
into the runtime plan loop and LLM prompts. It is separate from the legacy
file/sqlite memory workstream documented in `MEMORY_INVENTORY.md` /
`MEMORY_WORKFLOW.md` (a write-only sink from `data.json`). The module has a
defined interface, an in-memory implementation with LLM summarization, a
graph-backed implementation, and is swappable/chainable via dependency
injection.

- **Interface** (`memory/types.ts`): `MemoryModule` with `remember(RememberInput)`
  and `getContext(ContextRequest)`. Transport-agnostic (no SDK objects or
  credentials); `plan`/`planState` are opaque.
- **In-memory store** (`memory/inMemory.ts`): `InMemoryMemoryModule` keeps per-
  session history, calls an injected `MemorySummarizer` after every `remember()`
  to refresh a concise summary, and falls back to `defaultHistorySummarizer`
  when none is injected. `createInMemoryMemoryModule` is the swappable factory.
- **Graph-backed store** (`memory/graph-memory.ts` + `memory/graph-store.ts`):
  `GraphMemoryModule` is the alternative backend that models each plan step as
  graph nodes and typed edges (following `GRAPH_DATA_MODEL.md`; design in
  `GRAPH_MEMORY_MODULE_DESIGN.md`). A `plan` entity node plus per-step claim
  nodes keyed by session + step index (`upsert`, idempotent), linked with
  `depends_on`/`derived_from` chain edges so `getContext()` walks the recent
  chain. Reuses the same `MemorySummarizer` contract (falls back to
  `defaultChainRenderer`), supports an injected `GraphStore` for a future
  persistent backend, and honors the same chaining/fail-safe semantics.
  `createGraphMemoryModule` is the swappable factory. See `README.md` for how
  it differs from the in-memory module.
- **Selection**: `main.ts` picks the backend with `ELAGENT_MEMORY_TYPE`
  (default in-memory; `ELAGENT_MEMORY_TYPE=graph` selects the graph module).
  `ELAGENT_MEMORY_DISABLE=1/true` disables memory entirely for both backends.
- **Chaining**: an optional `delegate` forwards calls; `getContext()` merges own
  and delegated results via `mergeContextResults`. **Swapping**: the runtime
  constructs memory through the factory so the backend can be replaced without
  changing the execution flow.
- **LLM integration**: `MultiTurnLlmRuntime` optionally accepts a `MemoryModule`
  + session id, and prepends recalled context (via `getContext`) to the initial
  turn of each phase. `attachMemory()` can attach later; backward compatible.
- **Plan-loop wiring**: `main.ts` creates the store at startup and calls
  `rememberAgentStep` → `agentMemory.remember(...)` after every completed plan
  step. It is fail-safe and non-fatal: disabled or failing memory never aborts
  the loop or changes prompts.
- **Tests**: `npm run test:memory` (interface, in-memory, chaining, LLM
  integration, remember-after-step), `npm run test:graph-memory` (graph node
  creation/upsert, chain edges, `getContext`, chaining, empty-input fail-safe),
  and `npm run test:multi-turn-memory` (LLM runtime memory context).
  `memory/types.ts`, `memory/inMemory.ts`, `memory/graph-store.ts`, and
  `memory/graph-memory.ts` are part of `npm run build`.

See `README.md` for the full interface, usage, injection, chaining, and a short
example.
