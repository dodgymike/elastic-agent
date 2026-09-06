# MI-10 — Compact derived summaries without losing constraints or progress

Status: **TODO** · Priority: **P1** · Size: **M**

Dependencies: [MI-09](09-context-budget-and-cache.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

Current compaction checks whether a summary exceeds a fixed character fraction, asks the highest model to shrink it, and accepts nonempty non-JSON text that is shorter. This validates syntax and size, not preservation of constraints. The replacement has no revision check and the provider call is not supplied a cancellation signal.

## Starting points in the repository

- [memory/memoryCompaction.ts](../memory/memoryCompaction.ts) — shouldCompactMemory, maybeCompact, validateCompactedSummary.
- [prompts/memory-compaction.md](../prompts/memory-compaction.md) — compaction instructions.
- [main.ts](../main.ts) — ensureMemoryCompactor and post-remember hook.
- [memory/persistent.ts](../memory/persistent.ts) — setSummary and finalize.
- [test/memory-compaction.test.ts](../test/memory-compaction.test.ts) — existing boundary and fail-safe tests.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Trigger compaction from the complete-request budget pressure or derived-summary limits established in task 09. Retain an explicit maintenance trigger; remove assumptions that a 120,000-character memory window describes every model.

2. Compact only derived narrative. Carry exact constraints, active decision IDs, unresolved work IDs, and evidence references through the structured projection, outside the model's lossy text rewrite.

3. Use a versioned structured response contract for compacted sections and retained references. Validate scope, source cursor, reference existence, length, and protected-item coverage. Shorter prose alone is not proof of equivalence.

4. Thread cancellation, deadline, role/provider selection, and generation budgets into the model call. Do not always select the most expensive model when a validated configured role suffices; record which configuration produced the summary.

5. Commit with a revision/cursor/generation check. Reject stale results after new events, deletion, or another compaction. Do not mutate the underlying event history.

6. On failure, retain the old summary and use bounded retrieval/omission to keep the next request safe. Fail-open memory must not mean sending an oversized request. Prevent immediate repeated compaction attempts on unchanged input after a failure.

7. Ensure the next incremental summary and finalize path do not re-expand the whole event history and undo the compaction.

## Acceptance criteria

- [ ] Fixtures preserve every applicable user constraint and open task even when narrative compression is aggressive.
- [ ] Missing/fabricated references, empty/oversized output, cancellation, and stale revisions leave the prior checkpoint intact.
- [ ] A compaction failure produces a bounded next request or a context-budget error, not unbounded fallback text.
- [ ] Repeated unchanged inputs do not trigger an endless compaction/retry loop.

## Validation

Extend `test:memory-compaction` and `test:memory-compaction-prompt`; add contract-preservation and out-of-order completion cases. Use a fake model that drops an important constraint, invents a source ID, echoes input, and returns after deletion.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Lossy summaries are replaceable projections. Never delete events merely because compaction succeeded. Semantic quality beyond protected facts requires task 15 evaluations; retain uncertainty rather than claiming lossless compression of arbitrary narrative.

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
