# MI-07 — Make summaries incremental, revisioned, and cancelable

Status: **TODO** · Priority: **P1** · Size: **M**

Dependencies: [MI-06](06-structured-facts-and-provenance.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

The persistent backend currently calls its summarizer with all entries and the previous summary after each remember, then summarizes the full history again during finalize. The default CLI does not inject an LLM summarizer. Compaction can therefore be followed by another full-history rendering that expands memory again.

## Starting points in the repository

- [memory/inMemory.ts](../memory/inMemory.ts) — MemorySummarizeInput and defaultHistorySummarizer.
- [memory/persistent.ts](../memory/persistent.ts) — remember and finalize.
- [main.ts](../main.ts) — memory backend factory options.
- [llm/adapter-contract.ts](../llm/adapter-contract.ts) — generation cancellation and output controls.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Define a summary checkpoint containing scope, coveredThroughSequence, revision, text/structured sections, summarizer version, policy version, and input digest. A summary is a derived artifact, not a replacement for events.

2. Pass only events after the checkpoint cursor plus the previous bounded summary and relevant protected facts. Batch by bounded event/byte counts or step boundaries; avoid a model call on every small observation.

3. Keep the deterministic summarizer as an explicitly named offline option. Add LLM summarization only through an injected provider-compatible role configuration, with explicit deadline, cancellation, input/output budgets, and model metadata.

4. Commit a new summary and cursor atomically using a revision check. A stale concurrent summary must not overwrite a newer checkpoint or cross a forget/retention generation.

5. On timeout, invalid output, or provider failure, retain the previous summary and cursor. Unsummarized events stay retrievable and may be retried without advancing past them.

6. Change finalization to flush pending durable work rather than reconstructing an unbounded full-history summary. Schedule full rebuild/consolidation only as an explicit bounded maintenance operation.

## Acceptance criteria

- [ ] For a 100-step fixture, each ordinary update receives only the new batch and bounded prior summary; total event processing is not quadratic.
- [ ] An interrupted or stale summarizer neither skips events nor overwrites a later summary.
- [ ] Changing summarizer version marks derived summaries stale/rebuildable without losing events.
- [ ] No summarizer call is made when the selected deterministic mode or unchanged cursor makes it unnecessary.

## Validation

Add `test/memory-incremental-summary.test.ts` with a fake summarizer that records input sizes, returns invalid data, delays, and completes out of order. Run the existing memory-compaction and persistent-memory suites. Live model quality evaluation is optional and belongs to task 15.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not silently introduce a second provider or send memories to a new service. Changing the summarizer should not change ownership, authorization, or event identity. Reverting this feature rebuilds derived summaries from the event store.

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
