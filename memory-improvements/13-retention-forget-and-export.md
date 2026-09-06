# MI-13 — Implement retention, forgetting, and safe export

Status: **DONE** · Priority: **P1** · Size: **M**

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

- [x] Forgotten facts disappear from retrieval, summaries, projections, and future prompts, including after restart.
- [x] An in-flight summarizer completing after deletion cannot resurrect the content.
- [x] Same-ID sessions in other scopes remain intact; interrupted deletion resumes or reports pending work accurately.
- [x] Exports contain no sentinel secrets and round-trip valid non-deleted records with original provenance.

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
Status: DONE
Baseline revision: 2850313 (MI-12 completion)
Prerequisite evidence: MI-04 DONE (reload/import), MI-06 DONE (structured records), MI-07 DONE (incremental summaries), MI-08 DONE (retrieval), MI-11 DONE (capabilities/composite), MI-12 DONE (conversation lifecycle).
Reproduction / old behavior: MemoryEventStore had no deletion path; legacy import would re-append previously imported records without any tombstone check; IncrementalSummaryManager had no way to reject an in-flight summarizer completion after a deletion; persistent-v2 advertised supportsForget/supportsExport=false.
Changed files and behavior: memory/contracts-v2.ts (forget/tombstone/restore/scope-summary types + validateForgetSelection), memory/event-store.ts (schema v2 additive migration: tombstones + deletion_state; forget/restore/retention query methods; capabilities flip), memory/retention.ts (new MemoryRetentionController: previewForget/forget/previewRetention/applyRetention/exportScope/restoreExport), memory/incremental-summary.ts (deletion-generation stale rejection), memory/legacy-import.ts (tombstone-respecting import), memory/backend-capabilities.ts + memory/persistent-v2.ts + memory/compositeMemory.ts + memory/index.ts (capabilities/routing/exports), test/memory-retention.test.ts (new), test/memory-backend-capabilities.test.ts (updated capability assertion), package.json (test:memory-retention script), docs/MEMORY_EVENT_STORE.md + docs/MEMORY_RETENTION.md (new).
Validation commands and actual results: npm run test:memory-retention (exit 0); test:memory-event-store, test:memory-reload, test:memory-import, test:memory-incremental-summary, test:memory-selection, test:memory-backend-capabilities, test:memory-contract-v2, test:memory-runtime-checkpoint, test:memory-facts, test:memory-retrieval, test:memory-context-budget, test:memory-safe-compaction, test:memory-privacy, test:memory, test:persistent-memory, test:graph-memory, test:composite-memory (all exit 0); npm run build (exit 0); git diff --check (clean).
Schema / configuration / compatibility changes: event-store DB user_version 1 -> 2 (additive migration creating tombstones + deletion_state; existing v1 databases migrate in place and newer versions are still rejected). PERSISTENT_V2_CAPABILITIES supportsForget/supportsExport are now true. New package.json script test:memory-retention.
Residual limitations and follow-up IDs: workspace/principal-wide tombstones are intentionally not cleared by a single-session restore (reauthorizing a broader deletion is a separate operation); local deletion is logical only — SQLite pages/WAL/shm files, backups, previously written prompt logs, and already-sent provider requests have separate lifecycles; no standalone CLI binary was added — the programmatic controller is the narrow local API boundary (MI-16 can integrate further).
Rollback notes: revert the schema v2 migration and the new retention module/wiring. The migration is additive and does not delete v1 data, so reverting the code before writing tombstones is safe; do not downgrade a database that has already written tombstones without an explicit migration path.
Implementation commit(s): be980a5
```
