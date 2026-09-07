/**
 * Isolated transactional SQLite event store (MI-03).
 *
 * This is the append-oriented source of truth for the versioned memory
 * contract: scopes/sessions are rows, events are append-only rows with a
 * per-session monotonic sequence, and summaries/indexes can later be rebuilt
 * from retained events. It is deliberately opt-in and does NOT touch the
 * repository's legacy `database.sqlite` or `data.json` storage.
 *
 * Durability choices (documented here so operators can reason about them):
 *  - WAL journal mode on supported local filesystems; opening rejects storage
 *    that cannot enable WAL rather than silently promising network-fs safety.
 *  - `synchronous=NORMAL` (safe with WAL) for a bounded durability/latency
 *    trade-off, plus a bounded `busy_timeout` for competing writers.
 *  - Transactions use `BEGIN IMMEDIATE` so competing writers serialize on the
 *    write lock instead of both reading the same next sequence.
 *  - Event payload schema version is stored per event, independent of the
 *    database `user_version` schema version.
 *
 * MI-13 extends schema version 1 with a schema version 2 migration that adds
 * durable deletion tombstones plus a single-row monotonic deletion generation.
 * Forget operations commit tombstones and advance the generation before any
 * authoritative event row is removed; retention, export, and restore build on
 * those primitives in `src/memory/retention.ts`.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import {
  assertScopeMatches,
  buildEventEnvelope,
  computeEventDigest,
  MEMORY_EVENT_SCHEMA_VERSION,
  scopeFromIdentity,
  validateEventAppend,
  validateEventEnvelope,
  validateForgetSelection,
  validateRetrievalPurpose,
  validateScope,
  type MemoryAppendResultV2,
  type MemoryCapabilitiesV2,
  type MemoryCloseResultV2,
  type MemoryEventAppendV2,
  type MemoryEventEnvelopeV2,
  type MemoryEventKindV2,
  type MemoryFlushResultV2,
  type MemoryForgetResultV2,
  type MemoryForgetSelectionV2,
  type MemoryIdentityV2,
  type MemoryInitResultV2,
  type MemoryModuleV2,
  type MemoryRestoreResultV2,
  type MemoryRetrieveRequestV2,
  type MemoryRetrieveResultV2,
  type MemoryScopeSummaryV2,
  type MemoryScopeV2,
  type MemoryTombstoneV2,
} from "./contracts-v2.js";
import { assertSafeMemoryStatePath } from "./privacy.js";

/** Database schema version managed via SQLite `PRAGMA user_version`. */
export const EVENT_STORE_DB_VERSION = 2 as const;

const DEFAULT_BUSY_TIMEOUT_MS = 2000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;
const MAX_RETENTION_PAGE_LIMIT = 10_000;
const DEFAULT_DB_PATH = "memory-event-store/events.sqlite";

/** Base error type for explicit event-store failures. */
export class MemoryEventStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryEventStoreError";
  }
}

/** The database file uses a newer schema than this build supports. */
export class UnsupportedEventStoreSchemaError extends MemoryEventStoreError {
  constructor(version: number) {
    super(
      `unsupported event store schema version ${version}; this build supports up to ${EVENT_STORE_DB_VERSION}`,
    );
    this.name = "UnsupportedEventStoreSchemaError";
  }
}

/** The storage arrangement cannot enable the required WAL journal mode. */
export class UnsupportedEventStoreStorageError extends MemoryEventStoreError {
  constructor(journalMode: string) {
    super(
      `unsupported event store storage: WAL journal mode required but got '${journalMode}'`,
    );
    this.name = "UnsupportedEventStoreStorageError";
  }
}

export interface MemoryEventStoreOptions {
  /** Path to the dedicated SQLite database file. */
  readonly filePath?: string;
  /** Bounded busy timeout in milliseconds for competing writers. */
  readonly busyTimeoutMs?: number;
}

interface EventRow {
  id: number;
  workspace_id: string;
  principal_id: string;
  session_id: string;
  event_id: string;
  sequence: number;
  schema_version: number;
  digest: string;
  run_id: string;
  task_id: string | null;
  run_ref: string;
  step_ref: string | null;
  timestamp: string;
  kind: string;
  outcome_json: string | null;
  payload_json: string | null;
  evidence_refs_json: string | null;
}

