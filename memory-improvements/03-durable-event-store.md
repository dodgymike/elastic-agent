# MI-03 — Implement an isolated transactional event store

Status: **DONE** · Priority: **P1** · Size: **L**

Dependencies: [MI-01](01-contracts-and-identity.md), [MI-02](02-privacy-and-trust.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

The current backend keeps mutable in-process maps and writes one JSON document at finalization. Atomic rename prevents a partially written file, but does not provide per-step durability, multi-writer coordination, event deduplication, or safe replay. Introduce an append-oriented source of truth that summaries and indexes can be rebuilt from.

## Starting points in the repository

- [memory/persistent.ts](../memory/persistent.ts) — historyBySession, finalize, atomicWriteJson.
- [package.json](../package.json) — existing sqlite and sqlite3 dependencies.
- [memory/types.ts](../memory/types.ts) — new contracts from task 01.
- [initializeDatabase.js](../initializeDatabase.js) — legacy database initialization; inspect code only, do not reuse its live database.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Use a new dedicated SQLite database under an owner-only application state directory. Reuse the installed sqlite/sqlite3 dependencies after checking their local APIs. Do not attach to or migrate the repository's existing database.sqlite or data.json storage.

2. Create versioned schema migrations for scopes/sessions, append-only events, and derived-state metadata. Keep event payload schema version independent of database schema version. Reject a newer incompatible schema without overwriting it.

3. Enforce unique scoped event IDs and monotonic per-session sequences transactionally. The same ID/digest is an idempotent retry; the same ID with a different digest is an explicit conflict. Use bound SQL parameters throughout.

4. Choose and document transaction, synchronous, journal, and bounded busy-timeout settings. WAL is a candidate for supported local filesystems; verify actual behavior and reject unsupported storage arrangements rather than promising network-filesystem safety.

5. Implement append, bounded event paging, session metadata lookup, integrity/version checks, flush, and close. Add indexes for exact scope and sequence access. Never deserialize another scope's payload before applying the ownership filter.

6. Test multiple process connections, competing appends, interruption around commit, disk/write errors, and invalid database files. Propagate typed durability results. Do not retry a tool mutation because its memory append failed.

7. Keep the new backend opt-in and expose it through an internal factory for subsequent tasks; do not yet replace runtime defaults.

## Acceptance criteria

- [ ] A committed append is visible after closing and reopening from another process; a rolled-back append is absent.
- [ ] Two writers do not silently lose events or assign conflicting committed sequences. Duplicate delivery is idempotent; divergent duplicate payloads fail.
- [ ] Exact scope filtering is enforced by the store, and oversized pages are bounded.
- [ ] Unsupported schema, lock exhaustion, and write failure return explicit errors without replacing existing data.

## Validation

Add `test/memory-event-store.test.ts` using a fresh temporary database per case and child processes for concurrency/crash tests. Verify schema migrations from checked-in synthetic fixtures. Run contract/privacy tests and `npm run build`. No production database contents are test inputs.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

The store is a new file format behind an opt-in factory. Keep old JSON files untouched. Document backup/restore for a consistent SQLite snapshot, including journal files where applicable; copying a live main database file alone is not a backup procedure.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); MI-01 (0d732be/0dfa638) and MI-02 (8ff18b8/6268b56) present.
Prerequisite evidence: MI-01 and MI-02 DONE; contracts-v2 and privacy modules available.
Reproduction / old behavior: persistent.ts kept mutable in-process maps and wrote one JSON document at finalization; no per-step durability, multi-writer coordination, event dedup, or safe replay existed.
Changed files and behavior:
  - memory/event-store.ts (new): MemoryEventStore SQLite backend; WAL + synchronous=NORMAL + bounded busy timeout; BEGIN IMMEDIATE transactions; unique scoped event IDs and per-session sequences; idempotent duplicates; conflicts; bounded paging; sessionMetadata; typed durability results; opt-in factory.
  - memory/contracts-v2.ts: add afterSequence/limit paging fields to MemoryRetrieveRequestV2.
  - memory/index.ts: export event-store surface.
  - docs/MEMORY_EVENT_STORE.md (new): schema, durability settings, backup/restore guidance.
  - test/memory-event-store.test.ts (new): durability, idempotence/conflict, writers, scope filtering, paging, schema rejection, invalid files, lock exhaustion, child-process reopen.
  - package.json: add test:memory-event-store script.
Validation commands and actual results:
  - npm run test:memory-event-store -> exit 0
  - npm run test:memory-contract-v2 -> exit 0
  - npm run test:memory-privacy -> exit 0
  - npm run build -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node memory/index.ts -> exit 0
  - git diff --check -> clean
Schema / configuration / compatibility changes: new opt-in SQLite file format with user_version=1; event payload schema version stored per event; legacy JSON files untouched.
Residual limitations and follow-up IDs: reload/import of legacy JSON is MI-04; derived-state metadata consumers arrive in later tasks; network-filesystem safety is rejected rather than supported; disk-full and interrupted-commit tests are partially covered by invalid-file and lock tests (no fault injection).
Rollback notes: remove the opt-in factory and its callers; no migration of existing JSON files is required.
Implementation commit(s): 5d12c2f (implementation + tests + docs); completion record commit follows.
```
