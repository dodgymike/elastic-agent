# GraphMemoryModule Design

**Scope:** execution-plan step 2, *Design the GraphMemoryModule implementation and
integration points*. This is a design document only. It reflects the logical
graph model in `GRAPH_DATA_MODEL.md` and the existing transport-agnostic memory
contract in `memory/types.ts`. Implementation, tests, wiring, and
documentation are later plan steps.

## 1. Purpose and boundary

The existing `InMemoryMemoryModule` (`memory/inMemory.ts`) records an ordered
list of plan steps and refreshes a flat per-session summary. The
`GraphMemoryModule` keeps the same `MemoryModule` interface but models each
remembered step as **graph nodes and typed edges** so later turns can retrieve
a *chain of related steps* (not just a flat history). It follows the logical
data model from `GRAPH_DATA_MODEL.md`:

- `entity` nodes — durable referents (project, repository, component, agent,
  task, plan, ...).
- `claim` nodes — atomic assertions with `confidence`, status, provenance.
- typed, directed `edge`s — `about`, `predicate`, `depends_on`,
  `derived_from`, `supports`, `supersedes`, `related_to`, `scoped_to`, ...
- `provenance` records — bounded, non-secret evidence pointers.

For this first GraphMemoryModule realization we store the graph **in process
memory** behind a small storage interface so a persistent backend (file,
SQLite, remote) can be swapped in later without changing the module. All IDs,
timestamps, statuses, and the enumerated node/edge types follow the logical
model so the in-memory shape can be serialized to the physical layout
(`MEMORY_FILE_LAYOUT.md`) in a later step.

## 2. Graph schema used by the module

### Nodes

A `GraphNode`:

| Field | Meaning |
| --- | --- |
| `id` | opaque immutable identifier (generated) |
| `kind` | `entity` \| `claim` |
| `type` | a controlled type (see below) |
| `label` | short display label |
| `sessionId` | the run/session this node belongs to |
| `status` | `active` \| `superseded` \| `retracted` \| `archived` |
| `createdAt` / `updatedAt` | RFC 3339 timestamps |
| `attributes` | small typed scalar map (namespaced keys) |

Node `type`s drawn from the model:

- Entity: `agent`, `plan`, `task`, `project`, `repository`, `component`,
  `concept`.
- Claim: `fact`, `decision`, `assessment`, `obligation`, `preference`,
  `constraint` (a step's outcome/reasoning is modeled as a `fact`/`assessment`
  claim).

### Edges

A `GraphEdge`:

| Field | Meaning |
| --- | --- |
| `id` | opaque immutable identifier |
| `type` | `depends_on` \| `derived_from` \| `about` \| `predicate` \| `supports` \| `supersedes` \| `related_to` \| `scoped_to` |
| `fromId` / `toId` | both endpoints must exist in the same graph |
| `status` | lifecycle status |
| `value?` | optional typed scalar for a `predicate` edge |
| `attributes` | optional bounded scalar map |

### Per-session chain structure (the core shape)

For one session, remembered plan steps are linked as:

```text
E-plan: entity { type: plan, label: <plan> }
  ^ depends_on
  | (each step depends_on the plan)
S1: claim { type: fact/assessment, label: <step 1 reasoning/outcome> }
S2: claim { type: fact/assessment, ... }
  ^ depends_on            ^ derived_from
S1 ---------------------> S2        (consecutive steps link via depends_on/derived_from)
```

- A `plan` entity node is created the first time a session remembers a step
  (`upsert` by session + plan label).
- Each plan step is a `claim` node keyed by `sessionId + stepIndex` — the
  **step key**. Re-remembering the same session/step updates that node rather
  than creating a duplicate (`upsert`).
- Consecutive steps are linked with `depends_on` / `derived_from` edges so
  `getContext()` can walk the recent chain (last N steps) and the transitive
  predecessors of a given step.
- Actions, reasoning, and outcome detail are stored as bounded, sanitized
  attributes/labels on the step claim; they are **not** raw transcripts or
  secrets.

## 3. remember() behavior

`remember(input: RememberInput): Promise<void>` performs a deterministic,
idempotent mutation:

1. **Extract step key** = `{ sessionId: input.context.session_id,
   stepIndex: input.context.context?.step ?? (ordered position) }`. The step
   index is read from the free-form `context` JSON (the runtime already sets
   `context: { step: index + 1 }`), falling back to an internal incrementing
   counter per session when absent.
2. **Upsert the plan entity** node (by `sessionId` + plan text). First time
   creates it; later calls are no-ops / patch timestamps.
3. **Upsert the step claim** node keyed by the step key. Re-remembering the
   same session/step updates `updatedAt`, `status`, and attributes.
4. **Link edges**:
   - `depends_on` from the step node to the plan node.
   - `derived_from` / `depends_on` from this step node to the previous step
     node in the same session (when one exists), forming the chain.
5. **Invoke the LLM summarizer** (see §4) to refresh a concise per-session
   summary from the graph *chain* (last N step claims in order), never from
   raw transcripts.
6. **Forward to `delegate`** when chaining (fail-safe, mirroring
   `InMemoryMemoryModule`).
7. **Fail safe**: any storage, summarizer, or delegate error is recorded on a
   per-module failure report and does **not** reject, so the agent plan loop
   continues. Optional validation of controlled types/limits is fail-open at
   this stage: unknown data is stored, not dropped.

## 4. Storage backing and the storage interface

