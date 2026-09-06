/**
 * Versioned memory contracts and identity boundaries (MI-01).
 *
 * This module is the forward contract for the memory-reliability workstream.
 * It is deliberately additive: the existing transport-agnostic `MemoryModule`
 * contract in `memory/types.ts` stays untouched so current consumers keep
 * compiling until they are explicitly migrated. The new surface lives here so
 * the durable event store (MI-03) and its callers can depend on one identity
 * and event envelope definition instead of re-encoding a session.
 *
 * Design decisions (see docs/MEMORY_V2_CONTRACT.md):
 *  - Identity is workspace + principal + session, with run/task/event IDs kept
 *    distinct. A task ID never stands in for a principal.
 *  - Workspaces are canonicalized once (resolved real path when available) and
 *    isolated by default. Sharing requires an explicit stable workspace
 *    mapping; it is never inferred from equal directory basenames.
 *  - Events are versioned envelopes with a positive per-session sequence.
 *    Timestamps are descriptive metadata, never ordering or uniqueness keys.
 *  - Appends report durable success, duplicate, conflict, or failure. A
 *    successful `void` return from a legacy backend must not be presented as a
 *    durable write.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import type { MemoryJsonObject, MemoryJsonValue } from "./types.js";

/** Current event envelope schema version. Parsing any other version fails. */
export const MEMORY_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * Controlled event kinds for the versioned event envelope. Keep this set small
 * and extensible through an explicit schema-version bump, not ad hoc strings.
 */
export type MemoryEventKindV2 =
  | "observation"
  | "outcome"
  | "checkpoint"
  | "decision"
  | "fact"
  | "constraint";

/** What the caller asserts happened. Mirrors the v1 outcome vocabulary. */
export type MemoryOutcomeAssertionV2 =
  | "completed"
  | "failed"
  | "aborted"
  | "skipped"
  | "unknown";

/**
 * How strongly the asserted outcome is supported. Separating assertion from
 * verification means a model-generated claim can be stored while still being
 * recorded as unverified rather than silently treated as fact.
 */
export type MemoryVerificationLevelV2 = "unverified" | "verified" | "refuted";

/** An asserted outcome plus its evidence-backed verification level. */
export interface MemoryOutcomeV2 {
  /** What the step/event claims happened. */
  readonly asserted: MemoryOutcomeAssertionV2;
  /** How strongly that claim is supported by evidence. */
  readonly verification: MemoryVerificationLevelV2;
}

/**
 * The immutable scope that gates every store access. All three fields are
 * required; there is deliberately no fallback to another user or workspace.
 */
export interface MemoryScopeV2 {
  /** Canonical workspace identifier (derived from the canonical path). */
  readonly workspaceId: string;
  /** Principal identifier. Never a task ID or a credential-derived value. */
  readonly principalId: string;
  /** Conversation/session identifier scoped to the workspace + principal. */
  readonly sessionId: string;
}

/**
 * Full identity carried on an event. Extends the store-access scope with the
 * run and optional task so retries and provenance remain distinguishable.
 */
export interface MemoryIdentityV2 extends MemoryScopeV2 {
  /** Identifier of the run (execution attempt) the event belongs to. */
  readonly runId: string;
  /** Optional task ID. Informational only; never an ownership key. */
  readonly taskId?: string;
}

/**
 * An event submitted for append. It has no sequence or schema version: the
 * store stamps those when the event is durably accepted and returns an
 * envelope. `eventId` is assigned by the caller so retries of the same
 * semantic event reuse the same ID while distinct attempts get different IDs.
 */
export interface MemoryEventAppendV2 {
  /** Stable, caller-assigned semantic event ID (see `stableEventId`). */
  readonly eventId: string;
  /** Full identity (workspace, principal, session, run, task). */
  readonly identity: MemoryIdentityV2;
  /** Run reference for provenance. Usually the identity's `runId`. */
  readonly runRef: string;
  /** Optional step reference (e.g. a zero-based plan step index). */
  readonly stepRef?: string;
  /** Descriptive ISO-8601 timestamp. Not an ordering or uniqueness key. */
  readonly timestamp?: string;
  /** Controlled event kind. */
  readonly kind: MemoryEventKindV2;
  /** Asserted outcome and verification level, when the event has one. */
  readonly outcome?: MemoryOutcomeV2;
  /** Opaque JSON-safe payload. */
  readonly payload?: MemoryJsonValue;
  /** Event IDs this event is derived from or supported by. */
  readonly evidenceRefs?: readonly string[];
}

