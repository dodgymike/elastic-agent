# MI-11 — Unify backend capabilities and eliminate duplicate composite context

Status: **TODO** · Priority: **P1** · Size: **M**

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

- [ ] All advertised configurations enforce scope and complete-request budgets; capability gaps are reported before work requires them.
- [ ] Composite retrieval returns each logical fact once and performs one authoritative durable append per event.
- [ ] Flush/close/forget/compact reach the owner once even through wrappers. Failures preserve their typed category.
- [ ] Existing backend selections have documented compatibility behavior; persistent-v2 is opt-in at the end of this task.

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
Status: TODO | IN_PROGRESS | BLOCKED | DONE
Baseline revision:
Prerequisite evidence:
Reproduction / old behavior:
Changed files and behavior:
Validation commands and actual results:
Schema / configuration / compatibility changes:
Residual limitations and follow-up IDs:
Rollback notes:
Implementation commit(s):
```
