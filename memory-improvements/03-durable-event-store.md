# MI-03 — Implement an isolated transactional event store

Status: **TODO** · Priority: **P1** · Size: **L**

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