/**
 * A durably stored event. The store stamps `schemaVersion`, a positive
 * per-session `sequence`, and a required `timestamp` when it accepts the
 * append input. Defined separately from `MemoryEventAppendV2` because an
 * interface cannot make an optional inherited property required via `extends`.
 */
export interface MemoryEventEnvelopeV2 {
  /** Schema version of this envelope. Always the current supported version. */
  readonly schemaVersion: typeof MEMORY_EVENT_SCHEMA_VERSION;
  /** Positive, per-session, monotonically increasing sequence number. */
  readonly sequence: number;
  /** Stable, caller-assigned semantic event ID (see `stableEventId`). */
  readonly eventId: string;
  /** Full identity (workspace, principal, session, run, task). */
  readonly identity: MemoryIdentityV2;
  /** Run reference for provenance. Usually the identity's `runId`. */
  readonly runRef: string;
  /** Optional step reference (e.g. a zero-based plan step index). */
  readonly stepRef?: string;
  /** Descriptive timestamp; always present on a stored envelope. */
  readonly timestamp: string;
  /** Controlled event kind. */
  readonly kind: MemoryEventKindV2;
  /** Asserted outcome and verification level, when the event has one. */
  readonly outcome?: MemoryOutcomeV2;
  /** Opaque JSON-safe payload. */
  readonly payload?: MemoryJsonValue;
  /** Evidence references; normalized to an array on stored envelopes. */
  readonly evidenceRefs: readonly string[];
}

/** Result of initializing a store scope. */
export type MemoryInitResultV2 =
  | { readonly status: "ready"; readonly scope: MemoryScopeV2 }
  | { readonly status: "failure"; readonly reason: string };

/**
 * Result of an append. Exactly four states exist on purpose:
 *  - `durable`: the event was accepted and persistence is established.
 *  - `duplicate`: an event with this ID already exists with identical content.
 *  - `conflict`: an event with this ID exists but has different content.
 *  - `failure`: the event could not be durably written (including the honest
 *    case where a legacy backend cannot establish durability).
 */
export type MemoryAppendResultV2 =
  | { readonly status: "durable"; readonly eventId: string; readonly sequence: number }
  | { readonly status: "duplicate"; readonly eventId: string }
  | { readonly status: "conflict"; readonly eventId: string; readonly reason: string }
  | { readonly status: "failure"; readonly reason: string };

/** Result of flushing a store scope. */
export type MemoryFlushResultV2 =
  | { readonly status: "durable"; readonly revision: number }
  | { readonly status: "failure"; readonly reason: string };

/** Result of closing a store scope. */
export type MemoryCloseResultV2 =
  | { readonly status: "closed" }
  | { readonly status: "failure"; readonly reason: string };

/** Why retrieval is happening; used to shape what is returned. */
export type MemoryRetrievalPurposeV2 = "prompt-context" | "replay" | "audit" | "export";

/** Retrieval request. Scope is required and immutable for the call. */
export interface MemoryRetrieveRequestV2 {
  /** Immutable scope the retrieval is confined to. */
  readonly scope: MemoryScopeV2;
  /** Purpose of the retrieval. */
  readonly purpose: MemoryRetrievalPurposeV2;
  /** Optional rendered-context character budget. */
  readonly maxChars?: number;
  /** Optional free-form hints. */
  readonly hints?: MemoryJsonObject;
  /** Optional cancellation signal honored between await points. */
  readonly signal?: AbortSignal;
}

/** Retrieval result. Reports its scope, revision, evidence, and degraded state. */
export interface MemoryRetrieveResultV2 {
  /** The scope actually retrieved (must equal the requested scope). */
  readonly scope: MemoryScopeV2;
  /** Store revision the retrieval reflects. */
  readonly revision: number;
  /** Events in the requested scope, oldest first. */
  readonly events: readonly MemoryEventEnvelopeV2[];
  /** Evidence event IDs relevant to the request. */
  readonly evidenceRefs: readonly string[];
  /** True when the result is incomplete or durability is degraded. */
  readonly degraded: boolean;
  /** Why the result is degraded, when it is. */
  readonly degradedReason?: string;
  /** Optional pre-rendered context text (e.g. from a legacy adapter). */
  readonly text?: string;
}

/** Advertised backend capabilities used by later tasks (MI-11). */
export interface MemoryCapabilitiesV2 {
  /** True when appends are durably persisted. */
  readonly durable: boolean;
  /** Retrieval purposes the backend can serve. */
  readonly retrievalPurposes: readonly MemoryRetrievalPurposeV2[];
  /** True when the backend supports derived-summary compaction. */
  readonly supportsCompaction: boolean;
  /** True when the backend supports forgetting/deleting stored data. */
  readonly supportsForget: boolean;
  /** True when the backend supports safe export. */
  readonly supportsExport: boolean;
}

