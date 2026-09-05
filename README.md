# elastic-agent — Memory Module

This document describes the **memory module** introduced into the elastic-agent
runtime: its transport-agnostic interface, the default persistent (disk-backed)
implementation, the in-memory and graph backends, concatenation mode, how
modules are swapped and chained via dependency injection, and how it integrates
with the LLM runtime and the plan-execution loop.

> The module lives under `memory/` and backs the runtime's in-process,
> LLM-summarized memory. It is distinct from the legacy file/sqlite memory
> sinks that `MEMORY_INVENTORY.md`, `MEMORY_WORKFLOW.md`, and the `MEMORY_*.md`
> family describe. See [Relationship to legacy memory](#relationship-to-legacy-memory).

## Overview

A `MemoryModule` is the durable/episodic store that records what the agent did
while executing a plan and summarizes it so later turns — and the LLM's prompts
— can reuse relevant context instead of rediscovering it. It pairs with the LLM
adapters in `llm/` but is transport-agnostic: the same interface can back an
in-memory store, a file store, a SQLite store, or a remote service.

Two clear responsibilities:

1. **Remember** — `remember({ context, actions, outcome, reasoning, ... })`
   records one completed plan step.
2. **Recall** — `getContext({ session_id, ... })` returns a concise,
   LLM-ready summary the prompt builder can inject into the next prompt.

The interface is deliberately free of provider SDK objects, credentials,
storage backends, and transport-specific payloads, so a `MemoryModule` can be
**swapped** (dependency-injected) or **chained** (delegated) without changing
the execution flow of the agent.

## Files

| File | Purpose |
| --- | --- |
| `memory/types.ts` | The transport-agnostic contract: `MemoryModule`, `MemoryContext`, `RememberInput`, `ContextRequest`, `MemoryContextResult`, `MemoryModuleFactory`. |
| `memory/inMemory.ts` | `InMemoryMemoryModule` (the volatile in-process store), its `MemorySummarizer` type, the default renderer, `mergeContextResults`, and the `createInMemoryMemoryModule` factory. |
| `memory/graph-store.ts` | The logical graph schema (`GraphNode`, `GraphEdge`, `GraphAttributes`), the `GraphStore` storage interface, and the default in-memory adjacency store `InMemoryGraphStore`. |
| `memory/graph-memory.ts` | `GraphMemoryModule` (the graph-backed store), `GraphMemoryOptions`, `createGraphMemoryModule`, the default chain renderer, and the `GraphFailureReport`. |
| `memory/persistent.ts` | `PersistentMemoryModule` (the end-of-plan persistent store and **default backend**), `PersistentMemoryOptions`, `createPersistentMemoryModule`, `PersistentMemoryDocument`, and `PersistentFailureReport`. |
| `memory/compositeMemory.ts` | `CompositeMemoryModule` (concatenation composite), `createCompositeMemoryModule` / `createConcatenationMemoryModule` factories, `CompositeMemoryOptions`, and the `FinalizableMemoryModule`/`CompositeFailureReport` types. |
| `memory/memoryCompaction.ts` | The memory-compaction component: `MemoryCompactor`, `shouldCompactMemory` threshold test, `renderMemoryCompactionPrompt`, `validateCompactedSummary`, and the narrow `CompactionSummaryStore` interface. |
| `test/graph-memory.test.ts` | Focused tests for `GraphMemoryModule`: node creation/upsert, chain edges, `getContext`, chaining, empty-input fail-safe. |
| `test/persistent-memory.test.ts` | Focused tests for `PersistentMemoryModule`: contract, summarizer, persist, finalize, fail-safe, factory. |
| `test/composite-memory.test.ts` | Focused tests for `CompositeMemoryModule`: ordering, separators, remember to both, failure handling, finalize passthrough, chainable. |
| `test/multi-turn-memory.test.ts` | Tests for the LLM runtime memory-context injection. |

## The interface (`memory/types.ts`)

```ts
interface MemoryModule {
  remember(input: RememberInput): Promise<void>;
  getContext(request: ContextRequest): Promise<MemoryContextResult>;
}
```

Key shapes:

- **`MemoryContext`** — `session_id` (required), optional `user_id`,
  `plan`, `planState`, and free-form `context`. It identifies the conversation
  and places a step within the running plan. `plan`/`planState` are opaque
  (`unknown`) so the contract stays agnostic to any specific plan data model.
- **`RememberInput`** — wraps `context`, the `actions` the step performed
  (`MemoryAction[]`), the `outcome` (`"completed" | "failed" | "aborted" |
  "skipped" | "unknown"`), optional `outcomeDetail`, `reasoning`, `timestamp`,
  and `extra`.
- **`ContextRequest`** — `session_id`, optional `user_id`/`plan`, a
  `maxChars` budget hint, and free-form `hints`.
- **`MemoryContextResult`** — `text` (an LLM-ready summary), `matchedContexts`
  (structured provenance for chaining/audit), and `hasMemory`.

The contract is **transport-agnostic**: `MemoryJsonObject`/`MemoryJsonValue`
mirror the JSON subset used by the LLM adapter contract so memory payloads can
round-trip through any transport without lossy conversions.

## The in-memory implementation (`memory/inMemory.ts`)

`InMemoryMemoryModule` is the volatile in-process `MemoryModule`. It keeps an
ordered history of remembered plan steps in process memory (per session) and,
when a summarizer is injected, calls it after every `remember()` to refresh a
concise summary of everything seen so far. That summary is what `getContext()`
returns. It was the original runtime default; today the default is the persistent
backend and the in-memory module is an explicit opt-in (`ELAGENT_MEMORY_TYPE=in-memory`)
or the ephemeral secondary in concatenation mode.

- **Summarizer injection** — the summarizer is a plain
  `MemorySummarizer = (input: MemorySummarizeInput) => Promise<string>`
  function. Any caller can supply an LLM-backed summarizer, a heuristic
  summarizer, or a test stub — no SDK coupling.
- **Default renderer** — when no summarizer is injected,
  `defaultHistorySummarizer` renders a readable, deterministic history so
  `getContext()` still returns useful context.
- **Chaining** — an optional `delegate` `MemoryModule` receives forwarded
  `remember()`/`getContext()` calls so several stores can be composed (e.g. an
  in-memory cache in front of a durable backend). `getContext()` merges own and
  delegated results via `mergeContextResults` (de-duplicating provenance).
- **Swappable** — `createInMemoryMemoryModule(options)` is a
  `MemoryModuleFactory` so the store can be constructed/swapped via dependency
  injection without coupling callers to the concrete class.
- **Fail-safe** — `remember()`/`getContext()` never reject because of a
  summarizer or delegate failure; the first failure is recorded on
  `lastFailure` (a `MemoryFailureReport`) and surfaced to the caller, which the
  plan loop treats as non-fatal. `remember()` never throws to abort the loop.
- **Per-session isolation** — history and summary are keyed by `session_id`;
  sessions do not leak into each other.

### Example: construct, remember, recall

```ts
import { InMemoryMemoryModule } from "./memory/inMemory.js";
import type { RememberInput } from "./memory/types.js";

// No summarizer injected → the default renderer is used.
const memory = new InMemoryMemoryModule();

await memory.remember({
  context: { session_id: "run-abc", user_id: "task-1", plan: "Plan: do work." },
  actions: [{ name: "plan-step-1", description: "read CLAUDE.md" }],
  outcome: "completed",
  reasoning: "Read the project instructions before acting.",
  timestamp: new Date().toISOString(),
});

const ctx = await memory.getContext({ session_id: "run-abc" });
console.log(ctx.text);       // the summarized history (LLM-ready)
console.log(ctx.hasMemory);  // true
```

### Example: chain and swap via the factory

```ts
import { createInMemoryMemoryModule } from "./memory/inMemory.js";
import type { MemoryModule } from "./memory/types.js";

// A durable backend that also implements MemoryModule.
const durableBackend: MemoryModule = /* ... */;

// A chain: in-memory cache in front of the durable backend.
const memory = createInMemoryMemoryModule({ delegate: durableBackend });

// Swap wherever the runtime constructs memory — the plan loop and LLM
// integration only see the MemoryModule interface, so the backend can be
// replaced without touching the execution flow.
```

## The graph-backed implementation (`memory/graph-memory.ts`)

`GraphMemoryModule` is an alternative `MemoryModule` that uses the same
transport-agnostic contract but models each remembered plan step as **graph
nodes and typed edges**, following the logical data model in
`GRAPH_DATA_MODEL.md` (the design is captured in `GRAPH_MEMORY_MODULE_DESIGN.md`).
Instead of a flat per-session history, it stores:

- a `plan` **entity** node, created the first time a session remembers a step
  (upsert by session + plan reference);
- a step `claim` node per plan step, keyed by `sessionId + stepIndex` — the
  **step key**. Re-remembering the same session/step updates that node rather
  than duplicating it (idempotent `upsert`);
- typed, directed **edges**: each step `depends_on` the plan, and consecutive
  steps in a session are linked with `depends_on` / `derived_from` so
  `getContext()` can walk the recent chain of related steps.

Actions, reasoning, and outcome detail are stored as bounded, sanitized
labels/attributes on the step claim — never raw transcripts or secrets. The
graph lives in process memory behind a narrow `GraphStore` interface
(`memory/graph-store.ts`) so a persistent backend (file, SQLite, remote) can be
swapped in later without changing `GraphMemoryModule`.

- **Schema** — `GraphNode` (`entity`/`claim`, controlled `type`, status,
  timestamps, bounded attributes) and `GraphEdge` (`depends_on`,
  `derived_from`, `about`, `predicate`, `supports`, `supersedes`,
  `related_to`, `scoped_to`). `GraphAttributeValue` allows scalars or bounded
  arrays (e.g. a list of action names) without a lossy stringification.
- **Summarizer injection** — reuses the same `MemorySummarizer` function type
  as the in-memory module; when none is injected it falls back to a
  deterministic `defaultChainRenderer` over the recent chain.
- **Chaining / swapping** — `createGraphMemoryModule(options)` is a
  `MemoryModuleFactory`, accepts an optional `delegate` (forwarded and merged
  via `mergeContextResults`), an optional injected `store`, and honors the same
  fail-safe semantics (`lastFailure` is a `GraphFailureReport`; failures never
  reject).
- **Options** — `GraphMemoryOptions`: `store`, `summarizer`, `delegate`,
  `recentSteps` (default 5) and `maxChars` (default 2000).
- **Interface** — identical `remember()/getContext()` contract, so every call
  site (plan loop `rememberAgentStep`, LLM `getContext()` injection) works
  unchanged.

### How it differs from the in-memory module

| Aspect | InMemoryMemoryModule | GraphMemoryModule |
| --- | --- | --- |
| Storage | ordered list per session | adjacency graph (nodes + typed edges) |
| `remember()` | append + re-summarize list | upsert nodes/edges (idempotent per step key) + link chain |
| Recall | flat per-session summary | recent chain walk + predecessor relationships |
| Re-remember same step | duplicates an entry | updates the same node (`upsert`) |
| Backend extension | none | `GraphStore` interface for a persistent backend |

### Selecting the graph module

The runtime selects the backend at startup (in `main.ts`) via the
`ELAGENT_MEMORY_TYPE` environment variable. Set it to `graph` to use
`createGraphMemoryModule`. `ELAGENT_MEMORY_DISABLE=1/true` disables memory
entirely for every backend. See [Selecting the backend](#selecting-the-backend)
below for the full set of accepted values and the default.

```sh
# graph-backed
ELAGENT_MEMORY_TYPE=graph     npm run build

# disabled (fail-open)
ELAGENT_MEMORY_DISABLE=1      npm run build
```

## Selecting the backend

`main.ts` chooses the memory backend at startup from `ELAGENT_MEMORY_TYPE`. The
**default is the persistent (disk-backed) backend** — when the variable is unset
or unrecognised, or set to `persistent`, `main.ts` builds the durable
`PersistentMemoryModule`. The accepted values are:

| `ELAGENT_MEMORY_TYPE` | Backend | Factory |
| --- | --- | --- |
| (unset / unrecognised) / `persistent` | **persistent** (durable, disk-backed; the default) | `createPersistentMemoryModule` |
| `in-memory` | in-memory (volatile in-process; the original default, explicit opt-in) | `createInMemoryMemoryModule` |
| `graph` | graph-backed (nodes + typed edges) | `createGraphMemoryModule` |
| `concat` / `both` | **concatenation composite** (persistent `primary` + in-memory `secondary`) | `createCompositeMemoryModule` |

`ELAGENT_MEMORY_DISABLE=1/true` opts out entirely (fail-open) for every backend.

```sh
# default: persistent (disk-backed)
ELAGENT_MEMORY_TYPE=            npm run build

# explicit persistent
ELAGENT_MEMORY_TYPE=persistent  npm run build

# in-memory (original default, no end-of-plan persistence)
ELAGENT_MEMORY_TYPE=in-memory   npm run build

# graph-backed
ELAGENT_MEMORY_TYPE=graph       npm run build

# concatenation: persistent (primary) + in-memory (secondary)
ELAGENT_MEMORY_TYPE=concat      npm run build

# concatenation alias
ELAGENT_MEMORY_TYPE=both        npm run build

# disabled (fail-open)
ELAGENT_MEMORY_DISABLE=1        npm run build
```

For the persistent backend (and the persistent half of concatenation mode),
`ELAGENT_MEMORY_OUTPUT_DIR` (or `ELAGENT_MEMORY_OUTPUT_PATH`) selects where the
durable per-session documents land. For the default (unset) backend, omit the
variable or set it to `persistent`; setting `ELAGENT_MEMORY_TYPE` to anything
unrecognised other than the values above also falls back to the persistent
default.

## Concatenation mode (`memory/compositeMemory.ts`)

`ELAGENT_MEMORY_TYPE=concat` (alias `both`) composes two `MemoryModule`s into a
single labeled, fail-safe, chainable `MemoryModule` via a concatenation
composite (`createCompositeMemoryModule({ primary, secondary })`, alias
`createConcatenationMemoryModule`). The default pairing is **persistent** as
`primary` (the durable, disk-backed source) and **in-memory** as `secondary`
(the ephemeral source). The composite satisfies the same `MemoryModule`
contract (`remember`/`getContext`), so it can itself be wrapped, delegated, or
nested inside another composite.

- **remember(input)** — forwards to BOTH `primary` and `secondary` (and any
  `delegate`), so every plan step is recorded in both stores. Failures in either
  store are absorbed into the composite's `lastFailure` report and never
  reject/abort the plan loop (the other store still records the step).
- **getContext(request)** — retrieves context from BOTH stores and concatenates
  them **in order: `primary` first, then `secondary`**, each under its own header
  marker. Because the default pairing is persistent + in-memory, the runtime
  wires the headers so `main.ts` produces:

  ```text
  --- persistent memory ---
  <durable summary>
  --- in-memory memory ---
  <ephemeral context>
  ```

  A section is emitted only when that store returned a non-empty result (text or
  `hasMemory`); empty sections are dropped. `matchedContexts` are pooled across
  both stores. If one store throws, its section is omitted (logged as a failure)
  and the other store's context is still returned — the composite never fails
  open entirely for `getContext()`.

- **Ordering rationale** — persistent is surfaced first because it is the
  durable, curated end-of-plan source; in-memory sits after it so the recent
  ephemeral snapshot augments without masking the durable summary.
- **Finalize passthrough** — the composite is not a `PersistentMemoryModule`,
  but it exposes an optional `finalize(sessionId)` that forwards to the inner
  `primary` when that module exposes a `finalize` method. `main.ts`'s
  `finalizePersistentMemory()` detects both `instanceof PersistentMemoryModule`
  and this passthrough, so concat still persists the durable document at end of
  plan.
- **Chainable** — the composite is itself a `MemoryModule`, so it can be wrapped
  or delegated further or nested inside another composite, and it honors the same
  fail-safe semantics as every other backend.
- **Options** — `CompositeMemoryOptions`: `primary`, `secondary`, optional
  `headers` (custom separator markers) and optional `delegate`.

## The persistent end-of-plan implementation (`memory/persistent.ts`)

`PersistentMemoryModule` records plan steps in process memory (like the
in-memory module) **and** adds an explicit end-of-plan lifecycle: when the plan
completes, the runtime calls `finalize(sessionId)`, which gathers every step the
session remembered, summarises them through the same injected `MemorySummarizer`
contract (falling back to `defaultHistorySummarizer`), and writes a durable
per-session `PersistentMemoryDocument` to disk via an atomic write (temp file +
rename).

- **End-of-plan persist + summarise** — `finalize(sessionId)` produces a
  durable JSON document `{ version, session_id, user_id, plan, persistedAt,
  stepCount, summary, steps }`. The summary is built fresh over the full
  remembered history; `steps` is the lightweight per-step record (actions,
  outcome, outcomeDetail, reasoning, description, timestamp). The payload is
  non-secret episodic data only — never from a secret store or data sink.
- **Summarizer injection** — reuses the `MemorySummarizer` function type; a
  real LLM-backed summarizer or a stub both work, and a throwing summarizer is
  absorbed (the running summary is still persisted) and recorded on
  `lastFailure`.
- **Chaining / swapping** — `createPersistentMemoryModule(options)` is a
  `MemoryModuleFactory`; an optional `delegate` is forwarded and merged via
  `mergeContextResults`, and `outputDir` (or `filePath`) selects where the
  documents land. Fail-safe like the other modules: `remember()`/`getContext()`
  never reject, and a durable-write failure in `finalize()` is a thrown error
  the plan loop treats as non-fatal.
- **Options** — `PersistentMemoryOptions`: `outputDir` (default `memory-output`),
  `filePath` (overrides `outputDir`), `summarizer`, `delegate`.
- **Runtime selection** — the persistent backend is the **default**
  (`ELAGENT_MEMORY_TYPE` unset/unrecognised or `persistent`). It is also the
  `primary` half of concatenation mode. `ELAGENT_MEMORY_OUTPUT_DIR` (or
  `ELAGENT_MEMORY_OUTPUT_PATH`) picks the output location. After the plan
  completes, `main.ts` calls `finalizePersistentMemory()` which invokes
  `finalize()` (directly for a `PersistentMemoryModule`, or via the composite's
  `finalize()` passthrough in concat mode) and logs the durable path. It is a
  no-op for the in-memory/graph backends and is fail-safe (a finalize failure
  never aborts or changes plan completion).

```sh
# end-of-plan persistent memory (explicit; also the default when unset)
ELAGENT_MEMORY_TYPE=persistent                npm run build
ELAGENT_MEMORY_TYPE=persistent ELAGENT_MEMORY_OUTPUT_DIR=/var/lib/elagent-memory  npm run build
```

## LLM integration

`MultiTurnLlmRuntime` (in `llm/multi-turn-runtime.ts`) accepts an optional
`MemoryModule` plus a session id. Before generating an initial (non-continuation)
completion it calls `memory.getContext({ session_id })`; when the store returns
summarized context, it prepends a labeled block to the user input:

```
[SESSION MEMORY — additional context remembered from earlier in this session]
<summarized context>

<original prompt>
```

Integration details:

- **Optional / backward compatible** — a runtime constructed with only
  `adapter`/`model`/`signal` behaves exactly as before; memory is attached via
  the constructor options or at runtime via `attachMemory(memory, sessionId)`.
- **Initial turn only** — memory context is injected only on the initial turn
  of a phase/step, never on tool continuations (which reuse their stored
  messages).
- **Fail-safe** — a rejected `getContext()` leaves the prompt unchanged and
  reports the failure as a non-fatal diagnostic; the agent loop continues.
- **Prompt logging (opt-in)** — pass `--log-prompts` (or set `PROMPT_LOG_PATH`
  to override the path) to append every finalized LLM prompt — including the
  injected session-memory context above — to `prompt.log` in the working
  directory. This single hook covers every memory mode (in-memory, graph,
  persistent, composite). Because the captured payload may contain sensitive
  session-memory content, keep `prompt.log` (gitignored alongside `llm.log`)
  out of the repository and handle it with care.
- **Explicit session id (opt-in)** — pass `--session-id <id>` to pin the run's
  session id to an explicit value instead of a generated `run-<uuid>`. The id
  scopes every `remember()` and `getContext()` call and the end-of-plan
  persistence, so reusing the same `--session-id` across separate runs lets a
  later turn recall and continue the same session. It is used verbatim for the
  LLM context and sanitized only when used as a persisted filename. (See the
  `--session-id` help text and the Step 1 wiring below.)

## Plan-execution loop wiring

`main.ts` wires the module end-to-end:

1. On startup it derives the `agentSessionId` — from `--session-id <id>` when
   supplied, otherwise a fresh `run-${randomUUID()}` — and selects the backend
   via `ELAGENT_MEMORY_TYPE` — the **default (unset or
   unrecognised) and explicit `persistent`** build
   `createPersistentMemoryModule(options)` (the durable, disk-backed default);
   `in-memory` builds `createInMemoryMemoryModule(options)`; `graph` builds
   `createGraphMemoryModule(options)`; and `concat`/`both` build a
   `createCompositeMemoryModule({ primary: persistent, secondary: in-memory })`
   — swappable via dependency injection. See [Selecting the backend](#selecting-the-backend).
   For the persistent backend and the persistent half of concat, `main.ts` also
   calls `finalizePersistentMemory()` at end of plan to summarise and persist the
   session (via `instanceof PersistentMemoryModule` or the composite's
   `finalize()` passthrough). `ELAGENT_MEMORY_DISABLE=1/true` opts out entirely
   (fail-open): the plan loop and LLM prompts run exactly as before.
2. The runtime is constructed with `{ memory: agentMemory, sessionId:
   agentSessionId }`, so each initial LLM prompt is prefixed with recalled
   context.
3. After each plan step completes, `rememberAgentStep(...)` calls
   `agentMemory.remember({ context: { session_id, user_id, plan, planState },
   actions, outcome, outcomeDetail, reasoning, timestamp })`, once per step,
   never throwing. The input is built from plan/execution metadata already in
   the loop — never from `data.json` or secret payloads — so it is safe to
   persist even where a durable backend later stores it.
4. Independently of memory, the execution loop records each step's **result**
   (its `stepStatus`/`summary`/`findings` from the model's execution-feedback
   block, or a validation error when feedback did not parse) alongside the
   step number and text on `configData.completedSteps`. The final
   `reportImplementationTldr` console recap reads these and prints a
   `Step results/comments:` section. Like the memory input, the result is
   derived only from execution feedback — never from file contents,
   `data.json`, or secrets — so it is safe to surface in the tldr.

The integration is **optional and fail-safe**: if memory is disabled, the
summarizer/delegate throws, or `remember()`/`getContext()` fails, the LLM
prompts and the plan loop proceed unchanged with a single non-fatal warning.

## Tool-call scheduling option

`--max-tool-call-parallelism <n>` controls the maximum number of tool calls
from a single model response that the dependency-aware scheduler may run
concurrently. The scheduling rules are specified in `TOOL_CALL_SCHEDULING.md`.

- Default `4`.
- Minimum `1` — reproduces the historical fully-sequential dispatch exactly.
- Maximum `16` — values outside `1`–`16` fail fast with a usage error.
- Results are always returned to the model in the original tool-call order,
  never in completion order.

## Memory compaction (`memory/memoryCompaction.ts`)

As a run progresses, a session's per-session summary (the string
`getContext()` re-injects into every LLM prompt) can grow until it occupies a
significant fraction of the model's context window, degrading prompt quality
and eventually overflowing the window. Memory compaction detection keeps the
summary within bounds.

### Behavior

- **Trigger (threshold):** after every `remember()` (the post-memory-update
  hook in `rememberAgentStep`), the runtime checks whether
  `summary.length / contextWindow` is **strictly greater than** the threshold,
  **default `0.5` (50%)**. A summary exactly at 50% is **not** compacted; it
  must strictly exceed the threshold. An empty/absent summary or a non-positive
  window is never compacted.
- **Compaction flow:** when the threshold is exceeded, the highest-capability
  model for the active provider is called with the
  [`prompts/memory-compaction.md`](prompts/memory-compaction.md) prompt (rendered
  with `${plan}` and `${memory}`). The model returns a single plain-text
  compressed summary that preserves all important facts, decisions,
  constraints, and outstanding work while dropping redundancy. On success the
  session summary is **atomically replaced** in place of the current summary —
  the remembered step history is untouched, so nothing is lost.
- **Highest model:** compaction uses the provider's "highest" model resolved by
  `resolveHighestModelConfiguration` in `llm/model-defaults.ts` (per-provider
  defaults, overridable via `<PROVIDER>_MODEL_HIGHEST`, e.g.
  `OPENAI_MODEL_HIGHEST`, `DEEPSEEK_MODEL_HIGHEST`,
  `BEDROCK_CLAUDE_MODEL_HIGHEST`), falling back to the default model when the
  highest one cannot be resolved.
- **Prompt path:** `prompts/memory-compaction.md` — the stable
  `[MEMORY-COMPACTION]` template documented in `prompts/PROMPTS.md`.

### Safety / fail-open semantics

Compaction is **fail-open by design** — it can never corrupt or lose session
memory. Any of the following preserves the original summary unchanged and logs
an actionable diagnostic (never aborting the plan loop):

- the memory backend does not expose the narrow summary read/write interface
  (`CompactionSummaryStore` — today only the in-memory and persistent backends
  do; graph and composite backends skip compaction);
- the prompt file is missing or the prompt fails to render;
- the model call fails or is unavailable;
- the returned output is invalid — empty, a JSON document, or a fenced code
  block (all rejected by `validateCompactedSummary`);
- the "compaction" does not actually shrink the summary (its length is not
  strictly less than the original — guarding against an echo);
- the store read/write throws.

The compactor is built lazily once on first use and `maybeCompact` never throws.

### Configuration

The compactor's two size knobs are constructor options (`MemoryCompactorOptions`):

| Option | Effect | Default |
| --- | --- | --- |
| `contextWindow` | Context-window size in **characters** used for the threshold check | `120_000` (`DEFAULT_CONTEXT_WINDOW`) |
| `threshold` | Fraction of the window above which compaction fires (strictly-greater) | `0.5` (`MEMORY_COMPACTION_THRESHOLD`) |
| `highestModel` | Highest model id used for compaction (see `resolveHighestModelConfiguration`) | resolved per provider |

`main.ts` currently constructs the compactor with the defaults (120,000-char
window, 50% threshold); `contextWindow`/`threshold` are exposed on the
`MemoryCompactor` constructor so deployments that wire their own compaction can
tune them. The highest model is configured via the provider's `<PROVIDER>_MODEL_HIGHEST`
environment override (e.g. `OPENAI_MODEL_HIGHEST`), falling back to the
per-provider highest default in `llm/model-defaults.ts`.

> The context window is a conservative character proxy: the memory modules
> measure summary size as the summary string's `.length`, so the default window
> is given in characters (`DEFAULT_CONTEXT_WINDOW`). A deployment that knows its
> true window should pass a matching `contextWindow`.

### Example artifact

`docs/examples/elastic-agent-memory-aaaa-1112-0001.json` is an **artificial,
non-secret** example memory document (in the `PersistentMemoryDocument` schema)
for the session id `aaaa-1112-0001`, drawn with a summary long enough to exceed
the 50% threshold so the compaction hook would fire. It is clearly marked as a
synthetic fixture and is **not** real runtime data — the real runtime output
lives under the gitignored `memory-output/` directory. The same session id is
exercised in `test/memory-compaction.test.ts`.

## Tests

```sh
npm run test:memory             # interface, in-memory, chaining, LLM, remember-after-step
npm run test:graph-memory       # graph module: node upsert, chain edges, getContext, chaining, fail-safe
npm run test:persistent-memory  # persistent module: contract, summarizer, persist, finalize, fail-safe, factory
npm run test:composite-memory   # concatenation composite: ordering, separators, failure handling, finalize passthrough
npm run test:multi-turn-memory  # LLM runtime memory-context injection
npm run test:memory-compaction  # compaction detection + invocation: 50% threshold boundary, highest-model call, fail-open
npm run test:memory-compaction-prompt  # prompts/memory-compaction.md: placeholders + compress-without-losing-detail contract
npm run test:model-defaults     # highest-model resolution used by compaction (resolveHighestModelConfiguration)
npm run test:prompt-logger      # prompt.log writer (--log-prompts)
npm run build                   # includes memory/types.ts, memory/inMemory.ts, graph-store.ts, graph-memory.ts, persistent.ts, compositeMemory.ts, memoryCompaction.ts
```

## Relationship to legacy memory

The `MEMORY_*.md` family (`MEMORY_INVENTORY.md`, `MEMORY_WORKFLOW.md`,
`MEMORY_ADOPTION_AND_MIGRATION.md`, `MEMORY_FILE_LAYOUT.md`,
`MEMORY_RETRIEVAL_AND_CONSOLIDATION.md`, `MEMORY_ROLLOUT_SCOPE.md`,
`MEMORY_WRITE_POLICY.md`) documents the pre-existing, file/sqlite-based memory
workstream driven from `data.json` — a write-only persistence sink with no
startup load, validation, retrieval, or consolidation. The memory module
described here is a **new, separate** in-process store: it has a defined
transport-agnostic interface, multiple selectable backends (persistent by
default, plus in-memory, graph, and concatenation composite) with LLM
summarization, is swappable/chainable, and integrates directly with the plan
loop and LLM prompts.
