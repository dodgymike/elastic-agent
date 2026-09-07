/**
 * Retention, forgetting, and safe export for the versioned event store (MI-13).
 *
 * `MemoryRetentionController` is the narrow local boundary for destructive and
 * export/restore operations. It never infers a deletion scope from free text:
 * every selection is an exact record, session, or workspace/principal request.
 * Preview and apply are separate steps, and the underlying store commits
 * tombstones plus a monotonic deletion generation before any authoritative row
 * is removed so interrupted deletions resume or report pending work without
 * resurrecting content.
 *
 * Local deletion limits (documented in docs/memory/MEMORY_RETENTION.md):
 *  - SQLite database pages, WAL/shm files, backups, previously written prompt
 *    logs, and already-sent provider requests have separate lifecycles and are
 *    outside this controller's scope;
 *  - forgetting is a local logical deletion plus tombstone, not forensic secure
 *    erasure or remote deletion.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertScopeMatches,
  scopeFromIdentity,
  scopesEqual,
  validateEventEnvelope,
  validateForgetSelection,
  validateScope,
  type MemoryEventEnvelopeV2,
  type MemoryForgetKindV2,
  type MemoryForgetResultV2,
  type MemoryForgetSelectionV2,
  type MemoryScopeV2,
  type MemoryTombstoneV2,
} from "./contracts-v2.js";
import type { MemoryEventStore } from "./event-store.js";
import { assertSafeMemoryStatePath, redactMemoryText, sanitizeMemoryJson } from "./privacy.js";
import {
  buildStructuredProjection,
  currentConstraints,
  openWork,
} from "./structured-records.js";

/** Version stamped into every exported memory document. */
export const MEMORY_EXPORT_SCHEMA_VERSION = 1 as const;

/** Default maximum accepted export file size for restore. */
export const DEFAULT_MAX_EXPORT_FILE_BYTES = 10_000_000;

const RETRIEVE_PAGE_SIZE = 500;

/** A redacted, versioned memory export with scope and provenance. */
export interface MemoryExportDocumentV1 {
  readonly schemaVersion: typeof MEMORY_EXPORT_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly scope: MemoryScopeV2;
  readonly deletionGeneration: number;
  readonly events: readonly MemoryEventEnvelopeV2[];
  readonly tombstones: readonly MemoryTombstoneV2[];
}

export interface MemoryExportOptions {
  /** Optional owner-only output file path (mode `0600`). */
  readonly filePath?: string;
}

export type MemoryExportResult =
  | {
      readonly status: "ok";
      readonly document: MemoryExportDocumentV1;
      readonly path?: string;
      readonly eventCount: number;
    }
  | { readonly status: "failure"; readonly reason: string };

export type MemoryRestoreResult =
  | {
      readonly status: "restored";
      readonly scope: MemoryScopeV2;
      readonly eventCount: number;
      readonly generation: number;
    }
  | { readonly status: "failure"; readonly reason: string };

/** Read-only preview of what a forget selection would delete. */
export interface MemoryForgetPreview {
  readonly kind: MemoryForgetKindV2;
  readonly wouldDelete: number;
  readonly scope?: MemoryScopeV2;
  readonly workspaceId?: string;
  readonly principalId?: string;
  readonly eventIds?: readonly string[];
}

/** Retention policy. All limits are optional and combine independently. */
export interface RetentionPolicy {
  /** Prune records strictly older than this many milliseconds. */
  readonly olderThanMs?: number;
  /** Prune a scope's oldest records until it has at most this many events. */
  readonly maxEventsPerScope?: number;
  /** Prune whole oldest scopes until at most this many scopes remain. */
  readonly maxScopes?: number;
  /** When false (default), scopes with constraints/open work are skipped. */
  readonly includeProtected?: boolean;
}

/** A single previewed retention deletion. */
export interface RetentionCandidate {
  readonly kind: "record" | "session";
  readonly scope: MemoryScopeV2;
  readonly eventIds?: readonly string[];
  readonly reason: string;
}

