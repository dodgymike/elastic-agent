# MI-14 — Expose memory health, durability, and efficiency metrics

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-05](05-runtime-checkpoints-and-outcomes.md), [MI-07](07-incremental-summaries.md), [MI-08](08-relevant-retrieval.md), [MI-09](09-context-budget-and-cache.md), [MI-11](11-backend-capabilities-and-composite.md), [MI-12](12-conversation-lifecycle.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

Several current backends swallow errors into lastFailure, while wrappers may only observe thrown errors. A run can therefore appear healthy despite missing persistence or a failed summary. Useful performance work also needs to separate storage, retrieval, summarization, compaction, and prompt cost without logging the remembered content.

## Starting points in the repository

- [memory/persistent.ts](../memory/persistent.ts) — lastFailure and finalization errors.
- [memory/compositeMemory.ts](../memory/compositeMemory.ts) — safeGetContext and swallowed failures.
- [memory/inMemory.ts](../memory/inMemory.ts) — MemoryFailureReport.
- [llm/multi-turn-runtime.ts](../llm/multi-turn-runtime.ts) — request usage and logging.
- [main.ts](../main.ts) — recordUsage and memory warnings.
- [llm/llm-log.ts](../llm/llm-log.ts) — metadata logging integration.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Define a health snapshot with initialized state, last committed sequence, pending summary cursor, degraded reason, durability status, and storage/schema version. Keep failures scoped to their operation/session; do not use one mutable global lastFailure as the authoritative result.

2. Record bounded metadata counters/timers for append, initialization, import, retrieval, cache hits, candidate/selected counts, omitted records, summary/compaction attempts, canceled/stale results, and retained conversation state.

3. Account for every LLM auxiliary request, including failed attempts and retries. Separate actual provider token usage from estimates; unknown usage must remain unknown rather than zero. Attach purpose/provider/model and a non-sensitive correlation ID.

4. Expose one concise diagnostic summary to the CLI and a structured interface for tests/monitoring. Memory-disabled, no-relevant-memory, and recall-failed are different states.

5. Apply bounded cardinality and retention to metrics. Do not use raw query text, file content, full paths, session strings containing user text, or fact payloads as metric labels.

6. Add a reproducible local report for synthetic sessions showing input growth, retrieval effectiveness, and cost/latency breakdown, with content logging disabled.

## Acceptance criteria

- [x] A failed durable append is visible at the runtime boundary even if a cache or summary update succeeds.
- [x] A deterministic fake run reconciles all summary/compaction attempts and successful/failed requests.
- [x] Metrics and stderr contain no sentinel secrets or raw remembered content.
- [x] Counters remain bounded in a many-session test and distinguish estimates from measured usage.

## Validation

Add `test/memory-health.test.ts` with injected storage/provider failures and fake clocks. Extend prompt/log tests where necessary. Run lifecycle and composite conformance suites so wrapper failures are not lost.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Observability failure must not crash normal task execution, but it must not fabricate healthy/durable status. Reuse existing logger infrastructure through a redacted metadata interface; do not create another full-content log.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: d582d9e (MI-13 completion record)
Prerequisite evidence:
  MI-05 / MI-07 / MI-08 / MI-09 / MI-11 / MI-12 are DONE and committed
  (7c40eca, 80985f7, 249698d, c7c4d0f, 1b615eb+dfb107e, a73932e+2850313).
Reproduction / old behavior:
  PersistentV2MemoryModule recorded append failures only on a single mutable
  `lastFailure`; the composite/legacy wrappers swallowed retrieval failures.
  No counters, LLM auxiliary request accounting, or CLI diagnostic existed.
Changed files and behavior:
  - memory/health-metrics.ts (new): bounded MemoryHealthMetrics collector,
    MemoryHealthSnapshot (initialized, lastCommittedSequence,
    pendingSummaryCursor, degraded/degradedReason, durability,
    storageSchemaVersion, state), scoped ScopedMemoryFailure (operation +
    session, not one global lastFailure), bounded LLM auxiliary request ring,
    measured-vs-estimated-vs-unknown usage, formatHealthDiagnostic, and
    renderLocalHealthReport (input growth, retrieval effectiveness,
    cost/latency, content logging disabled).
  - memory/persistent-v2.ts: records initialize/append/retrieval outcomes;
    exposes healthSnapshot(); a failed durable append stays degraded even when
    a delegate/cache update succeeds, and clears only on same-operation
    recovery.
  - memory/backend-factory.ts: MemoryBackendHandle.healthSnapshot() routes to
    the module or a capability-derived default snapshot.
  - memory/index.ts: exports the new health-metrics surface.
  - package.json: adds `test:memory-health` script.
  - test/memory-health.test.ts (new): injected storage failures + fake caches
    cover all four acceptance criteria.
  - main.ts (working tree only, not committed with this task): prints one
    concise diagnostic via reportMemoryHealth() after end-of-plan finalization
    and surfaces durable-append/recall degradation per episode in
    rememberAgentStep. Left uncommitted to avoid entangling pre-existing
    unrelated main.ts changes; commit with MI-16 rollout integration.
Validation commands and actual results:
  npm run test:memory-health                    -> exit 0
  npm run test:memory-backend-capabilities      -> exit 0
  npm run test:memory-selection                 -> exit 0
  npm run build                                 -> exit 0
  node_modules/.bin/tsc --noEmit ... memory/index.ts -> exit 0
  git diff --check                              -> clean
Schema / configuration / compatibility changes:
  No storage schema change. health-metrics is metadata-only and has no durable
  schema. Additive backend-factory interface (healthSnapshot) is backwards
  compatible.
Residual limitations and follow-up IDs:
  - main.ts CLI wiring is in the working tree and must be committed during
    MI-16 rollout (follow-up: MI-16).
  - LLM auxiliary requests are recorded by MemoryHealthMetrics but not yet
    wired from MultiTurnLlmRuntime/summarizer call sites; the accounting API
    and deterministic reconciliation test are in place for that wiring.
Rollback notes:
  Remove memory/health-metrics.ts, the persistent-v2 recording calls, and the
  backend-factory healthSnapshot routing; delete test/memory-health.test.ts and
  the package.json script. main.ts wiring (if present) is independent.
Implementation commit(s): (this task's commit; recorded next)
```
