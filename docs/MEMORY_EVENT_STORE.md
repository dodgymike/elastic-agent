# Isolated SQLite event store (MI-03)

Status: implemented for MI-03. The store is opt-in and does not touch the
repository's legacy `database.sqlite` or `data.json` storage.

## Layout

- `memory/event-store.ts` — `MemoryEventStore` implementing the v2 lifecycle
  interface plus `sessionMetadata` for later reload tasks.
- Dedicated database file (default `memory-event-store/events.sqlite`),
  created owner-only (`0700` directory, database handled by SQLite's file
  modes) after `assertSafeMemoryStatePath` rejects symlinked or foreign-owned
  paths.

## Schema

- Database schema version is stored in SQLite `PRAGMA user_version`
  (`EVENT_STORE_DB_VERSION = 1`). Opening a database with a newer
  `user_version` fails with `UnsupportedEventStoreSchemaError` and never
  overwrites it.
- Tables: `event_scopes` (workspace/principal/session metadata) and `events`
  (append-only rows with unique scoped event IDs and unique scoped sequences).
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