/**
 * Lifecycle and capability interface for the new implementation. Old v1
 * backends are not required to implement persistence; they can be surfaced
 * through `LegacyMemoryModuleAdapter` in `memory/legacy-compat.ts` until the
 * rollout task (MI-16) migrates the default selection.
 */
export interface MemoryModuleV2 {
  /** Static capability advertisement, read before any lifecycle call. */
  readonly capabilities: MemoryCapabilitiesV2;
  /** Prepare the scope for access. A scope is required before any call. */
  initialize(scope: MemoryScopeV2): Promise<MemoryInitResultV2>;
  /** Append one versioned event under an immutable scope. */
  append(scope: MemoryScopeV2, event: MemoryEventAppendV2): Promise<MemoryAppendResultV2>;
  /** Retrieve events/evidence confined to a requested scope. */
  retrieve(request: MemoryRetrieveRequestV2): Promise<MemoryRetrieveResultV2>;
  /** Flush pending durable state for a scope. */
  flush(scope: MemoryScopeV2): Promise<MemoryFlushResultV2>;
  /** Close a scope and release its resources. */
  close(scope: MemoryScopeV2): Promise<MemoryCloseResultV2>;
}

const EVENT_KINDS: ReadonlySet<string> = new Set<MemoryEventKindV2>([
  "observation",
  "outcome",
  "checkpoint",
  "decision",
  "fact",
  "constraint",
]);

const OUTCOME_ASSERTIONS: ReadonlySet<string> = new Set<MemoryOutcomeAssertionV2>([
  "completed",
  "failed",
  "aborted",
  "skipped",
  "unknown",
]);

const VERIFICATION_LEVELS: ReadonlySet<string> = new Set<MemoryVerificationLevelV2>([
  "unverified",
  "verified",
  "refuted",
]);

const RETRIEVAL_PURPOSES: ReadonlySet<string> = new Set<MemoryRetrievalPurposeV2>([
  "prompt-context",
  "replay",
  "audit",
  "export",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function reject(message: string): never {
  throw new Error(message);
}

/** True when a value is safe to serialize as JSON (no bigint/cycles/undefined). */
export function isJsonSafe(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an unknown value as an immutable `MemoryScopeV2`. Missing fields and
 * invalid shapes are rejected; there is deliberately no fallback to another
 * user or workspace.
 */
export function validateScope(value: unknown): MemoryScopeV2 {
  const record = asRecord(value);
  if (!record) reject("scope must be an object");
  const { workspaceId, principalId, sessionId } = record as Partial<MemoryScopeV2>;
  if (!isNonEmptyString(workspaceId)) reject("scope.workspaceId must be a non-empty string");
  if (!isNonEmptyString(principalId)) reject("scope.principalId must be a non-empty string");
  if (!isNonEmptyString(sessionId)) reject("scope.sessionId must be a non-empty string");
  return { workspaceId, principalId, sessionId };
}

/** Validate an unknown value as a full event identity. */
export function validateIdentity(value: unknown): MemoryIdentityV2 {
  const record = asRecord(value);
  if (!record) reject("identity must be an object");
  const scope = validateScope({
    workspaceId: record.workspaceId,
    principalId: record.principalId,
    sessionId: record.sessionId,
  });
  if (!isNonEmptyString(record.runId)) reject("identity.runId must be a non-empty string");
  const taskId = record.taskId;
  if (taskId !== undefined && !isNonEmptyString(taskId)) {
    reject("identity.taskId must be a non-empty string when present");
  }
  return {
    ...scope,
    runId: record.runId as string,
    ...(taskId !== undefined ? { taskId: taskId as string } : {}),
  };
}

/** The store-access scope for an identity: workspace + principal + session. */
export function scopeFromIdentity(identity: MemoryIdentityV2): MemoryScopeV2 {
  return {
    workspaceId: identity.workspaceId,
    principalId: identity.principalId,
    sessionId: identity.sessionId,
  };
}

/** True when two scopes are exactly equal (all three fields). */
export function scopesEqual(a: MemoryScopeV2, b: MemoryScopeV2): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.principalId === b.principalId &&
    a.sessionId === b.sessionId
  );
}

/**
 * Require that a candidate scope exactly matches the required scope. Used by
 * stores before access so a mismatched scope can never fall back to another
 * user or workspace.
 */
export function assertScopeMatches(
  required: MemoryScopeV2,
  candidate: MemoryScopeV2,
  label = "scope",
): void {
  if (!scopesEqual(required, candidate)) {
    reject(
      `${label} mismatch: expected workspace=${required.workspaceId} principal=${required.principalId} session=${required.sessionId}, got workspace=${candidate.workspaceId} principal=${candidate.principalId} session=${candidate.sessionId}`,
    );
  }
}

/** Validate an outcome object against the controlled vocabularies. */
export function validateOutcome(value: unknown): MemoryOutcomeV2 | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) reject("outcome must be an object when present");
  const { asserted, verification } = record as Partial<MemoryOutcomeV2>;
  if (!isNonEmptyString(asserted) || !OUTCOME_ASSERTIONS.has(asserted)) {
    reject(`outcome.asserted must be one of: ${[...OUTCOME_ASSERTIONS].join(", ")}`);
  }
  if (!isNonEmptyString(verification) || !VERIFICATION_LEVELS.has(verification)) {
    reject(`outcome.verification must be one of: ${[...VERIFICATION_LEVELS].join(", ")}`);
  }
  return { asserted: asserted as MemoryOutcomeAssertionV2, verification: verification as MemoryVerificationLevelV2 };
}