export interface RetentionPreview {
  readonly status: "ok" | "failure";
  readonly reason?: string;
  readonly policy: RetentionPolicy;
  readonly candidates: readonly RetentionCandidate[];
  readonly skippedProtected: number;
}

export type RetentionApplyStatusV2 = "applied" | "partial" | "failure";

export interface RetentionApplyResult {
  readonly status: RetentionApplyStatusV2;
  readonly applied: number;
  readonly failed: number;
  readonly errors: readonly string[];
}

/**
 * The narrow local boundary for retention/forget/export operations. Constructed
 * around the authoritative `MemoryEventStore`; it adds no new storage of its
 * own and performs every mutation through the store's transactional primitives.
 */
export class MemoryRetentionController {
  private readonly store: MemoryEventStore;
  private readonly now: () => number;

  constructor(store: MemoryEventStore, options: { readonly now?: () => number } = {}) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
  }

  /** Preview what `forget(selection)` would delete without mutating. */
  async previewForget(selection: MemoryForgetSelectionV2): Promise<MemoryForgetPreview> {
    const sel = validateForgetSelection(selection);
    if (sel.kind === "record") {
      let wouldDelete = 0;
      for (const eventId of sel.eventIds) {
        if (await this.store.eventExists(sel.scope, eventId)) wouldDelete += 1;
      }
      return { kind: sel.kind, wouldDelete, scope: sel.scope, eventIds: sel.eventIds };
    }
    if (sel.kind === "session") {
      const metadata = await this.store.sessionMetadata(sel.scope);
      return { kind: sel.kind, wouldDelete: metadata.event_count, scope: sel.scope };
    }
    const summaries = await this.store.scopeSummaries();
    const wouldDelete = summaries
      .filter((summary) => summary.scope.workspaceId === sel.workspaceId && summary.scope.principalId === sel.principalId)
      .reduce((total, summary) => total + summary.eventCount, 0);
    return { kind: sel.kind, wouldDelete, workspaceId: sel.workspaceId, principalId: sel.principalId };
  }

  /** Apply an exact forget selection through the authoritative store. */
  async forget(selection: MemoryForgetSelectionV2): Promise<MemoryForgetResultV2> {
    validateForgetSelection(selection);
    if (!this.store.capabilities.supportsForget) {
      return { status: "failure", reason: "store does not support forget" };
    }
    return this.store.forget(selection);
  }

  /**
   * Preview retention candidates without mutating. Protected scopes (those with
   * current authoritative constraints or open work) are skipped unless the
   * policy explicitly authorizes their inclusion.
   */
  async previewRetention(policy: RetentionPolicy): Promise<RetentionPreview> {
    try {
      const summaries = await this.store.scopeSummaries();
      const recordCandidates = new Map<string, RetentionCandidate>();
      const sessionCandidates = new Map<string, MemoryScopeV2>();
      let skippedProtected = 0;
      const includeProtected = policy.includeProtected === true;

      const ensureUnprotected = async (scope: MemoryScopeV2): Promise<boolean> => {
        if (includeProtected) return true;
        const protectedScope = await this.isProtectedScope(scope);
        if (protectedScope) skippedProtected += 1;
        return !protectedScope;
      };

      if (policy.olderThanMs !== undefined && policy.olderThanMs >= 0) {
        const cutoff = new Date(this.now() - policy.olderThanMs).toISOString();
        for (const summary of summaries) {
          if (!(await ensureUnprotected(summary.scope))) continue;
          const oldEvents = await this.store.eventsBefore(summary.scope, cutoff);
          this.addRecordCandidate(recordCandidates, summary.scope, oldEvents, "retention age");
        }
      }

      if (policy.maxEventsPerScope !== undefined && policy.maxEventsPerScope >= 0) {
        for (const summary of summaries) {
          if (summary.eventCount <= policy.maxEventsPerScope) continue;
          if (!(await ensureUnprotected(summary.scope))) continue;
          const excess = summary.eventCount - policy.maxEventsPerScope;
          const oldest = await this.store.oldestEvents(summary.scope, excess);
          this.addRecordCandidate(recordCandidates, summary.scope, oldest, "retention storage limit");
        }
      }

      if (policy.maxScopes !== undefined && policy.maxScopes >= 0) {
        const excessScopes = summaries.length - policy.maxScopes;
        for (let index = 0; index < excessScopes; index += 1) {
          const summary = summaries[index];
          if (!summary) continue;
          if (!(await ensureUnprotected(summary.scope))) continue;
          const key = scopeKey(summary.scope);
          sessionCandidates.set(key, summary.scope);
          recordCandidates.delete(key);
        }
      }

      const candidates: RetentionCandidate[] = [];
      for (const [key, scope] of sessionCandidates) {
        candidates.push({ kind: "session", scope, reason: "retention scope cap" });
      }
      for (const [key, candidate] of recordCandidates) {
        if (sessionCandidates.has(key)) continue;
        candidates.push(candidate);
      }

      return { status: "ok", policy, candidates, skippedProtected };
    } catch (error) {
      return {
        status: "failure",
        reason: redactMemoryText(describeError(error)),
        policy,
        candidates: [],
        skippedProtected: 0,
      };
    }
  }

  /** Apply a previously computed retention preview. */
  async applyRetention(preview: RetentionPreview): Promise<RetentionApplyResult> {
    if (preview.status !== "ok") {
      return {
        status: "failure",
        applied: 0,
        failed: 1,
        errors: [preview.reason ?? "invalid retention preview"],
      };
    }
    let applied = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const candidate of preview.candidates) {
      const result =
        candidate.kind === "record"
          ? await this.store.forget({ kind: "record", scope: candidate.scope, eventIds: candidate.eventIds ?? [] })
          : await this.store.forget({ kind: "session", scope: candidate.scope });
      if (result.status === "forgotten") {
        applied += 1;
      } else {
        failed += 1;
        errors.push(result.reason);
      }
    }
    const status = failed === 0 ? "applied" : applied > 0 ? "partial" : "failure";
    return { status, applied, failed, errors };
  }

  /** Build a redacted, versioned export for an exact scope, optionally to a file. */
  async exportScope(scope: MemoryScopeV2, options: MemoryExportOptions = {}): Promise<MemoryExportResult> {
    try {
      const target = validateScope(scope);
      if (!this.store.capabilities.supportsExport) {
        return { status: "failure", reason: "store does not support export" };
      }
      const events = await this.retrieveAll(target);
      if (!events) {
        return { status: "failure", reason: "retrieval degraded while exporting" };
      }
      const redactedEvents = events.map(redactEventPayload);
      const tombstones = await this.store.tombstones(target);
      const deletionGeneration = await this.store.deletionGeneration();
      const document: MemoryExportDocumentV1 = {
        schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        scope: target,
        deletionGeneration,
        events: redactedEvents,
        tombstones,
      };
      if (options.filePath !== undefined && options.filePath.length > 0) {
        const safePath = assertSafeMemoryStatePath(options.filePath);
        mkdirSync(dirname(safePath), { recursive: true, mode: 0o700 });
        writeFileSync(safePath, JSON.stringify(document, null, 2), { mode: 0o600 });
        return { status: "ok", document, path: safePath, eventCount: redactedEvents.length };
      }
      return { status: "ok", document, eventCount: redactedEvents.length };
    } catch (error) {
      return { status: "failure", reason: redactMemoryText(describeError(error)) };
    }
  }

  /**
   * Explicitly restore forgotten records from a validated export. This is the
   * only path that re-adds tombstoned content; ordinary imports still refuse it.
   * The export's scope must exactly match any explicit target scope.
   */
  async restoreExport(input: MemoryExportDocumentV1 | string, targetScope?: MemoryScopeV2): Promise<MemoryRestoreResult> {
    try {
      let documentValue: unknown;
      if (typeof input === "string") {
        const safePath = assertSafeMemoryStatePath(input);
        const raw = readFileSync(safePath);
        if (raw.length > DEFAULT_MAX_EXPORT_FILE_BYTES) {
          return {
            status: "failure",
            reason: `export file too large (${raw.length} bytes; limit ${DEFAULT_MAX_EXPORT_FILE_BYTES})`,
          };
        }
        documentValue = JSON.parse(raw.toString("utf8"));
      } else {
        documentValue = input;
      }
      const document = validateExportDocument(documentValue);
      if (targetScope !== undefined) {
        const scope = validateScope(targetScope);
        if (!scopesEqual(scope, document.scope)) {
          return { status: "failure", reason: "export scope does not match the explicit target scope" };
        }
      }
      const events = document.events.map(redactEventPayload);
      const restored = await this.store.restoreScope(document.scope, events);
      if (restored.status === "restored") {
        return {
          status: "restored",
          scope: restored.scope,
          eventCount: restored.eventCount,
          generation: restored.generation,
        };
      }
      return { status: "failure", reason: restored.reason };
    } catch (error) {
      return { status: "failure", reason: redactMemoryText(describeError(error)) };
    }
  }

  private addRecordCandidate(
    map: Map<string, RetentionCandidate>,
    scope: MemoryScopeV2,
    events: readonly MemoryEventEnvelopeV2[],
    reason: string,
  ): void {
    if (events.length === 0) return;
    const key = scopeKey(scope);
    const existing = map.get(key);
    const eventIds = [
      ...new Set([...(existing?.eventIds ?? []), ...events.map((event) => event.eventId)]),
    ];
    map.set(key, {
      kind: "record",
      scope,
      eventIds,
      reason: existing ? `${existing.reason}; ${reason}` : reason,
    });
  }

  private async isProtectedScope(scope: MemoryScopeV2): Promise<boolean> {
    const events = await this.retrieveAll(scope);
    if (!events) return true; // degraded retrieval: never prune uncertain scopes
    const projection = buildStructuredProjection(scope, events);
    return currentConstraints(projection).length > 0 || openWork(projection).length > 0;
  }

  private async retrieveAll(scope: MemoryScopeV2): Promise<readonly MemoryEventEnvelopeV2[] | null> {
    const events: MemoryEventEnvelopeV2[] = [];
    let afterSequence: number | undefined;
    while (true) {
      const page = await this.store.retrieve({
        scope,
        purpose: "replay",
        limit: RETRIEVE_PAGE_SIZE,
        ...(afterSequence !== undefined ? { afterSequence } : {}),
      });
      if (page.degraded) return null;
      events.push(...page.events);
      if (page.events.length < RETRIEVE_PAGE_SIZE) break;
      afterSequence = page.events[page.events.length - 1].sequence;
    }
    return events;
  }
}

