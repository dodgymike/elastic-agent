# Memory retention, forgetting, and safe export (MI-13)

Status: implemented for MI-13. This is the operator-facing description of the
narrow local boundary that previews and applies forgetting, retention, export,
and explicit restore for the versioned event store.

## Boundaries

- The programmatic boundary is `MemoryRetentionController` in
  `src/memory/retention.ts`. `PersistentV2MemoryModule` and `CompositeMemoryModule`
  route the same operations to their authoritative owner exactly once.
- There is deliberately no natural-language deletion. Every forget selection is
  an exact record, session, or workspace/principal request:

  | Selection | Shape | Effect |
  | --- | --- | --- |
  | `record` | `{ kind, scope, eventIds }` | Deletes exactly those event rows. |
  | `session` | `{ kind, scope }` | Deletes every event in one session scope. |
  | `workspace-principal` | `{ kind, workspaceId, principalId }` | Deletes every session for that workspace + principal. |

- `previewForget` reports `wouldDelete` without mutating. `forget` returns
  `status`, `generation`, `deleted`, and `notFound`. Repeated selections are
  idempotent and report already-removed records via `notFound`.

## Tombstones and deletion generation

`MemoryEventStore.forget` commits, in one `BEGIN IMMEDIATE` transaction:

1. a monotonic deletion-generation bump (`deletion_state`);
2. durable tombstone rows (`tombstones`) for the exact selection; and
3. the authoritative event-row deletes.

An interrupted deletion therefore either commits fully or rolls back. Imports
(`importLegacyMemoryDocument`) check tombstones and refuse to resurrect content;
only `restoreExport` re-adds previously forgotten records, and it clears the
record/session tombstones it restores. A workspace/principal-wide tombstone is
intentionally left in place by a single-session restore because restoring one
session cannot reauthorize a broader deletion.

## In-flight derived work

`IncrementalSummaryManager` records the deletion generation it observed before
calling a summarizer. If the generation advances while the summarizer is in
flight, the completion is treated as stale and never overwrites the current
checkpoint, so forgotten content cannot be reintroduced by a late model
response.

## Retention

`previewRetention` and `applyRetention` are separate steps. Policy fields are:

- `olderThanMs` — prune whole records strictly older than the cutoff;
- `maxEventsPerScope` — prune a scope's oldest records down to the cap;
- `maxScopes` — prune whole oldest scopes down to the cap;
- `includeProtected` — when `false` (default), scopes containing current
  authoritative constraints or open work are skipped and reported via
  `skippedProtected`.

Retention never silently destroys the only record of unresolved work or an
explicit user constraint unless `includeProtected: true` is set.

## Export and restore

`exportScope(scope, { filePath? })` produces a redacted, versioned
`MemoryExportDocumentV1`:

```json
{
  "schemaVersion": 1,
  "exportedAt": "<iso-8601>",
  "scope": { "workspaceId": "...", "principalId": "...", "sessionId": "..." },
  "deletionGeneration": 0,
  "events": ["<validated envelopes with privacy-sanitized payloads>"],
  "tombstones": []
}
```

Event payloads are re-run through the privacy boundary (`sanitizeMemoryJson`)
during export, so sensitive key names are redacted and oversized strings are
truncated. When a `filePath` is supplied, the parent directory is created
owner-only (`0700`) and the file is written owner-only (`0600`). Restore reads
the export from a path or object, validates the schema/scope/provenance, and
re-adds non-deleted records with their original event IDs, sequences,
timestamps, and identity.

## Limits of local deletion

Forgetting is local logical deletion plus a tombstone. It is **not**:

- forensic secure erasure — SQLite may leave data in freed pages or in the
  `-wal`/`-shm` files until checkpoint/`VACUUM`;
- remote deletion — content already sent to a provider or written to prompt
  logs, backups, or external indexes is outside this boundary;
- a replacement for a backup/restore procedure (see `docs/memory/MEMORY_EVENT_STORE.md`).

Operators who need tighter cleanup should checkpoint/close the store, then use
SQLite's `VACUUM` (or an online backup into a fresh file), and manage their own
external log and backup lifecycles. Do not promise forensic erasure or remote
deletion from `forget` alone.

## Failure handling and rollback

Deletion is not ordinarily reversible: prefer `previewForget` /
`previewRetention` before `forget` / `applyRetention`. `restoreExport` is the
explicit reversal path. The schema-v2 migration is additive and does not delete
v1 data, so reverting the code before tombstones are written is safe; do not
downgrade a database that has already written tombstones without a dedicated
migration.
