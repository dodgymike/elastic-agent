# Isolated SQLite event store (MI-03, MI-13 schema v2)

Status: implemented for MI-03; schema version 2 and the forget/retention/export
primitives were added by MI-13. The store is opt-in and does not touch the
repository's legacy `database.sqlite` or `data.json` storage.

## Layout

- `src/memory/event-store.ts` — `MemoryEventStore` implementing the v2 lifecycle
  interface plus `sessionMetadata`, tombstones, deletion generation, restore,
  and retention query helpers.
- `src/memory/retention.ts` — `MemoryRetentionController` (preview/apply forget,
  retention, redacted export, explicit restore). See `docs/memory/MEMORY_RETENTION.md`.
- Dedicated database file (default `memory-event-store/events.sqlite`),
  created owner-only (`0700` directory, database handled by SQLite's file
  modes) after `assertSafeMemoryStatePath` rejects symlinked or foreign-owned
  paths.

## Schema

- Database schema version is stored in SQLite `PRAGMA user_version`
  (`EVENT_STORE_DB_VERSION = 2`). Opening a database with a newer
  `user_version` fails with `UnsupportedEventStoreSchemaError` and never
  overwrites it. Version 1 databases are migrated in place to version 2 by an
  additive migration; version 2 adds `tombstones` and `deletion_state` and
  never deletes existing v1 rows.
- Tables: `event_scopes` (workspace/principal/session metadata), `events`
  (append-only rows with unique scoped event IDs and unique scoped sequences),
  `tombstones` (durable deletion markers keyed by scope plus optional event
  ID), and `deletion_state` (single-row monotonic deletion generation).
- Event payload schema version is stored per event
  (`MEMORY_EVENT_SCHEMA_VERSION`), independent of the database schema version.

## Durability settings

- Journal: `WAL`. Opening a storage arrangement that cannot enable WAL fails
  with `UnsupportedEventStoreStorageError` rather than promising
  network-filesystem safety.
- Synchronous: `NORMAL` (safe with WAL).
- Busy timeout: bounded (default `2000 ms`); competing writers serialize via
  `BEGIN IMMEDIATE` transactions and a bounded wait, then return a typed
  `failure` instead of blocking forever.
- Flush: `PRAGMA wal_checkpoint(TRUNCATE)`.

## Backup and restore

A consistent SQLite snapshot includes the main database file plus, when WAL
mode is active, the `-wal` and `-shm` files. Copying only the live main
database file while the store is open is not a backup procedure. Use
`flush()` to checkpoint first, or close the store and copy all three files
together, or use SQLite's online backup API.

## Forgetting, retention, and export

Deletion primitives live on `MemoryEventStore` (`forget`, `deletionGeneration`,
`tombstones`, `blockingTombstone`, `tombstonedEventIds`, `restoreScope`) and the
user-facing preview/apply boundary lives on `MemoryRetentionController`. Forget
operations commit tombstones and advance the deletion generation in the same
transaction as the authoritative row deletes, so interrupted deletions either
commit fully or roll back. Imports check tombstones and refuse resurrection;
only an explicit `restoreExport` re-adds previously forgotten content. See
`docs/memory/MEMORY_RETENTION.md` for scope selection, retention policy, export
format, and local-deletion limits.