interface ScopeRow {
  created_at: string;
  last_sequence: number;
  event_count: number;
}

interface TombstoneRow {
  id: number;
  workspace_id: string;
  principal_id: string;
  session_id: string | null;
  event_id: string | null;
  kind: string;
  generation: number;
  created_at: string;
}

interface ScopeSummaryRow {
  workspace_id: string;
  principal_id: string;
  session_id: string;
  event_count: number;
  oldest_timestamp: string;
  newest_timestamp: string;
}

const CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: true,
  retrievalPurposes: ["prompt-context", "replay", "audit", "export"],
  supportsCompaction: false,
  supportsForget: true,
  supportsExport: true,
};

/**
 * SQLite-backed `MemoryModuleV2` implementation.
 */
export class MemoryEventStore implements MemoryModuleV2 {
  readonly capabilities: MemoryCapabilitiesV2 = CAPABILITIES;

  private db: Database | null = null;
  private readonly filePath: string;
  private readonly busyTimeoutMs: number;

  constructor(options: MemoryEventStoreOptions = {}) {
    this.filePath = resolve(options.filePath ?? DEFAULT_DB_PATH);
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  }

  /** The resolved database path this store will use. */
  get path(): string {
    return this.filePath;
  }

  async initialize(scope: MemoryScopeV2): Promise<MemoryInitResultV2> {
    try {
      validateScope(scope);
      await this.ensureOpen();
      await this.ensureScope(scope);
      return { status: "ready", scope };
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
  }

  async append(scope: MemoryScopeV2, event: MemoryEventAppendV2): Promise<MemoryAppendResultV2> {
    try {
      validateScope(scope);
      const append = validateEventAppend(event);
      assertScopeMatches(scope, scopeFromIdentity(append.identity), "append scope");
      const digest = computeEventDigest(append);
      await this.ensureOpen();
      const db = this.db as Database;
      await db.exec("BEGIN IMMEDIATE");
      try {
        await this.ensureScope(scope);
        const existing = await db.get<{ event_id: string; digest: string }>(
          `SELECT event_id, digest FROM events
           WHERE workspace_id = ? AND principal_id = ? AND session_id = ? AND event_id = ?`,
          scope.workspaceId,
          scope.principalId,
          scope.sessionId,
          append.eventId,
        );
        if (existing) {
          await db.exec("COMMIT");
          if (existing.digest === digest) {
            return { status: "duplicate", eventId: append.eventId };
          }
          return {
            status: "conflict",
            eventId: append.eventId,
            reason: "event id reused with a different content digest",
          };
        }
        const nextRow = await db.get<{ next: number }>(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events
           WHERE workspace_id = ? AND principal_id = ? AND session_id = ?`,
          scope.workspaceId,
          scope.principalId,
          scope.sessionId,
        );
        const sequence = nextRow?.next ?? 1;
        const timestamp = append.timestamp ?? new Date().toISOString();
        await db.run(
          `INSERT INTO events (
             workspace_id, principal_id, session_id, event_id, sequence,
             schema_version, digest, run_id, task_id, run_ref, step_ref,
             timestamp, kind, outcome_json, payload_json, evidence_refs_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          scope.workspaceId,
          scope.principalId,
          scope.sessionId,
          append.eventId,
          sequence,
          MEMORY_EVENT_SCHEMA_VERSION,
          digest,
          append.identity.runId,
          append.identity.taskId ?? null,
          append.runRef,
          append.stepRef ?? null,
          timestamp,
          append.kind,
          append.outcome === undefined ? null : JSON.stringify(append.outcome),
          append.payload === undefined ? null : JSON.stringify(append.payload),
          JSON.stringify(append.evidenceRefs ?? []),
        );
        await db.run(
          `UPDATE event_scopes SET last_sequence = ? WHERE workspace_id = ? AND principal_id = ? AND session_id = ?`,
          sequence,
          scope.workspaceId,
          scope.principalId,
          scope.sessionId,
        );
        await db.exec("COMMIT");
        return { status: "durable", eventId: append.eventId, sequence };
      } catch (error) {
        await safeRollback(db);
        return { status: "failure", reason: describeError(error) };
      }
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
  }

  async retrieve(request: MemoryRetrieveRequestV2): Promise<MemoryRetrieveResultV2> {
    try {
      validateScope(request.scope);
      validateRetrievalPurpose(request.purpose);
      await this.ensureOpen();
      const db = this.db as Database;
      const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT));
      const rows = await db.all<EventRow[]>(
        `SELECT id, workspace_id, principal_id, session_id, event_id, sequence,
                schema_version, digest, run_id, task_id, run_ref, step_ref,
                timestamp, kind, outcome_json, payload_json, evidence_refs_json
         FROM events
         WHERE workspace_id = ? AND principal_id = ? AND session_id = ?
           AND (? IS NULL OR sequence > ?)
         ORDER BY sequence ASC
         LIMIT ?`,
        request.scope.workspaceId,
        request.scope.principalId,
        request.scope.sessionId,
        request.afterSequence ?? null,
        request.afterSequence ?? 0,
        limit,
      );
      const events: MemoryEventEnvelopeV2[] = [];
      const evidenceRefs: string[] = [];
      let degraded = false;
      let degradedReason: string | undefined;
      for (const row of rows) {
        if (row.schema_version !== MEMORY_EVENT_SCHEMA_VERSION) {
          degraded = true;
          degradedReason = `unsupported event payload schema version ${row.schema_version}`;
          continue;
        }
        const envelope = rowToEnvelope(row);
        events.push(envelope);
        for (const ref of envelope.evidenceRefs) {
          if (!evidenceRefs.includes(ref)) evidenceRefs.push(ref);
        }
      }
      const revisionRow = await db.get<{ rev: number }>("SELECT COALESCE(MAX(id), 0) AS rev FROM events");
      return {
        scope: request.scope,
        revision: revisionRow?.rev ?? 0,
        events,
        evidenceRefs,
        degraded,
        ...(degraded ? { degradedReason } : {}),
      };
    } catch (error) {
      return {
        scope: request.scope,
        revision: 0,
        events: [],
        evidenceRefs: [],
        degraded: true,
        degradedReason: describeError(error),
      };
    }
  }

  async flush(scope: MemoryScopeV2): Promise<MemoryFlushResultV2> {
    try {
      validateScope(scope);
      await this.ensureOpen();
      const db = this.db as Database;
      await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const revisionRow = await db.get<{ rev: number }>("SELECT COALESCE(MAX(id), 0) AS rev FROM events");
      return { status: "durable", revision: revisionRow?.rev ?? 0 };
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
  }

  async close(scope: MemoryScopeV2): Promise<MemoryCloseResultV2> {
    try {
      validateScope(scope);
      if (this.db) {
        await this.db.close();
        this.db = null;
      }
      return { status: "closed" };
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
  }

  /** Metadata lookup for one session (used by later reload tasks). */
  async sessionMetadata(scope: MemoryScopeV2): Promise<ScopeRow> {
    validateScope(scope);
    await this.ensureOpen();
    const db = this.db as Database;
    const row = await db.get<{ created_at: string; last_sequence: number; event_count: number }>(
      `SELECT s.created_at, s.last_sequence, COUNT(e.id) AS event_count
       FROM event_scopes s
       LEFT JOIN events e ON e.workspace_id = s.workspace_id
         AND e.principal_id = s.principal_id
         AND e.session_id = s.session_id
       WHERE s.workspace_id = ? AND s.principal_id = ? AND s.session_id = ?
       GROUP BY s.workspace_id, s.principal_id, s.session_id`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
    );
    return {
      created_at: row?.created_at ?? "",
      last_sequence: row?.last_sequence ?? 0,
      event_count: row?.event_count ?? 0,
    };
  }

  /**
   * Apply an exact forget selection. Tombstones and the deletion generation are
   * committed in the same transaction as the authoritative row deletions, so an
   * interrupted operation either fully commits or fully rolls back. Repeated
   * selections are idempotent: already-removed records are reported via
   * `notFound` rather than being resurrected or silently double-deleted.
   */
  async forget(selection: MemoryForgetSelectionV2): Promise<MemoryForgetResultV2> {
    try {
      const sel = validateForgetSelection(selection);
      await this.ensureOpen();
      const db = this.db as Database;
      await db.exec("BEGIN IMMEDIATE");
      try {
        const generation = await this.bumpDeletionGeneration(db);
        let deleted = 0;
        let notFound = 0;
        if (sel.kind === "record") {
          for (const eventId of sel.eventIds) {
            const existing = await db.get<{ id: number }>(
              `SELECT id FROM events
               WHERE workspace_id = ? AND principal_id = ? AND session_id = ? AND event_id = ?`,
              sel.scope.workspaceId,
              sel.scope.principalId,
              sel.scope.sessionId,
              eventId,
            );
            if (!existing) {
              notFound += 1;
              continue;
            }
            await db.run(
              `DELETE FROM events
               WHERE workspace_id = ? AND principal_id = ? AND session_id = ? AND event_id = ?`,
              sel.scope.workspaceId,
              sel.scope.principalId,
              sel.scope.sessionId,
              eventId,
            );
            deleted += 1;
            await this.insertRecordTombstone(db, sel.scope, eventId, "record", generation);
          }
          await this.refreshScopeRow(sel.scope);
        } else if (sel.kind === "session") {
          await this.insertScopeTombstone(db, sel.scope, "session", generation);
          const result = await db.run(
            `DELETE FROM events
             WHERE workspace_id = ? AND principal_id = ? AND session_id = ?`,
            sel.scope.workspaceId,
            sel.scope.principalId,
            sel.scope.sessionId,
          );
          deleted = result.changes ?? 0;
          await db.run(
            `DELETE FROM event_scopes
             WHERE workspace_id = ? AND principal_id = ? AND session_id = ?`,
            sel.scope.workspaceId,
            sel.scope.principalId,
            sel.scope.sessionId,
          );
        } else {
          await this.insertPrincipalTombstone(db, sel.workspaceId, sel.principalId, generation);
          const result = await db.run(
            `DELETE FROM events WHERE workspace_id = ? AND principal_id = ?`,
            sel.workspaceId,
            sel.principalId,
          );
          deleted = result.changes ?? 0;
          await db.run(
            `DELETE FROM event_scopes WHERE workspace_id = ? AND principal_id = ?`,
            sel.workspaceId,
            sel.principalId,
          );
        }
        await db.exec("COMMIT");
        return { status: "forgotten", kind: sel.kind, generation, deleted, notFound };
      } catch (error) {
        await safeRollback(db);
        return { status: "failure", reason: describeError(error) };
      }
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
  }

  /** The current monotonic deletion generation. */
  async deletionGeneration(): Promise<number> {
    await this.ensureOpen();
    const row = await (this.db as Database).get<{ generation: number }>(
      "SELECT generation FROM deletion_state WHERE id = 1",
    );
    return row?.generation ?? 0;
  }

  /** True when an event row currently exists for the exact scope + event ID. */
  async eventExists(scope: MemoryScopeV2, eventId: string): Promise<boolean> {
    validateScope(scope);
    if (typeof eventId !== "string" || eventId.length === 0) return false;
    await this.ensureOpen();
    const row = await (this.db as Database).get<{ id: number }>(
      `SELECT id FROM events
       WHERE workspace_id = ? AND principal_id = ? AND session_id = ? AND event_id = ?`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
      eventId,
    );
    return row !== undefined;
  }

  /**
   * Return the tombstones for a scope (workspace/principal-wide, session-wide,
   * and record-level) or, when no scope is supplied, all tombstones.
   */
  async tombstones(scope?: MemoryScopeV2): Promise<readonly MemoryTombstoneV2[]> {
    await this.ensureOpen();
    const db = this.db as Database;
    let rows: TombstoneRow[];
    if (scope) {
      validateScope(scope);
      rows = await db.all<TombstoneRow[]>(
        `SELECT id, workspace_id, principal_id, session_id, event_id, kind, generation, created_at
         FROM tombstones
         WHERE workspace_id = ? AND principal_id = ?
           AND (session_id IS NULL OR session_id = ?)
         ORDER BY id ASC`,
        scope.workspaceId,
        scope.principalId,
        scope.sessionId,
      );
    } else {
      rows = await db.all<TombstoneRow[]>(
        `SELECT id, workspace_id, principal_id, session_id, event_id, kind, generation, created_at
         FROM tombstones
         ORDER BY id ASC`,
      );
    }
    return rows.map(rowToTombstone);
  }

  /**
   * Return the coarsest tombstone that blocks all future imports for a scope:
   * a workspace/principal tombstone wins, then a session tombstone. Record-level
   * tombstones are checked separately via `tombstonedEventIds`.
   */
  async blockingTombstone(scope: MemoryScopeV2): Promise<MemoryTombstoneV2 | null> {
    validateScope(scope);
    await this.ensureOpen();
    const row = await (this.db as Database).get<TombstoneRow>(
      `SELECT id, workspace_id, principal_id, session_id, event_id, kind, generation, created_at
       FROM tombstones
       WHERE workspace_id = ? AND principal_id = ?
         AND (session_id IS NULL OR (session_id = ? AND event_id IS NULL))
       ORDER BY CASE WHEN session_id IS NULL THEN 0 ELSE 1 END, id ASC
       LIMIT 1`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
    );
    return row ? rowToTombstone(row) : null;
  }

  /** Return the subset of event IDs that have record-level tombstones in `scope`. */
  async tombstonedEventIds(scope: MemoryScopeV2, eventIds: readonly string[]): Promise<string[]> {
    validateScope(scope);
    if (eventIds.length === 0) return [];
    await this.ensureOpen();
    const placeholders = eventIds.map(() => "?").join(", ");
    const rows = await (this.db as Database).all<{ event_id: string }[]>(
      `SELECT event_id FROM tombstones
       WHERE workspace_id = ? AND principal_id = ? AND session_id = ?
         AND event_id IN (${placeholders})`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
      ...eventIds,
    );
    return rows.map((row) => row.event_id);
  }

  /** Per-scope event counts plus oldest/newest timestamps for retention. */
  async scopeSummaries(): Promise<readonly MemoryScopeSummaryV2[]> {
    await this.ensureOpen();
    const rows = await (this.db as Database).all<ScopeSummaryRow[]>(
      `SELECT workspace_id, principal_id, session_id,
              COUNT(id) AS event_count,
              MIN(timestamp) AS oldest_timestamp,
              MAX(timestamp) AS newest_timestamp
       FROM events
       GROUP BY workspace_id, principal_id, session_id
       ORDER BY newest_timestamp ASC`,
    );
    return rows.map((row) => ({
      scope: {
        workspaceId: row.workspace_id,
        principalId: row.principal_id,
        sessionId: row.session_id,
      },
      eventCount: row.event_count,
      oldestTimestamp: row.oldest_timestamp,
      newestTimestamp: row.newest_timestamp,
    }));
  }

  /** The `count` oldest events in a scope, in ascending sequence order. */
  async oldestEvents(scope: MemoryScopeV2, count: number): Promise<readonly MemoryEventEnvelopeV2[]> {
    validateScope(scope);
    await this.ensureOpen();
    const limit = Math.max(0, Math.min(Math.trunc(count), MAX_RETENTION_PAGE_LIMIT));
    if (limit === 0) return [];
    const rows = await (this.db as Database).all<EventRow[]>(
      `SELECT id, workspace_id, principal_id, session_id, event_id, sequence,
              schema_version, digest, run_id, task_id, run_ref, step_ref,
              timestamp, kind, outcome_json, payload_json, evidence_refs_json
       FROM events
       WHERE workspace_id = ? AND principal_id = ? AND session_id = ?
       ORDER BY sequence ASC
       LIMIT ?`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
      limit,
    );
    return rows.map(rowToEnvelope);
  }

  /** Events in a scope whose timestamp is strictly before the given timestamp. */
  async eventsBefore(scope: MemoryScopeV2, timestamp: string): Promise<readonly MemoryEventEnvelopeV2[]> {
    validateScope(scope);
    if (typeof timestamp !== "string" || timestamp.length === 0) return [];
    await this.ensureOpen();
    const rows = await (this.db as Database).all<EventRow[]>(
      `SELECT id, workspace_id, principal_id, session_id, event_id, sequence,
              schema_version, digest, run_id, task_id, run_ref, step_ref,
              timestamp, kind, outcome_json, payload_json, evidence_refs_json
       FROM events
       WHERE workspace_id = ? AND principal_id = ? AND session_id = ?
         AND timestamp < ?
       ORDER BY sequence ASC
       LIMIT ?`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
      timestamp,
      MAX_RETENTION_PAGE_LIMIT,
    );
    return rows.map(rowToEnvelope);
  }

  /**
   * Explicitly restore previously forgotten events from a validated export.
   * This is the only path that re-adds tombstoned content; ordinary imports
   * still refuse it. Record- and session-level tombstones for the restored
   * scope are cleared, while workspace/principal-wide tombstones intentionally
   * remain because a single session restore cannot reauthorize a broader
   * deletion.
   */
  async restoreScope(scope: MemoryScopeV2, events: readonly MemoryEventEnvelopeV2[]): Promise<MemoryRestoreResultV2> {
    try {
      validateScope(scope);
      if (!Array.isArray(events)) throw new Error("restore events must be an array");
      const envelopes = events.map((event) => {
        const envelope = validateEventEnvelope(event);
        assertScopeMatches(scope, scopeFromIdentity(envelope.identity), "restore scope");
        return envelope;
      });
      await this.ensureOpen();
      const db = this.db as Database;
      await db.exec("BEGIN IMMEDIATE");
      try {
        await this.ensureScope(scope);
        const generation = await this.bumpDeletionGeneration(db);
        let inserted = 0;
        for (const envelope of envelopes) {
          const existing = await db.get<{ id: number }>(
            `SELECT id FROM events
             WHERE workspace_id = ? AND principal_id = ? AND session_id = ? AND event_id = ?`,
            scope.workspaceId,
            scope.principalId,
            scope.sessionId,
            envelope.eventId,
          );
          if (existing) continue;
          await db.run(
            `INSERT INTO events (
               workspace_id, principal_id, session_id, event_id, sequence,
               schema_version, digest, run_id, task_id, run_ref, step_ref,
               timestamp, kind, outcome_json, payload_json, evidence_refs_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            scope.workspaceId,
            scope.principalId,
            scope.sessionId,
            envelope.eventId,
            envelope.sequence,
            envelope.schemaVersion,
            computeEventDigest(envelope),
            envelope.identity.runId,
            envelope.identity.taskId ?? null,
            envelope.runRef,
            envelope.stepRef ?? null,
            envelope.timestamp,
            envelope.kind,
            envelope.outcome === undefined ? null : JSON.stringify(envelope.outcome),
            envelope.payload === undefined ? null : JSON.stringify(envelope.payload),
            JSON.stringify(envelope.evidenceRefs ?? []),
          );
          inserted += 1;
          await db.run(
            `DELETE FROM tombstones
             WHERE workspace_id = ? AND principal_id = ? AND session_id = ? AND event_id = ?`,
            scope.workspaceId,
            scope.principalId,
            scope.sessionId,
            envelope.eventId,
          );
        }
        await db.run(
          `DELETE FROM tombstones
           WHERE workspace_id = ? AND principal_id = ? AND session_id = ?
             AND event_id IS NULL AND kind = 'session'`,
          scope.workspaceId,
          scope.principalId,
          scope.sessionId,
        );
        await this.refreshScopeRow(scope);
        await db.exec("COMMIT");
        return { status: "restored", scope, eventCount: inserted, generation };
      } catch (error) {
        await safeRollback(db);
        return { status: "failure", reason: describeError(error) };
      }
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
  }

  private async insertRecordTombstone(
    db: Database,
    scope: MemoryScopeV2,
    eventId: string,
    kind: "record" | "session" | "workspace-principal",
    generation: number,
  ): Promise<void> {
    await db.run(
      `INSERT OR IGNORE INTO tombstones (
         workspace_id, principal_id, session_id, event_id, kind, generation, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
      eventId,
      kind,
      generation,
      new Date().toISOString(),
    );
  }

  private async insertScopeTombstone(
    db: Database,
    scope: MemoryScopeV2,
    kind: "session",
    generation: number,
  ): Promise<void> {
    await db.run(
      `INSERT INTO tombstones (
         workspace_id, principal_id, session_id, event_id, kind, generation, created_at
       )
       SELECT ?, ?, ?, NULL, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM tombstones
         WHERE workspace_id = ? AND principal_id = ? AND session_id = ? AND event_id IS NULL
       )`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
      kind,
      generation,
      new Date().toISOString(),
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
    );
  }

  private async insertPrincipalTombstone(
    db: Database,
    workspaceId: string,
    principalId: string,
    generation: number,
  ): Promise<void> {
    await db.run(
      `INSERT INTO tombstones (
         workspace_id, principal_id, session_id, event_id, kind, generation, created_at
       )
       SELECT ?, ?, NULL, NULL, 'workspace-principal', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM tombstones
         WHERE workspace_id = ? AND principal_id = ? AND session_id IS NULL AND event_id IS NULL
       )`,
      workspaceId,
      principalId,
      generation,
      new Date().toISOString(),
      workspaceId,
      principalId,
    );
  }

  private async refreshScopeRow(scope: MemoryScopeV2): Promise<void> {
    const db = this.db as Database;
    const remaining = await db.get<{ count: number; max_seq: number }>(
      `SELECT COUNT(id) AS count, COALESCE(MAX(sequence), 0) AS max_seq
       FROM events
       WHERE workspace_id = ? AND principal_id = ? AND session_id = ?`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
    );
    if (!remaining || remaining.count === 0) {
      await db.run(
        `DELETE FROM event_scopes
         WHERE workspace_id = ? AND principal_id = ? AND session_id = ?`,
        scope.workspaceId,
        scope.principalId,
        scope.sessionId,
      );
      return;
    }
    await db.run(
      `UPDATE event_scopes SET last_sequence = ?
       WHERE workspace_id = ? AND principal_id = ? AND session_id = ?`,
      remaining.max_seq,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
    );
  }

  private async bumpDeletionGeneration(db: Database): Promise<number> {
    await db.run("UPDATE deletion_state SET generation = generation + 1 WHERE id = 1");
    const row = await db.get<{ generation: number }>(
      "SELECT generation FROM deletion_state WHERE id = 1",
    );
    return row?.generation ?? 1;
  }

  private async ensureOpen(): Promise<void> {
    if (this.db) return;
    assertSafeMemoryStatePath(this.filePath);
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const db = await open({ filename: this.filePath, driver: sqlite3.Database });
    try {
      db.configure("busyTimeout", this.busyTimeoutMs);
      const journal = await db.get<{ journal_mode: string }>("PRAGMA journal_mode = WAL");
      if (journal && journal.journal_mode !== "wal" && journal.journal_mode !== "memory") {
        throw new UnsupportedEventStoreStorageError(journal.journal_mode);
      }
      await db.exec("PRAGMA synchronous = NORMAL");
      await this.applyMigrations(db);
      this.db = db;
    } catch (error) {
      try {
        await db.close();
      } catch {
        // ignore close failure while propagating the original error
      }
      throw error;
    }
  }

  private async applyMigrations(db: Database): Promise<void> {
    const versionRow = await db.get<{ user_version: number }>("PRAGMA user_version");
    const version = versionRow?.user_version ?? 0;
    if (version > EVENT_STORE_DB_VERSION) {
      throw new UnsupportedEventStoreSchemaError(version);
    }
    if (version < 1) {
      await db.exec("BEGIN IMMEDIATE");
      try {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS event_scopes (
            workspace_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_sequence INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (workspace_id, principal_id, session_id)
          );
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            schema_version INTEGER NOT NULL,
            digest TEXT NOT NULL,
            run_id TEXT NOT NULL,
            task_id TEXT,
            run_ref TEXT NOT NULL,
            step_ref TEXT,
            timestamp TEXT NOT NULL,
            kind TEXT NOT NULL,
            outcome_json TEXT,
            payload_json TEXT,
            evidence_refs_json TEXT NOT NULL,
            UNIQUE (workspace_id, principal_id, session_id, event_id),
            UNIQUE (workspace_id, principal_id, session_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_events_scope_sequence
            ON events (workspace_id, principal_id, session_id, sequence);
          CREATE INDEX IF NOT EXISTS idx_events_scope_event
            ON events (workspace_id, principal_id, session_id, event_id);
        `);
        await db.exec(`PRAGMA user_version = ${EVENT_STORE_DB_VERSION}`);
        await db.exec("COMMIT");
      } catch (error) {
        await safeRollback(db);
        throw error;
      }
    }
    if (version < 2) {
      await db.exec("BEGIN IMMEDIATE");
      try {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS tombstones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            session_id TEXT,
            event_id TEXT,
            kind TEXT NOT NULL,
            generation INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (workspace_id, principal_id, session_id, event_id)
          );
          CREATE INDEX IF NOT EXISTS idx_tombstones_scope
            ON tombstones (workspace_id, principal_id, session_id);
          CREATE INDEX IF NOT EXISTS idx_tombstones_principal
            ON tombstones (workspace_id, principal_id);
          CREATE TABLE IF NOT EXISTS deletion_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            generation INTEGER NOT NULL DEFAULT 0
          );
          INSERT OR IGNORE INTO deletion_state (id, generation) VALUES (1, 0);
        `);
        await db.exec(`PRAGMA user_version = ${EVENT_STORE_DB_VERSION}`);
        await db.exec("COMMIT");
      } catch (error) {
        await safeRollback(db);
        throw error;
      }
    }
  }

  private async ensureScope(scope: MemoryScopeV2): Promise<void> {
    const db = this.db as Database;
    await db.run(
      `INSERT INTO event_scopes (workspace_id, principal_id, session_id, created_at, last_sequence)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (workspace_id, principal_id, session_id) DO NOTHING`,
      scope.workspaceId,
      scope.principalId,
      scope.sessionId,
      new Date().toISOString(),
    );
  }
}

/** Factory for the opt-in event store; returns the concrete class for later tasks. */
export function createMemoryEventStore(options: MemoryEventStoreOptions = {}): MemoryEventStore {
  return new MemoryEventStore(options);
}

function rowToEnvelope(row: EventRow): MemoryEventEnvelopeV2 {
  const identity: MemoryIdentityV2 = {
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    runId: row.run_id,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
  };
  let outcome;
  if (row.outcome_json !== null) outcome = JSON.parse(row.outcome_json);
  let payload;
  if (row.payload_json !== null) payload = JSON.parse(row.payload_json);
  let evidenceRefs: readonly string[] = [];
  if (row.evidence_refs_json !== null) {
    const parsed = JSON.parse(row.evidence_refs_json);
    if (Array.isArray(parsed)) evidenceRefs = parsed as readonly string[];
  }
  const append: MemoryEventAppendV2 = {
    eventId: row.event_id,
    identity,
    runRef: row.run_ref,
    ...(row.step_ref !== null ? { stepRef: row.step_ref } : {}),
    kind: row.kind as MemoryEventKindV2,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  };
  return buildEventEnvelope(append, row.sequence, row.timestamp);
}

function rowToTombstone(row: TombstoneRow): MemoryTombstoneV2 {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    eventId: row.event_id,
    kind: row.kind as MemoryTombstoneV2["kind"],
    generation: row.generation,
    createdAt: row.created_at,
  };
}

async function safeRollback(db: Database): Promise<void> {
  try {
    await db.exec("ROLLBACK");
  } catch {
    // rollback is best-effort; the original error is already being surfaced
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
