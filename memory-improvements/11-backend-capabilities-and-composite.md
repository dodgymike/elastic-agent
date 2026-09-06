# MI-11 — Unify backend capabilities and eliminate duplicate composite context

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-09](09-context-budget-and-cache.md), [MI-10](10-safe-compaction.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

The runtime currently selects in-memory, persistent, graph, or concatenated memory by environment value. Graph/composite stores lack the compactor's narrow interface, and concat writes identical inputs into two independent histories whose summaries are then repeated. Make supported capabilities explicit instead of relying on concrete class checks.

## Starting points in the repository

- [memory/types.ts](../memory/types.ts) — MemoryModule and factory contracts.
- [memory/index.ts](../memory/index.ts) — public exports.
- [memory/compositeMemory.ts](../memory/compositeMemory.ts) — remember, getContext, finalize.
- [memory/graph-memory.ts](../memory/graph-memory.ts) — graph projection and retrieval.
- [main.ts](../main.ts) — backend selection and finalizePersistentMemory.
- [test/memory-selection.test.ts](../test/memory-selection.test.ts) — selection behavior.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Introduce one composition factory with validated backend selection and injected dependencies. Add `persistent-v2` as the opt-in runtime choice; preserve old choices until task 16 changes defaults.

2. Expose capabilities for durable events, initialization, structured retrieval, compaction, deletion, and close. Unsupported operations must be explicit; avoid silently skipping a required durability or privacy guarantee.

3. Make composite mode use one authoritative event owner with optional cache/projection layers. A cache hit can accelerate retrieval, but must not duplicate durable writes or append the same evidence twice.

4. Adapt in-memory mode to the same identity, trust, retrieval, and budget contracts. Keep its volatile nature explicit. Adapt graph mode as a projection or document a supported limited mode; do not imply graph nodes are persisted when they are not.

5. Replace concrete instanceof/finalize checks in runtime integration with lifecycle interfaces. Ensure compaction and deletion route to the correct authoritative owner exactly once.

6. Add contract tests run against each supported backend configuration. Reject unrecognized configuration values with an actionable error rather than silently choosing persistent memory.

## Acceptance criteria

- [x] All advertised configurations enforce scope and complete-request budgets; capability gaps are reported before work requires them.
- [x] Composite retrieval returns each logical fact once and performs one authoritative durable append per event.
- [x] Flush/close/forget/compact reach the owner once even through wrappers. Failures preserve their typed category.
- [x] Existing backend selections have documented compatibility behavior; persistent-v2 is opt-in at the end of this task.

## Validation

Extend `test:memory-selection`, `test:composite-memory`, `test:graph-memory`, and `test:memory`. Add a shared conformance suite with fake projections and write-count assertions. Run the new context/compaction suites for every advertised mode.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not delete the old graph/in-memory implementations to make tests pass. Deprecation requires a migration note. Backend wrappers cannot advertise durable success based solely on an in-memory secondary accepting an event.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); MI-01..MI-10 commits present.
Prerequisite evidence: MI-09 DONE (c7c4d0f); MI-10 DONE (2db6a34).
Reproduction / old behavior: inline if/else selection silently fell back to persistent for any unrecognized ELAGENT_MEMORY_TYPE; composite wrote identical input into two independent histories and concatenated duplicate context; finalize/compaction were detected by concrete-ish casts rather than capability/lifecycle interfaces.
Changed files and behavior:
  - memory/backend-capabilities.ts (new): canonical capability constants, capabilitiesOf/hasExplicitCapabilities, and capability-gap diagnostics.
  - memory/backend-factory.ts (new): validated selection (SUPPORTED_MEMORY_TYPES), MemoryBackendSelectionError for unknown values, and MemoryBackendHandle with lifecycle/compaction/finalize routing.
  - memory/persistent-v2.ts (new): opt-in persistent-v2 bridge from the v1 MemoryModule contract to MemoryEventStore (durable appends, structured retrieval, flush/close lifecycle).
  - memory/compositeMemory.ts: one authoritative owner plus optional non-durable projections; remember() writes the owner exactly once; retrieval drops exact duplicate text blocks; finalize/flush/close/compaction route to the owner exactly once.
  - memory/inMemory.ts, memory/persistent.ts, memory/graph-memory.ts: advertise inline v2 capability surfaces (volatile / end-of-plan durable / projection).
  - memory/index.ts: export the new capability, factory, and persistent-v2 surfaces.
  - main.ts: selection now goes through createMemoryBackend and rejects unknown values with an actionable error; compactor and end-of-plan finalize route through the backend handle (no concrete class checks).
  - test/memory-backend-capabilities.test.ts (new): shared conformance suite with fake projections and write-count assertions.
  - test/memory-selection.test.ts, test/composite-memory.test.ts, test/graph-memory.test.ts, test/memory.test.ts: extended for capabilities, persistent-v2 opt-in, deduplicated retrieval, and routed lifecycle.
  - package.json: updated memory test-script file lists and added test:memory-backend-capabilities.
Validation commands and actual results:
  - npm run test:memory-backend-capabilities -> exit 0
  - npm run test:memory-selection -> exit 0
  - npm run test:composite-memory -> exit 0
  - npm run test:memory -> exit 0
  - npm run test:graph-memory -> exit 0
  - npm run test:memory-context-budget -> exit 0
  - npm run test:memory-safe-compaction -> exit 0
  - npm run build -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node memory/index.ts -> exit 0
  - git diff --check -> clean
Schema / configuration / compatibility changes: no storage schema change. ELAGENT_MEMORY_TYPE now rejects unrecognized values instead of silently choosing persistent memory; persistent-v2 is opt-in and honors ELAGENT_MEMORY_EVENT_STORE_PATH. Existing selections are preserved and the default remains persistent until MI-16.
Residual limitations and follow-up IDs: forgetting/export/retention are MI-13; health/efficiency metrics are MI-14. In-memory and graph remain documented limited modes (session-keyed; volatile/projection). The build script does not yet list the new modules explicitly (MI-16 integration).
Rollback notes: restore the pre-MI-11 compositeMemory.ts and main.ts selection, or remove the additive backend-capabilities/backend-factory/persistent-v2 files and their index exports.
Implementation commit(s): 1b615eb (implementation + tests + completion record)
```
