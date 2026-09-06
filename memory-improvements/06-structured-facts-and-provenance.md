# MI-06 — Build a structured view of facts, decisions, and unfinished work

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-05](05-runtime-checkpoints-and-outcomes.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

A growing narrative does not reliably distinguish an old hypothesis from a current decision, or a completed effect from unfinished work. Build a structured, rebuildable projection over events so retrieval can choose current evidence and compaction cannot erase important constraints.

## Starting points in the repository

- [memory/types.ts](../memory/types.ts) — event provenance and outcomes.
- [memory/graph-memory.ts](../memory/graph-memory.ts) — existing step/plan relationships.
- [memory/graph-store.ts](../memory/graph-store.ts) — graph identifiers and update behavior.
- [main.ts](../main.ts) — execution feedback and verification evidence.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Define record kinds for fact, decision, user constraint, open task, failure/lesson, and artifact reference. Include stable ID, scope, source event IDs, evidence level, created/updated sequence, relevance tags, and supersedes/retracted relationships.

2. Implement deterministic extraction from structured runtime fields first. An optional model extractor may propose records, but must return schema-valid candidates with source references; it cannot promote itself to an authoritative source.

3. Keep exact user constraints and unresolved task IDs in a protected structured projection. Do not depend on a lossy prose summary to reconstruct them.

4. Handle contradictions explicitly. Preserve competing unsupported claims; supersede only with a supported transition or a newer authorized decision. Use source sequence and evidence strength rather than blindly preferring the latest sentence.

5. Make projection updates idempotent and transactional with a projection cursor. Record the schema/policy version so the projection can be rebuilt after extractor changes.

6. Expose bounded reads for current constraints, open work, and evidence-backed facts. Leave general topic ranking to task 08.

## Acceptance criteria

- [ ] Replaying the same event history produces the same logical structured records with no duplicates.
- [ ] A retracted decision is absent from the current-decision view but retains provenance for audit.
- [ ] An unsupported model claim cannot overwrite an explicit user constraint or verified observation.
- [ ] Every current fact/decision points to retained source evidence or is visibly marked as legacy/unverified.

## Validation

Add `test/memory-facts.test.ts` with fixtures for changed decisions, stale facts, failed attempts, repeated imports, and malicious external content. Test rebuild equivalence and projection cursor recovery. Run privacy and checkpoint tests.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Structured views are derived data and may be rebuilt; raw sanitized committed events remain the source of truth subject to retention/deletion rules. Avoid adopting a separate graph database or embeddings in this task.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); MI-01..MI-05 commits present.
Prerequisite evidence: MI-05 DONE (7c40eca/e79e9ea).
Reproduction / old behavior: narrative memory could not reliably distinguish old hypotheses from current decisions, completed effects from unfinished work, or supported facts from unsupported claims.
Changed files and behavior:
  - memory/structured-records.ts (new): deterministic projection with record kinds fact/decision/constraint/open-task/failure/artifact; protected constraint/open-task maps; explicit supersession/retraction; evidence levels; policy/cursor.
  - memory/index.ts: export the projection surface.
  - test/memory-facts.test.ts (new): replay equivalence, retracted decisions, constraint protection, malicious external content, evidence levels, open-work idempotence.
  - package.json: add test:memory-facts script.
Validation commands and actual results:
  - npm run test:memory-facts -> exit 0
  - npm run test:memory-privacy -> exit 0
  - npm run test:memory-runtime-checkpoint -> exit 0
  - npm run build -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node memory/index.ts -> exit 0
  - git diff --check -> clean
Schema / configuration / compatibility changes: derived projection policyVersion=1; no storage schema change (events remain source of truth).
Residual limitations and follow-up IDs: optional model extractor not added (deterministic extraction only); topic ranking deferred to MI-08.
Rollback notes: remove the additive projection module and exports; no stored-data migration required.
Implementation commit(s): b08954a (implementation + tests); completion record commit follows.
```
