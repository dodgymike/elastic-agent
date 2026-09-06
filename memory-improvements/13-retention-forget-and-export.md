# MI-13 — Implement retention, forgetting, and safe export

Status: **TODO** · Priority: **P1** · Size: **M**

Dependencies: [MI-04](04-reload-and-legacy-import.md), [MI-06](06-structured-facts-and-provenance.md), [MI-07](07-incremental-summaries.md), [MI-08](08-relevant-retrieval.md), [MI-11](11-backend-capabilities-and-composite.md), [MI-12](12-conversation-lifecycle.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

Persistent events and derived summaries need an explicit lifecycle. Forgetting only the visible summary leaves the same information in events, fact projections, retrieval indexes, cached context, imports, or in-flight summarizer results. Build one authoritative deletion protocol that prevents deleted content from reappearing.

## Starting points in the repository

- [memory/types.ts](../memory/types.ts) — new lifecycle/capability contracts.
- [memory/persistent.ts](../memory/persistent.ts) — legacy artifact format.
- [memory/compositeMemory.ts](../memory/compositeMemory.ts) — ownership and cache routing.
- [llm/multi-turn-runtime.ts](../llm/multi-turn-runtime.ts) — memory snapshots and retained conversations.
- [llm/llm-log.ts](../llm/llm-log.ts) — log retention integration.
- [llm/prompt-logger.ts](../llm/prompt-logger.ts) — explicit content-log lifecycle.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Define explicit forget scopes: record, session, and authorized workspace/principal. Require exact selection and return counts/status; never infer deletion scope from a vague natural-language match.

2. Commit a tombstone/deletion generation before invalidating derived data. Delete or redact authoritative payloads, facts, summaries, indexes, caches, and local exports according to policy. A pending summarizer/extractor must compare the generation and reject stale output.

3. Handle active conversation snapshots explicitly: cancel/restart affected conversations or defer deletion with a visible pending state. Never claim content was forgotten while continuing to send a cached copy to the provider.

4. Implement retention by age and storage limits with documented treatment of unresolved work and explicit user constraints. Prune whole records with provenance-aware consequences; do not retain confidential content indefinitely merely because an index points to it.

5. Create redacted, versioned exports with scope/provenance and safe permissions. Imports must respect tombstones and require an explicit restore operation rather than silently resurrecting forgotten records.

6. Document the limits of local deletion: database pages/journals, backups, previous explicit logs, and already-sent provider requests have separate lifecycles. Provide tested local cleanup/compaction procedures without promising forensic secure erasure or remote deletion.

7. Expose a narrow local CLI/API for previewing and applying these operations, with actionable failure reports and authorization at the boundary.

## Acceptance criteria

- [ ] Forgotten facts disappear from retrieval, summaries, projections, and future prompts, including after restart.
- [ ] An in-flight summarizer completing after deletion cannot resurrect the content.
- [ ] Same-ID sessions in other scopes remain intact; interrupted deletion resumes or reports pending work accurately.
- [ ] Exports contain no sentinel secrets and round-trip valid non-deleted records with original provenance.

## Validation

Add `test/memory-retention.test.ts` using a fake clock, temporary database/log paths, queued fake summarizers, and active conversation handles. Assert all local retrieval paths after forget and restart. Never run deletion against real memory-output or user logs during tests.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Deletion is not ordinarily reversible; distinguish preview, apply, and explicit restore. Retention must not silently destroy the only record of uncertain external effects. Document which artifacts are outside the operation's scope and require separate lifecycle handling.

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
