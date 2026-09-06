# MI-08 — Retrieve relevant evidence and deduplicate memory

Status: **TODO** · Priority: **P1** · Size: **M**

Dependencies: [MI-06](06-structured-facts-and-provenance.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

Persistent retrieval currently reads a session summary from maps. Graph retrieval favors a recent chain, while composite retrieval concatenates summaries and uses object identity for provenance deduplication. The runtime supplies only session_id to getContext, so it cannot ask for the files or work relevant to this turn.

## Starting points in the repository

- [memory/persistent.ts](../memory/persistent.ts) — ownContext.
- [memory/graph-memory.ts](../memory/graph-memory.ts) — ownContext and recentChain retrieval.
- [memory/compositeMemory.ts](../memory/compositeMemory.ts) — getContext and matchedContexts deduplication.
- [memory/inMemory.ts](../memory/inMemory.ts) — mergeContextResults.
- [llm/multi-turn-runtime.ts](../llm/multi-turn-runtime.ts) — appendMemoryContext.
- [memory/types.ts](../memory/types.ts) — ContextRequest.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Extend retrieval with exact scope, current task/plan, query text, referenced files/symbols, purpose, and budget. Apply ownership and deletion filters before ranking or reading payloads.

2. Implement a deterministic lexical baseline over structured records, using exact file/task matches, query terms, recency, and evidence quality. Bound candidate count and document tie-breaking. If using SQLite FTS, feature-detect it and define a tested fallback instead of assuming availability.

3. Always select applicable explicit constraints and open-work references first; rank ordinary facts and narrative separately. Return record IDs, sources, freshness, and score explanations with selected items.

4. Deduplicate by stable record/event IDs and normalized fact identity, not JavaScript object identity. Filter superseded/retracted records from current context unless the user asks for history.

5. Permit cross-session recall only within explicitly authorized workspace/principal scope. Session-local work remains the default; equal task names must not merge unrelated histories.

6. Return structured selections rather than one already-truncated string. Leave final formatting and complete-request budget enforcement to task 09. Keep the API useful without an embedding service.

## Acceptance criteria

- [ ] A task about file A retrieves its relevant decisions and current constraints without unrelated file B history crowding them out.
- [ ] Identical events exposed through two backend projections appear once, with stable provenance.
- [ ] Superseded facts, deleted items, and records from unauthorized scopes never appear as current knowledge.
- [ ] Ordering is deterministic for ties; candidate and output limits are enforced before expensive processing.

## Validation

Add `test/memory-retrieval.test.ts` with labeled expected results and distractors. Include same-session/same-task names across scopes, contradictory facts, duplicate projections, and an empty-query case. Measure candidate counts and returned bytes using synthetic large histories.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not add a vector database or external embedding API in the first implementation. Preserve the lexical baseline as an evaluator even if a later task introduces semantic retrieval. Retrieval failure should return a typed degraded result, not an invented empty-success explanation.

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
