/**
 * Structured facts/decisions/constraints/open-work projection (MI-06).
 *
 * A deterministic, rebuildable projection over committed events. It keeps
 * exact user constraints and unresolved task IDs in a protected map, handles
 * supersession and retraction explicitly, and never lets an unsupported model
 * claim overwrite an explicit user constraint or a verified observation.
 *
 * The projection is derived data: committed sanitized events remain the source
 * of truth and can rebuild this view after extractor/policy changes.
 */

import {
  stableEventId,
  type MemoryEventEnvelopeV2,
  type MemoryScopeV2,
  type MemoryVerificationLevelV2,
} from "./contracts-v2.js";

export const STRUCTURED_PROJECTION_POLICY_VERSION = 1 as const;

export type StructuredRecordKindV2 =
  | "fact"
  | "decision"
  | "constraint"
  | "open-task"
  | "failure"
  | "artifact";

export type StructuredRecordStatusV2 = "current" | "superseded" | "retracted";

export interface StructuredRecordV2 {
  readonly id: string;
  readonly kind: StructuredRecordKindV2;
  readonly scope: MemoryScopeV2;
  /** Normalized subject key used for contradiction/supersession handling. */
  readonly subject: string;
  /** Retained source event IDs this record was extracted from. */
  readonly sourceEventIds: readonly string[];
  /** Evidence strength (never upgraded by unsupported claims). */
  readonly evidence: MemoryVerificationLevelV2;
  /** True only for explicit user-authorized constraints. */
  readonly authoritative: boolean;
  readonly createdAtSequence: number;
  readonly updatedAtSequence: number;
  readonly tags: readonly string[];
  readonly status: StructuredRecordStatusV2;
  readonly supersedes?: readonly string[];
  readonly supersededBy?: string;
  readonly payload?: unknown;
}

export interface StructuredProjection {
  readonly policyVersion: typeof STRUCTURED_PROJECTION_POLICY_VERSION;
  /** Highest event sequence folded into this projection. */
  readonly cursor: number;
  readonly records: readonly StructuredRecordV2[];
  readonly byId: ReadonlyMap<string, StructuredRecordV2>;
  /** Current authoritative constraints keyed by subject. */
  readonly constraints: ReadonlyMap<string, StructuredRecordV2>;
  /** Current open tasks keyed by task id/subject. */
  readonly openTasks: ReadonlyMap<string, StructuredRecordV2>;
}

interface StructuredHint {
  readonly recordKind?: string;
  readonly subject?: string;
  readonly tags?: readonly string[];
  readonly authoritative?: boolean;
  readonly retracted?: boolean;
  readonly supersedes?: readonly string[];
}

function asHint(payload: unknown): StructuredHint | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const structured = (payload as Record<string, unknown>).structured;
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) return undefined;
  return structured as StructuredHint;
}

function kindFromEvent(event: MemoryEventEnvelopeV2, hint?: StructuredHint): StructuredRecordKindV2 | undefined {
  if (hint?.recordKind !== undefined) {
    const kinds = new Set<StructuredRecordKindV2>(["fact", "decision", "constraint", "open-task", "failure", "artifact"]);
    return kinds.has(hint.recordKind as StructuredRecordKindV2) ? (hint.recordKind as StructuredRecordKindV2) : undefined;
  }
  switch (event.kind) {
    case "fact":
      return "fact";
    case "decision":
      return "decision";
    case "constraint":
      return "constraint";
    case "checkpoint":
      if (event.outcome?.asserted === "failed" || event.outcome?.asserted === "blocked") return "failure";
      return undefined;
    default:
      return undefined;
  }
}

function subjectFor(event: MemoryEventEnvelopeV2, kind: StructuredRecordKindV2, hint?: StructuredHint): string {
  if (hint?.subject !== undefined && String(hint.subject).length > 0) return String(hint.subject);
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.text === "string") return payload.text;
  if (payload && typeof payload.subject === "string") return payload.subject;
  if (payload && typeof payload.title === "string") return payload.title;
  if (event.stepRef !== undefined) return event.stepRef;
  return `${kind}:${event.eventId}`;
}

/**
 * Deterministically extract structured records from committed events.
 * Replaying the same event history yields the same logical records.
 */
export function extractStructuredRecords(
  scope: MemoryScopeV2,
  events: readonly MemoryEventEnvelopeV2[],
): StructuredRecordV2[] {
  const records: StructuredRecordV2[] = [];
  for (const event of events) {
    const hint = asHint(event.payload);
    const kind = kindFromEvent(event, hint);
    if (kind !== undefined) {
      records.push(makeRecord(scope, event, kind, subjectFor(event, kind, hint), hint));
    }
    // Open tasks / artifact references carried as structured payload arrays.
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && Array.isArray(payload.openTasks)) {
      for (let i = 0; i < payload.openTasks.length; i += 1) {
        const item = payload.openTasks[i];
        const text = typeof item === "string" ? item : item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? i) : String(i);
        records.push(makeRecord(scope, event, "open-task", text, { subject: text, tags: [] }, `${event.eventId}:open:${i}`));
      }
    }
    if (payload && payload.artifact !== undefined) {
      const artifactText = typeof payload.artifact === "string" ? payload.artifact : String(payload.artifact);
      records.push(makeRecord(scope, event, "artifact", artifactText, { subject: artifactText, tags: [] }, `${event.eventId}:artifact`));
    }
  }
  return records;
}

