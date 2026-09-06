import { buildStructuredProjection, type StructuredRecordV2 } from "./structured-records.js";
import { retrieveRelevantRecords } from "./retrieval.js";
import type { SemanticQueryExpander } from "./semantic-query.js";
/**
 * Opt-in `persistent-v2` memory backend (MI-11).
 *
 * This module bridges the existing v1 `MemoryModule` runtime contract
 * (`remember`/`getContext`) to the durable, identity-scoped v2 event store
 * (`memory/event-store.ts`). It is the `persistent-v2` runtime choice that MI-11
 * introduces as an explicit opt-in; the rollout task (MI-16) later promotes a
 * verified candidate and migrates defaults.
 *
 * Honesty rules enforced here:
 *  - A `remember()` append is routed to the event store exactly once. Only a
 *    `durable` (or idempotent `duplicate`) append result is treated as success.
 *    `conflict`/`failure` results are recorded on `lastFailure` and are never
 *    reported as durable success, matching the v1 fail-open-but-honest recall
 *    contract.
 *  - `getContext()` retrieves the authoritative structured events (purpose
 *    `prompt-context`) and renders a deterministic text block. It never invents
 *    context from the legacy per-app summary path.
 *  - `finalize()` flushes the durable store; a flush failure throws so the
 *    caller can surface it, while normal `remember()` failures remain non-fatal.
 */

import { randomUUID } from "node:crypto";
import { PERSISTENT_V2_CAPABILITIES } from "./backend-capabilities.js";
import {
  canonicalizeWorkspacePath,
  deriveWorkspaceId,
  resolvePrincipalId,
  stableEventId,
  type MemoryCapabilitiesV2,
  type MemoryCloseResultV2,
  type MemoryEventAppendV2,
  type MemoryEventEnvelopeV2,
  type MemoryFlushResultV2,
  type MemoryForgetResultV2,
  type MemoryForgetSelectionV2,
  type MemoryInitResultV2,
  type MemoryOutcomeAssertionV2,
  type MemoryScopeV2,
} from "./contracts-v2.js";
import { EVENT_STORE_DB_VERSION, createMemoryEventStore, type MemoryEventStore } from "./event-store.js";
import { MemoryHealthMetrics, type MemoryHealthSnapshot } from "./health-metrics.js";
import {
  MemoryRetentionController,
  type MemoryExportDocumentV1,
  type MemoryExportOptions,
  type MemoryExportResult,
  type MemoryRestoreResult,
  type RetentionApplyResult,
  type RetentionPolicy,
  type RetentionPreview,
} from "./retention.js";
import type {
  ContextRequest,
  MemoryContext,
  MemoryContextResult,
  MemoryJsonObject,
  MemoryModule,
  MemoryModuleFactory,
  MemoryModuleFactoryOptions,
  MemoryOutcomeStatus,
  RememberInput,
} from "./types.js";

/** Failure report for the persistent-v2 bridge. */
export interface PersistentV2FailureReport {
  /** Non-empty message describing the first non-fatal failure. */
  message: string;
}

/** Options accepted by createPersistentV2MemoryModule / PersistentV2MemoryModule. */
export interface PersistentV2MemoryOptions extends MemoryModuleFactoryOptions {
  readonly semanticExpander?: SemanticQueryExpander;
  /** Injected v2 event store; defaults to a SQLite store at `eventStorePath`. */
  readonly store?: MemoryEventStore;
  /** Path to the dedicated SQLite event-store database file. */
  readonly eventStorePath?: string;
  /** Workspace path used to derive the authoritative workspace id. */
  readonly workspacePath?: string;
  /** Optional rendered-context character budget. */
  readonly maxChars?: number;
  /** Optional v1 delegate for additive prompt-context chaining. */
  readonly delegate?: MemoryModule;
}

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_RETRIEVE_LIMIT = 200;

/**
 * Durable v2 event store surfaced through the v1 `MemoryModule` contract.
 */
export class PersistentV2MemoryModule implements MemoryModule {
  /** Advertised v2 capabilities (durable appends, structured retrieval). */
  readonly capabilities: MemoryCapabilitiesV2 = PERSISTENT_V2_CAPABILITIES;