The graph is held in memory for this first implementation, behind a narrow
interface so a persistent backend can replace it later:

```ts
/** Minimal in-memory graph store used by GraphMemoryModule in step 3. */
interface GraphStore {
  upsertNode(node: GraphNode): void;
  upsertEdge(edge: GraphEdge): void;
  getNode(id: string): GraphNode | undefined;
  /** Chain of step nodes for a session in OLDEST-first order. */
  stepsForSession(sessionId: string): GraphNode[];
  /** The N most recent step nodes for a session, NEWEST-first. */
  recentChain(sessionId: string, n: number): GraphNode[];
  /** The plan node for a session (or undefined). */
  planForSession(sessionId: string): GraphNode | undefined;
}

/** Persistent backend can implement GraphStore and be injected. */
type GraphStoreFactory = (options: GraphMemoryOptions) => GraphStore;
```

The concrete `InMemoryGraphStore` (adjacency maps: `nodes: Map<id, GraphNode>`,
`edgesByFrom: Map<id, GraphEdge[]>`, `sessionSteps: Map<sessionId, string[]>`)
is the default. A later step can add `FileGraphStore` / `SqliteGraphStore`
without touching `GraphMemoryModule` — only the injected store changes.

## 5. Constructor (factory) options and chaining

```ts
interface GraphMemoryOptions extends MemoryModuleFactoryOptions {
  /** In-memory adjacency store; defaults to InMemoryGraphStore. */
  readonly store?: GraphStore;
  /** Optional LLM-backed summarizer (function type, same as InMemory). */
  readonly summarizer?: MemorySummarizer;   // reused from memory/inMemory.ts
  /** Optional delegate MemoryModule for chaining. */
  readonly delegate?: MemoryModule;
  /** How many recent steps getContext() returns (default e.g. 5). */
  readonly recentSteps?: number;
  /** Max characters of rendered context (budget guard). */
  readonly maxChars?: number;
}

const createGraphMemoryModule: MemoryModuleFactory = (options) =>
  new GraphMemoryModule(options);
```

- **Swappable**: the same `MemoryModuleFactory` type (`memory/types.ts`) is
  used, so the runtime can construct either `InMemoryMemoryModule` or
  `GraphMemoryModule` behind one reference.
- **Chainable**: `delegate` forwards `remember`/`getContext`; graph context is
  merged with delegated context via the existing `mergeContextResults`
  (`memory/inMemory.ts`).
- **Summarizer**: reuses the `MemorySummarizer` function type
  (`(input) => Promise<string>`) from `memory/inMemory.ts`, so tests can inject
  a stub and a real LLM adapter can supply a real summarizer without new types.
  No module object — just a function — keeps it transport-agnostic.

## 6. getContext() / context method

`getContext(request: ContextRequest): Promise<MemoryContextResult>`:

1. Reads the `recentChain` (last `recentSteps` step nodes) for the session.
2. Renders them in order into an LLM-ready string; if a summarizer is
   injected, it produces the summary from the chain; otherwise a deterministic
   renderer lists each step label/outcome.
3. Returns `matchedContexts` as the step `MemoryContext`s (provenance) and
   `hasMemory` true when any step node exists.
4. Honors `maxChars`, and when a `delegate` is present, merges via
   `mergeContextResults`.

## 7. Integration points (wiring)

The runtime wires memory in `main.ts` exactly where `InMemoryMemoryModule` is
built and called today:

- **Instantiation/selection** — `main.ts` around the `agentMemory` block
  (currently `createInMemoryMemoryModule(memoryOptions)`). A selector
  (`process.env.ELAGENT_MEMORY_TYPE === "graph"` and/or a CLI `--memory=graph`
  flag) chooses `createGraphMemoryModule`; default remains in-memory.
- **remember() call sites** — `rememberAgentStep(...)` in `main.ts` already
  calls `agentMemory.remember(input)` after each completed plan step; it is
  module-agnostic and needs no change once `agentMemory` points at the graph
  module. Both call sites (lines ~1938 and ~2180) forward through
  `rememberAgentStep`.
- **LLM context injection** — `MultiTurnLlmRuntime` already accepts a
  `MemoryModule` + session id and calls `getContext()` for the initial prompt;
  unchanged.
- **Disable opt-out** — `ELAGENT_MEMORY_DISABLE=1/true` continues to set
  `agentMemory = null` for both backends.

## 8. What changes vs. in-memory module

| Aspect | InMemoryMemoryModule | GraphMemoryModule |
| --- | --- | --- |
| Storage | ordered list per session | adjacency graph (nodes + typed edges) |
| remember() | append + re-summarize list | upsert nodes/edges (idempotent per step key) + link chain |
| retrieve | flat per-session summary | recent chain walk + predecessor relationships |
| Re-remember same step | duplicates an entry | updates the same node (`upsert`) |
| Backend extension | none | `GraphStore` interface for persistent backend |

## 9. Files to create/change in later steps

- `memory/graph-store.ts` — `GraphNode`, `GraphEdge`, `GraphStore`, and
  `InMemoryGraphStore` (new).
- `memory/graph-memory.ts` — `GraphMemoryModule`, `GraphMemoryOptions`,
  `createGraphMemoryModule`, default chain renderer (new).
- `memory/graph-memory.test.ts` — focused tests (new).
- `main.ts` — memory-type selector (edit).
- `package.json` — `test:graph-memory` script and build list (edit).
- `README.md` / `MEMORY.md` — selection + usage docs (edit).