function makeRecord(
  scope: MemoryScopeV2,
  event: MemoryEventEnvelopeV2,
  kind: StructuredRecordKindV2,
  subject: string,
  hint?: StructuredHint,
  idSuffix?: string,
): StructuredRecordV2 {
  const id = stableEventId(scope, `structured:${kind}:${event.eventId}${idSuffix ?? ""}`);
  const evidence = event.outcome?.verification ?? "unverified";
  const authoritative = kind === "constraint" && hint?.authoritative === true;
  return {
    id,
    kind,
    scope,
    subject,
    sourceEventIds: [event.eventId],
    evidence,
    authoritative,
    createdAtSequence: event.sequence,
    updatedAtSequence: event.sequence,
    tags: hint?.tags ?? [],
    status: hint?.retracted === true ? "retracted" : "current",
    ...(hint?.supersedes !== undefined ? { supersedes: hint.supersedes } : {}),
    payload: event.payload,
  };
}

/**
 * Fold extracted records into a projection. Idempotent by record id; applies
 * supersession/retraction and protects authoritative constraints.
 */
export function buildStructuredProjection(
  scope: MemoryScopeV2,
  events: readonly MemoryEventEnvelopeV2[],
  previous: StructuredProjection = emptyProjection(),
): StructuredProjection {
  const records = extractStructuredRecords(scope, events);
  const byId = new Map(previous.byId);
  const constraints = new Map(previous.constraints);
  const openTasks = new Map(previous.openTasks);
  let cursor = previous.cursor;

  for (const record of records) {
    cursor = Math.max(cursor, record.createdAtSequence);
    if (byId.has(record.id)) continue;

    // Apply explicit supersession links to already-known records.
    const supersedes = record.supersedes ?? [];
    for (const targetId of supersedes) {
      const target = byId.get(targetId);
      if (target && target.status === "current") {
        byId.set(targetId, { ...target, status: "superseded", supersededBy: record.id, updatedAtSequence: record.createdAtSequence });
      }
    }

    byId.set(record.id, record);

    if (record.kind === "constraint") {
      // Only explicit user-authorized constraints enter the protected
      // projection; unsupported claims stay in `records` for audit but can
      // never overwrite an authoritative constraint.
      if (!record.authoritative) continue;
      const existing = constraints.get(record.subject);
      if (existing && existing.authoritative && existing.updatedAtSequence >= record.updatedAtSequence) {
        continue;
      }
      if (record.status === "current") constraints.set(record.subject, record);
    }
    if (record.kind === "open-task") {
      if (record.status === "current") openTasks.set(record.subject, record);
    }
  }

  // Ensure the protected maps reflect superseded/retracted entries.
  for (const [subject, record] of constraints) {
    if (record.status !== "current") constraints.delete(subject);
  }
  for (const [subject, record] of openTasks) {
    if (record.status !== "current") openTasks.delete(subject);
  }

  return {
    policyVersion: STRUCTURED_PROJECTION_POLICY_VERSION,
    cursor,
    records: [...byId.values()],
    byId,
    constraints,
    openTasks,
  };
}

export function emptyProjection(): StructuredProjection {
  return {
    policyVersion: STRUCTURED_PROJECTION_POLICY_VERSION,
    cursor: 0,
    records: [],
    byId: new Map(),
    constraints: new Map(),
    openTasks: new Map(),
  };
}

/** Current authoritative constraints (exact user constraints). */
export function currentConstraints(projection: StructuredProjection): readonly StructuredRecordV2[] {
  return [...projection.constraints.values()];
}

/** Current open work references. */
export function openWork(projection: StructuredProjection): readonly StructuredRecordV2[] {
  return [...projection.openTasks.values()];
}

/** Current decisions (status current). */
export function currentDecisions(projection: StructuredProjection): readonly StructuredRecordV2[] {
  return projection.records.filter((record) => record.kind === "decision" && record.status === "current");
}

/** Evidence-backed facts (verified and current). */
export function evidenceBackedFacts(projection: StructuredProjection): readonly StructuredRecordV2[] {
  return projection.records.filter(
    (record) => record.kind === "fact" && record.status === "current" && record.evidence === "verified",
  );
}

/** All current facts, including visibly unverified/legacy ones. */
export function currentFacts(projection: StructuredProjection): readonly StructuredRecordV2[] {
  return projection.records.filter((record) => record.kind === "fact" && record.status === "current");
}