function scopeKey(scope: MemoryScopeV2): string {
  return `${scope.workspaceId}\u0000${scope.principalId}\u0000${scope.sessionId}`;
}

function redactEventPayload(event: MemoryEventEnvelopeV2): MemoryEventEnvelopeV2 {
  if (event.payload === undefined) return event;
  return { ...event, payload: sanitizeMemoryJson(event.payload) };
}

function validateExportDocument(value: unknown): MemoryExportDocumentV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("export document must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== MEMORY_EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported export schema version ${String(record.schemaVersion)}; expected ${MEMORY_EXPORT_SCHEMA_VERSION}`,
    );
  }
  if (typeof record.exportedAt !== "string" || record.exportedAt.length === 0) {
    throw new Error("export document exportedAt must be a non-empty string");
  }
  const scope = validateScope(record.scope);
  if (
    typeof record.deletionGeneration !== "number" ||
    !Number.isInteger(record.deletionGeneration) ||
    record.deletionGeneration < 0
  ) {
    throw new Error("export document deletionGeneration must be a non-negative integer");
  }
  if (!Array.isArray(record.events)) {
    throw new Error("export document events must be an array");
  }
  const events = record.events.map((event) => {
    const envelope = validateEventEnvelope(event);
    assertScopeMatches(scope, scopeFromIdentity(envelope.identity), "export event scope");
    return envelope;
  });
  const tombstones = Array.isArray(record.tombstones)
    ? (record.tombstones as readonly MemoryTombstoneV2[])
    : [];
  return {
    schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
    exportedAt: record.exportedAt as string,
    scope,
    deletionGeneration: record.deletionGeneration as number,
    events,
    tombstones,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