/** Validate an append input (event without sequence/schema stamp). */
export function validateEventAppend(value: unknown): MemoryEventAppendV2 {
  const record = asRecord(value);
  if (!record) reject("event must be an object");
  if (!isNonEmptyString(record.eventId)) reject("event.eventId must be a non-empty string");
  const identity = validateIdentity(record.identity);
  if (!isNonEmptyString(record.runRef)) reject("event.runRef must be a non-empty string");
  const stepRef = record.stepRef;
  if (stepRef !== undefined && !isNonEmptyString(stepRef)) {
    reject("event.stepRef must be a non-empty string when present");
  }
  const timestamp = record.timestamp;
  if (timestamp !== undefined && !isNonEmptyString(timestamp)) {
    reject("event.timestamp must be a non-empty string when present");
  }
  const kind = record.kind;
  if (!isNonEmptyString(kind) || !EVENT_KINDS.has(kind)) {
    reject(`event.kind must be one of: ${[...EVENT_KINDS].join(", ")}`);
  }
  const outcome = validateOutcome(record.outcome);
  if (record.payload !== undefined && !isJsonSafe(record.payload)) {
    reject("event.payload must be JSON-safe");
  }
  const evidenceRefs = record.evidenceRefs;
  if (evidenceRefs !== undefined) {
    if (!Array.isArray(evidenceRefs) || evidenceRefs.some((ref) => !isNonEmptyString(ref))) {
      reject("event.evidenceRefs must be an array of non-empty strings when present");
    }
  }
  return {
    eventId: record.eventId as string,
    identity,
    runRef: record.runRef as string,
    ...(stepRef !== undefined ? { stepRef: stepRef as string } : {}),
    ...(timestamp !== undefined ? { timestamp: timestamp as string } : {}),
    kind: kind as MemoryEventKindV2,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(record.payload !== undefined ? { payload: record.payload as MemoryJsonValue } : {}),
    ...(evidenceRefs !== undefined ? { evidenceRefs: evidenceRefs as readonly string[] } : {}),
  };
}

/**
 * Validate a stored envelope. Rejects unsupported schema versions, invalid
 * kinds, missing identity, and invalid (non-positive/non-integer) sequence
 * values so a parsed envelope can never be silently reinterpreted.
 */
export function validateEventEnvelope(value: unknown): MemoryEventEnvelopeV2 {
  const record = asRecord(value);
  if (!record) reject("envelope must be an object");
  if (record.schemaVersion !== MEMORY_EVENT_SCHEMA_VERSION) {
    reject(
      `unsupported schema version ${String(record.schemaVersion)}; expected ${MEMORY_EVENT_SCHEMA_VERSION}`,
    );
  }
  const sequence = record.sequence;
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence <= 0) {
    reject("envelope.sequence must be a positive integer");
  }
  if (!isNonEmptyString(record.timestamp)) {
    reject("envelope.timestamp must be a non-empty string");
  }
  const append = validateEventAppend(record);
  return {
    ...append,
    schemaVersion: MEMORY_EVENT_SCHEMA_VERSION,
    sequence,
    timestamp: record.timestamp as string,
    evidenceRefs: append.evidenceRefs ?? [],
  };
}