  private readonly store: MemoryEventStore;
  private readonly workspaceId: string;
  private readonly semanticExpander?: SemanticQueryExpander;
  private readonly runId: string;
  private readonly maxChars: number;
  private readonly delegate?: MemoryModule;
  private readonly sequenceBySession = new Map<string, number>();
  private retention: MemoryRetentionController | null = null;
  private readonly health: MemoryHealthMetrics;

  /** The most recent non-fatal failure reported by this module, if any. */
  lastFailure: PersistentV2FailureReport | null = null;

  constructor(options: PersistentV2MemoryOptions = {}) {
    this.store = options.store ?? createMemoryEventStore({ filePath: options.eventStorePath });
    this.workspaceId = deriveWorkspaceId(
      canonicalizeWorkspacePath(options.workspacePath ?? process.cwd()),
    );
    this.runId = `run-${randomUUID()}`;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.delegate = options.delegate;
    this.semanticExpander = options.semanticExpander;
    this.health = new MemoryHealthMetrics("persistent-v2", {
      durability: "durable",
      storageSchemaVersion: EVENT_STORE_DB_VERSION,
    });
  }

  /** The resolved event-store database path. */
  get path(): string {
    return this.store.path;
  }

  /** MI-14: metadata-only health snapshot for tests/monitoring and the CLI. */
  healthSnapshot(): MemoryHealthSnapshot {
    return this.health.snapshot();
  }

  /** v2 lifecycle passthrough: prepare a scope. */
  async initialize(scope: MemoryScopeV2): Promise<MemoryInitResultV2> {
    const result = await this.store.initialize(scope);
    this.health.recordInitialization(
      result.status === "ready",
      result.status === "failure" ? result.reason : undefined,
    );
    return result;
  }

  /** v2 lifecycle passthrough: flush durable state for a scope. */
  async flush(scope: MemoryScopeV2): Promise<MemoryFlushResultV2> {
    return this.store.flush(scope);
  }

  /** v2 lifecycle passthrough: close the store for a scope. */
  async close(scope: MemoryScopeV2): Promise<MemoryCloseResultV2> {
    return this.store.close(scope);
  }

  /**
   * Record one completed plan step as a single durable v2 event.
   *
   * Non-fatal by contract: a `conflict` or `failure` append result is recorded
   * on `lastFailure` and does not reject, so the plan loop can continue. Only
   * the durable store is authoritative; the optional v1 delegate (when present)
   * is a projection and receives the same input but is never a durability
   * claim.
   */
  async remember(input: RememberInput): Promise<void> {
    const scope = this.scopeFor(input.context.session_id, input.context.user_id);
    const event = this.toEvent(scope, input);
    const result = await this.store.append(scope, event);
    if (result.status === "durable" || result.status === "duplicate") {
      this.lastFailure = null;
    } else if (result.status === "conflict") {
      this.lastFailure = { message: `persistent-v2 append conflict: ${result.reason}` };
    } else {
      this.lastFailure = { message: `persistent-v2 append failed: ${result.reason}` };
    }
    this.health.recordAppend({
      status: result.status,
      sequence: result.status === "durable" ? result.sequence : undefined,
      sessionId: scope.sessionId,
      reason:
        result.status === "durable" || result.status === "duplicate"
          ? undefined
          : result.reason,
    });

    if (this.delegate) {
      try {
        await this.delegate.remember(input);
      } catch {
        // The delegate is a projection; its failure never affects the durable owner.
      }
    }
  }

  /**
   * Retrieve authoritative structured events for the requested session and
   * render a deterministic, budgeted text block for prompt injection.
   */
  async getContext(request: ContextRequest): Promise<MemoryContextResult> {
    const scope = this.scopeFor(request.session_id, request.user_id);
    try {
      const result = await this.store.retrieve({
        scope,
        purpose: "prompt-context",
        maxChars: request.queryText ? undefined : (request.maxChars ?? this.maxChars),
        limit: DEFAULT_RETRIEVE_LIMIT,
      });
      const events = result.events;
      if (result.degraded) throw new Error(result.degradedReason ?? "Memory recall degraded");
      if (request.queryText?.trim()) {
        let semanticTerms: readonly string[] = [];
        let semanticStatus: "disabled" | "expanded" | "fallback" = "disabled";
        if (this.semanticExpander && events.length > 0) {
          try { semanticTerms = await this.semanticExpander(request.queryText); semanticStatus = "expanded"; }
          catch { semanticStatus = "fallback"; }
        }
        const projection = buildStructuredProjection(scope, events);
        const covered = new Set(projection.records.flatMap((record) => [...record.sourceEventIds]));
        const records: StructuredRecordV2[] = [...projection.records];
        // Legacy outcome events have no structured hint: retain their useful
        // reasoning and findings as unverified narrative, never a user constraint.
        for (const event of events) {
          if (covered.has(event.eventId)) continue;
          const payload = event.payload as Record<string, unknown> | undefined;
          const subject = [payload?.reasoning, JSON.stringify(payload?.outcomeDetail ?? ""), ...(Array.isArray(payload?.actions) ? payload.actions : [])].filter(Boolean).join(" ");
          records.push({ id: event.eventId, kind: "fact", scope, subject: subject || event.kind, sourceEventIds: [event.eventId], evidence: event.outcome?.verification ?? "unverified", authoritative: false, createdAtSequence: event.sequence, updatedAtSequence: event.sequence, tags: [], status: "current", payload: event.payload });
        }
        const ranked = retrieveRelevantRecords(scope, records, { scope, queryText: request.queryText, semanticTerms, referencedFiles: request.queryText.split(/\s+/).map((term) => term.replace(/^[`"']|[`"',;:]$/g, "")).filter((term) => /[\/]|\.[a-z0-9]{1,8}$/i.test(term)) });
        if (ranked.status !== "ok") throw new Error(ranked.reason);
        let remaining = Math.max(0, request.maxChars ?? this.maxChars);
        const selected = ranked.items.filter((item) => {
          const size = renderRetrieved(item.record).length + 1;
          if (size > remaining) return false;
          remaining -= size; return true;
        });
        const selectedIds = new Set(selected.flatMap((item) => [...item.record.sourceEventIds]));
        this.health.recordRetrieval({ success: true, sessionId: scope.sessionId, cacheHit: false, candidates: events.length, selected: selected.length, omitted: ranked.items.length - selected.length, hasMemory: selected.length > 0 });
        return { text: selected.map((item) => renderRetrieved(item.record)).join("\n"), matchedContexts: events.filter((event) => selectedIds.has(event.eventId)).map(toMemoryContext), hasMemory: selected.length > 0, retrieval: { ...ranked, items: selected, semanticTerms, semanticStatus, omittedCount: ranked.items.length - selected.length } };
      }

      this.health.recordRetrieval({
        success: true,
        sessionId: scope.sessionId,
        cacheHit: false,
        candidates: events.length,
        selected: events.length,
        omitted: 0,
        hasMemory: events.length > 0,
      });
      let text = renderEvents(events);
      if (request.maxChars !== undefined && text.length > request.maxChars) {
        text = `${text.slice(0, request.maxChars)}…`;
      }
      return {
        text,
        matchedContexts: events.map(toMemoryContext),
        hasMemory: events.length > 0,
      };
    } catch (error) {
      const message = describeError(error);
      this.lastFailure = { message };
      this.health.recordRetrieval({
        success: false,
        sessionId: scope.sessionId,
        reason: message,
      });
      return { text: "", matchedContexts: [], hasMemory: false };
    }
  }

  /**
   * End-of-plan lifecycle: flush durable state for the session. A flush failure
   * throws (durability failure is not reported as success); the caller treats
   * this as non-fatal to plan completion, exactly like the legacy finalize.
   */
  async finalize(sessionId: string): Promise<unknown> {
    const scope = this.scopeFor(sessionId);
    const result = await this.store.flush(scope);
    if (result.status === "durable") {
      return `persistent-v2:${sessionId}:revision-${result.revision}`;
    }
    throw new Error(`persistent-v2 flush failed for session ${sessionId}: ${result.reason}`);
  }

  /** MI-13: apply an exact forget selection through the authoritative store. */
  async forget(selection: MemoryForgetSelectionV2): Promise<MemoryForgetResultV2> {
    return this.retentionController().forget(selection);
  }

  /** MI-13: the current monotonic deletion generation. */
  async deletionGeneration(): Promise<number> {
    return this.store.deletionGeneration();
  }

  /** MI-13: build a redacted, versioned export for an exact scope. */
  async exportScope(scope: MemoryScopeV2, options?: MemoryExportOptions): Promise<MemoryExportResult> {
    return this.retentionController().exportScope(scope, options);
  }

  /** MI-13: explicitly restore forgotten records from a validated export. */
  async restoreExport(input: MemoryExportDocumentV1 | string, targetScope?: MemoryScopeV2): Promise<MemoryRestoreResult> {
    return this.retentionController().restoreExport(input, targetScope);
  }

  /** MI-13: preview retention candidates without mutating. */
  async previewRetention(policy: RetentionPolicy): Promise<RetentionPreview> {
    return this.retentionController().previewRetention(policy);
  }

  /** MI-13: apply a previously computed retention preview. */
  async applyRetention(preview: RetentionPreview): Promise<RetentionApplyResult> {
    return this.retentionController().applyRetention(preview);
  }

  private retentionController(): MemoryRetentionController {
    if (!this.retention) {
      this.retention = new MemoryRetentionController(this.store);
    }
    return this.retention;
  }

  private scopeFor(sessionId: string, userId?: string): MemoryScopeV2 {
    return {
      workspaceId: this.workspaceId,
      principalId: resolvePrincipalId(this.workspaceId, userId),
      sessionId,
    };
  }

  private toEvent(scope: MemoryScopeV2, input: RememberInput): MemoryEventAppendV2 {
    const sequence = (this.sequenceBySession.get(scope.sessionId) ?? 0) + 1;
    this.sequenceBySession.set(scope.sessionId, sequence);
    const payload: MemoryJsonObject = {
      actions: input.actions.map((action) => action.name),
      outcomeDetail: input.outcomeDetail ?? null,
      reasoning: input.reasoning ?? null,
    };
    return {
      eventId: stableEventId(scope, `${this.runId}:step:${sequence}`),
      identity: { ...scope, runId: this.runId },
      runRef: this.runId,
      kind: "outcome",
      outcome: { asserted: toOutcomeAssertion(input.outcome), verification: "unverified" },
      payload,
      timestamp: input.timestamp,
    };
  }
}

/**
 * Dependency-injection factory for PersistentV2MemoryModule, satisfying
 * MemoryModuleFactory so the runtime can select `persistent-v2` through the
 * unified backend factory.
 */
export const createPersistentV2MemoryModule: MemoryModuleFactory = (
  options: PersistentV2MemoryOptions = {},
): MemoryModule => {
  return new PersistentV2MemoryModule(options);
};

// ------------------------------------------------------------------ *
// Helpers
// ------------------------------------------------------------------ *

/** Map the v1 outcome vocabulary onto the v2 assertion vocabulary. */
function toOutcomeAssertion(outcome: MemoryOutcomeStatus): MemoryOutcomeAssertionV2 {
  if (outcome === "completed" || outcome === "failed" || outcome === "aborted" || outcome === "skipped") {
    return outcome;
  }
  return "unknown";
}

/** Deterministic, non-lossy-claiming renderer for retrieved v2 events. */
function renderEvents(events: readonly MemoryEventEnvelopeV2[]): string {
  if (events.length === 0) return "";
  const sessionId = events[0].identity.sessionId;
  const lines = events.map((event) => {
    const payload = event.payload as MemoryJsonObject | undefined;
    const actions =
      Array.isArray(payload?.actions) && (payload.actions as readonly string[]).length > 0
        ? (payload.actions as readonly string[]).join(", ")
        : event.kind;
    const asserted = event.outcome?.asserted ?? "unknown";
    return `[${event.sequence}] ${asserted}: ${actions}`;
  });
  return `Session ${sessionId} memory:\n${lines.join("\n")}`;
}

/** Convert a stored envelope into a v1 provenance context. */
function toMemoryContext(event: MemoryEventEnvelopeV2): MemoryContext {
  return {
    session_id: event.identity.sessionId,
    user_id: event.identity.principalId,
    context: {
      workspaceId: event.identity.workspaceId,
      runId: event.identity.runId,
      eventId: event.eventId,
    },
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

function renderRetrieved(record: StructuredRecordV2): string {
  return `[${record.kind}/${record.authoritative ? "user-constraint" : record.evidence}] ${record.subject} (source ${record.sourceEventIds.join(", ")})`;
}