/** Validate a retrieval purpose against the controlled vocabulary. */
export function validateRetrievalPurpose(value: unknown): MemoryRetrievalPurposeV2 {
  if (!isNonEmptyString(value) || !RETRIEVAL_PURPOSES.has(value)) {
    reject(`retrieval purpose must be one of: ${[...RETRIEVAL_PURPOSES].join(", ")}`);
  }
  return value as MemoryRetrievalPurposeV2;
}

/** Serialize a validated envelope to JSON. */
export function serializeEventEnvelope(envelope: MemoryEventEnvelopeV2): string {
  validateEventEnvelope(envelope);
  return JSON.stringify(envelope);
}

/** Parse and validate an envelope from JSON. */
export function parseEventEnvelope(json: string): MemoryEventEnvelopeV2 {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    reject(`event envelope is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateEventEnvelope(value);
}

/** Stamp sequence/schema/timestamp onto a validated append input. */
export function buildEventEnvelope(
  event: MemoryEventAppendV2,
  sequence: number,
  timestamp: string = new Date().toISOString(),
): MemoryEventEnvelopeV2 {
  const append = validateEventAppend(event);
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence <= 0) {
    reject("sequence must be a positive integer");
  }
  if (!isNonEmptyString(timestamp)) reject("timestamp must be a non-empty string");
  return {
    ...append,
    schemaVersion: MEMORY_EVENT_SCHEMA_VERSION,
    sequence,
    timestamp,
    evidenceRefs: append.evidenceRefs ?? [],
  };
}

/**
 * Canonicalize a workspace location once. Uses the resolved real path when the
 * directory exists (so symlinked workspaces converge) and falls back to a
 * normalized absolute path otherwise. Equal basenames in different parents
 * canonicalize to different values; sharing is never inferred from a basename.
 */
export function canonicalizeWorkspacePath(workspacePath: string): string {
  if (!isNonEmptyString(workspacePath)) reject("workspace path must be a non-empty string");
  const absolute = isAbsolute(workspacePath) ? workspacePath : resolve(workspacePath);
  try {
    return realpathSync(absolute);
  } catch {
    return normalize(absolute);
  }
}

function stableHash(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/**
 * Derive a stable workspace ID from a canonical workspace path. The same
 * canonical location always yields the same ID; different locations yield
 * different IDs regardless of basename.
 */
export function deriveWorkspaceId(canonicalPath: string): string {
  return `ws-${stableHash([canonicalPath]).slice(0, 32)}`;
}

/**
 * Resolve the explicit local principal used when no authenticated principal
 * exists. It is derived from the workspace ID only — never from credentials,
 * environment secrets, or task IDs.
 */
export function resolveLocalPrincipalId(workspaceId: string): string {
  if (!isNonEmptyString(workspaceId)) reject("workspaceId must be a non-empty string");
  return `local:${workspaceId}`;
}

/**
 * Resolve a principal ID: the authenticated value when present, otherwise the
 * explicit workspace-scoped local principal.
 */
export function resolvePrincipalId(
  workspaceId: string,
  authenticatedPrincipalId?: string,
): string {
  if (authenticatedPrincipalId !== undefined && isNonEmptyString(authenticatedPrincipalId)) {
    return authenticatedPrincipalId;
  }
  return resolveLocalPrincipalId(workspaceId);
}

/**
 * Derive a stable semantic event ID from a scope and a caller-supplied
 * semantic key (e.g. `${runId}:step:${stepIndex}`). Retries of the same
 * semantic event reuse the same ID; distinct attempts/effects must use
 * distinct keys. Reusing an ID with different content is a conflict, detected
 * via `computeEventDigest`.
 */
export function stableEventId(scope: MemoryScopeV2, semanticKey: string): string {
  validateScope(scope);
  if (!isNonEmptyString(semanticKey)) reject("semantic key must be a non-empty string");
  return `evt-${stableHash([scope.workspaceId, scope.principalId, scope.sessionId, semanticKey]).slice(0, 32)}`;
}

/** A fresh event ID for a genuinely new event (not a retry). */
export function freshEventId(): string {
  return `evt-${randomUUID()}`;
}

/**
 * Content digest of an event: everything that makes the event's meaning,
 * excluding the ID, sequence, schema version, and timestamp. A reused event ID
 * with a different digest is a conflict, not a silent overwrite.
 */
export function computeEventDigest(event: MemoryEventAppendV2): string {
  validateEventAppend(event);
  const canonical = {
    identity: event.identity,
    runRef: event.runRef,
    stepRef: event.stepRef,
    kind: event.kind,
    outcome: event.outcome,
    payload: event.payload,
    evidenceRefs: event.evidenceRefs ?? [],
  };
  return `sha256:${stableHash([JSON.stringify(canonical)])}`;
}
