/**
 * Versioned durable run-state (PI-06).
 *
 * This module owns the *runtime-owned* plan-execution state that must survive
 * a crash, a memory compaction, or a summarized-memory loss: plan identity and
 * version, the active step ID, the current attempt ID, workspace/branch
 * identity, evidence references, and — most importantly — the authoritative
 * completion record. It is deliberately kept separate from summarized memory:
 * memory may be compacted, pruned, or lost entirely, but the completion record
 * written by this module is never derived from (or erased by) that memory.
 *
 * Persistence contract
 * --------------------
 *   - The on-disk artifact is a sealed JSON envelope:
 *       { kind, schemaVersion, digest, state }
 *     where `digest` is the SHA-256 of the canonical serialization of `state`.
 *   - Writes are atomic: the envelope is written to a unique temporary file in
 *     the destination directory, fsynced, and then renamed over the target, so
 *     a crash can never leave a half-written state behind.
 *   - Loads reject incompatible artifacts (wrong `kind` or `schemaVersion`) and
 *     untrusted artifacts (a missing/malformed digest, a digest mismatch, or a
 *     state that fails structural validation). A missing file is reported as
 *     `absent`; an I/O failure is reported as `failure`; a rejected artifact is
 *     reported as `invalid`. None of those non-`loaded` results may be used to
 *     authorize re-execution.
 *
 * The module is pure apart from its atomic file I/O helpers. It never mutates
 * its inputs and never touches the summarized-memory stores.
 */

import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PlanStepId, StepEvidenceReference } from "./plan-model.js";
import { isTerminalOutcome, type StepOutcome } from "./step-outcome.js";

/** The schema version emitted by this module. */
export const RUN_STATE_SCHEMA_VERSION = 1 as const;

/** The envelope `kind` marker. Anything else is rejected as untrusted. */
export const RUN_STATE_KIND = "elastic-agent-run-state" as const;

/** Maximum accepted on-disk run-state file size (1 MiB). */
export const DEFAULT_MAX_RUN_STATE_FILE_BYTES = 1_048_576;

/** Bound on path strings stored in workspace identity. */
const MAX_WORKSPACE_PATH_LENGTH = 4096;
/** Bound on branch/worktree strings stored in workspace identity. */
const MAX_BRANCH_LENGTH = 1024;
/** Bound on identifier-like fields (plan id, attempt id, response id). */
const MAX_LABEL_LENGTH = 512;

/** Workspace/branch identity captured when the run was written. */
export interface RunStateWorkspaceIdentity {
    /** Canonical workspace (starting-directory) path. Preserved verbatim. */
    readonly workspacePath: string;
    /** Git branch name captured when the state was written, or null. */
    readonly branch: string | null;
    /** Execution worktree path when staged work is in flight, or null. */
    readonly worktreePath: string | null;
}

/**
 * One authoritative completion record. Completion criteria are stored here —
 * not in summarized memory — so the record round-trips exactly what made the
 * step complete and cannot be lost when memory is compacted or dropped.
 */
export interface RunStateCompletionRecord {
    /** Stable plan-model step ID that completed. */
    readonly stepId: PlanStepId;
    /** Terminal normalized outcome (succeeded/failed/blocked/invalid). */
    readonly outcome: StepOutcome;
    /** Completion criteria for the step at the time it completed. */
    readonly completionCriteria: readonly string[];
    /** Attempt ID the step completed under, when known. */
    readonly attemptId?: string;
    /** Provider response ID the outcome came from, when known (may be null). */
    readonly feedbackResponseId?: string | null;
    /** ISO-8601 timestamp when the completion was recorded. */
    readonly recordedAt?: string;
}

/** The complete durable run-state payload. */
export interface RunState {
    readonly schemaVersion: typeof RUN_STATE_SCHEMA_VERSION;
    readonly planId: string;
    readonly planVersion: number;
    /** Stable ID of the step currently executing, or null when none. */
    readonly activeStepId: PlanStepId | null;
    /** Current execution attempt ID, or null when no attempt has started. */
    readonly attemptId: string | null;
    readonly workspaceIdentity: RunStateWorkspaceIdentity;
    readonly evidenceReferences: readonly StepEvidenceReference[];
    /** Authoritative completion record; survives memory loss/compaction. */
    readonly completedSteps: readonly RunStateCompletionRecord[];
    /** ISO-8601 timestamp of the last write. */
    readonly updatedAt: string;
}

/** The sealed on-disk envelope. */
export interface RunStateEnvelope {
    readonly kind: typeof RUN_STATE_KIND;
    readonly schemaVersion: typeof RUN_STATE_SCHEMA_VERSION;
    readonly digest: string;
    readonly state: RunState;
}

/** Input accepted by `createRunState`. */
export interface CreateRunStateInput {
    readonly planId: string;
    readonly planVersion: number;
    readonly activeStepId?: PlanStepId | null;
    readonly attemptId?: string | null;
    readonly workspaceIdentity: RunStateWorkspaceIdentity;
    readonly evidenceReferences?: readonly StepEvidenceReference[];
    readonly completedSteps?: readonly RunStateCompletionRecord[];
    readonly updatedAt?: string;
}

/** Non-throwing result for `loadRunState`. */
export type LoadRunStateResult =
    | { readonly status: "loaded"; readonly path: string; readonly state: RunState }
    | { readonly status: "absent"; readonly path: string }
    | { readonly status: "failure"; readonly path: string; readonly reason: string }
    | { readonly status: "invalid"; readonly path: string; readonly reason: string };

const RUN_STATE_KEYS = new Set<string>([
    "schemaVersion",
    "planId",
    "planVersion",
    "activeStepId",
    "attemptId",
    "workspaceIdentity",
    "evidenceReferences",
    "completedSteps",
    "updatedAt",
]);
const ENVELOPE_KEYS = new Set<string>(["kind", "schemaVersion", "digest", "state"]);
const WORKSPACE_IDENTITY_KEYS = new Set<string>(["workspacePath", "branch", "worktreePath"]);
const COMPLETION_RECORD_KEYS = new Set<string>([
    "stepId",
    "outcome",
    "completionCriteria",
    "attemptId",
    "feedbackResponseId",
    "recordedAt",
]);
const EVIDENCE_REFERENCE_KEYS = new Set<string>([
    "stepId",
    "attemptId",
    "feedbackResponseId",
    "evidence",
    "recordedAt",
]);
const TERMINAL_OUTCOMES = new Set<string>(["succeeded", "failed", "blocked", "invalid"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            throw new Error(`${where} must not contain the field '${key}'.`);
        }
    }
}

function requiredLabel(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string") {
        throw new Error(`Run state field '${field}' must be a string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`Run state field '${field}' must be a non-empty string.`);
    }
    if (trimmed.length > maxLength) {
        throw new Error(`Run state field '${field}' exceeds the maximum length of ${maxLength}.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new Error(`Run state field '${field}' must not contain control characters.`);
    }
    return trimmed;
}

function optionalLabel(value: unknown, field: string, maxLength: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    return requiredLabel(value, field, maxLength);
}

function optionalLabelOrNull(value: unknown, field: string, maxLength: number): string | null {
    if (value === null) return null;
    return optionalLabel(value, field, maxLength) ?? null;
}

/** Validate a literal path without trimming it (paths are literal content). */
function requiredPath(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Run state field '${field}' must be a non-empty string.`);
    }
    if (value.length > MAX_WORKSPACE_PATH_LENGTH) {
        throw new Error(`Run state field '${field}' exceeds the maximum length of ${MAX_WORKSPACE_PATH_LENGTH}.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error(`Run state field '${field}' must not contain control characters.`);
    }
    return value;
}

function optionalPathOrNull(value: unknown, field: string): string | null {
    if (value === null) return null;
    return requiredPath(value, field);
}

function positiveInteger(value: unknown, field: string): number {
    const asNumber = typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
            ? Number(value.trim())
            : Number.NaN;
    if (!Number.isInteger(asNumber) || asNumber <= 0) {
        throw new Error(`Run state field '${field}' must be a positive integer.`);
    }
    return asNumber;
}

function optionalPositiveIntegerOrNull(value: unknown, field: string): PlanStepId | null {
    if (value === null) return null;
    return positiveInteger(value, field);
}

function requiredStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`Run state field '${field}' must be a non-empty array.`);
    }
    return value.map((item, index) => {
        if (typeof item !== "string" || item.trim().length === 0) {
            throw new Error(`Run state field '${field}' must contain only non-empty strings (invalid item ${index + 1}).`);
        }
        return item.trim();
    });
}

function requiredIso(value: unknown, field: string): string {
    const label = requiredLabel(value, field, 128);
    if (Number.isNaN(Date.parse(label))) {
        throw new Error(`Run state field '${field}' must be an ISO-8601 timestamp.`);
    }
    return label;
}

function optionalIso(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    return requiredIso(value, field);
}

/** Reject non-finite and negative-zero numbers anywhere in a JSON value. */
function rejectNonFiniteNumbers(value: unknown, field: string): void {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            throw new Error(`Run state field '${field}' must not contain non-finite or negative-zero numbers.`);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) rejectNonFiniteNumbers(item, field);
        return;
    }
    if (isRecord(value)) {
        for (const item of Object.values(value)) rejectNonFiniteNumbers(item, field);
    }
}

function assertJsonSafe(value: unknown, field: string): void {
    if (value === undefined) return;
    try {
        JSON.stringify(value);
    } catch (error) {
        throw new Error(`Run state field '${field}' must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
    }
    rejectNonFiniteNumbers(value, field);
}

/** Canonicalize a JSON value for deterministic digest serialization. */
function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            throw new Error("Run state payload contains a non-finite or negative-zero number.");
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => (item === undefined ? null : canonicalize(item)));
    }
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item === undefined) continue;
            out[key] = canonicalize(item);
        }
        return out;
    }
    throw new Error("Run state payload contains an unsupported (non-JSON) value.");
}

/** Canonical, digest-stable serialization of an arbitrary JSON value. */
function serializeCanonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value)) + "\n";
}

function normalizeWorkspaceIdentity(raw: unknown): RunStateWorkspaceIdentity {
    if (!isRecord(raw)) {
        throw new Error("Run state field 'workspaceIdentity' must be an object.");
    }
    assertOnlyKeys(raw, WORKSPACE_IDENTITY_KEYS, "Run state 'workspaceIdentity'");
    return {
        workspacePath: requiredPath(raw.workspacePath, "workspaceIdentity.workspacePath"),
        branch: optionalLabelOrNull(raw.branch, "workspaceIdentity.branch", MAX_BRANCH_LENGTH),
        worktreePath: optionalPathOrNull(raw.worktreePath, "workspaceIdentity.worktreePath"),
    };
}

function normalizeEvidenceReference(raw: unknown, index: number): StepEvidenceReference {
    const where = `Run state evidence reference ${index + 1}`;
    if (!isRecord(raw)) {
        throw new Error(`${where} must be an object.`);
    }
    assertOnlyKeys(raw, EVIDENCE_REFERENCE_KEYS, where);
    const stepId = positiveInteger(raw.stepId, `${where} 'stepId'`);
    const attemptId = optionalLabel(raw.attemptId, `${where} 'attemptId'`, MAX_LABEL_LENGTH);
    const feedbackResponseId = optionalLabel(raw.feedbackResponseId, `${where} 'feedbackResponseId'`, MAX_LABEL_LENGTH);
    const evidence = raw.evidence;
    assertJsonSafe(evidence, `${where} 'evidence'`);
    const recordedAt = optionalIso(raw.recordedAt, `${where} 'recordedAt'`);
    return {
        stepId,
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(feedbackResponseId !== undefined ? { feedbackResponseId } : {}),
        ...(hasOwn(raw, "evidence") && evidence !== undefined ? { evidence } : {}),
        ...(recordedAt !== undefined ? { recordedAt } : {}),
    };
}

function normalizeEvidenceReferences(raw: unknown): readonly StepEvidenceReference[] {
    if (!Array.isArray(raw)) {
        throw new Error("Run state field 'evidenceReferences' must be an array.");
    }
    return raw.map((item, index) => normalizeEvidenceReference(item, index));
}

function normalizeCompletionRecord(raw: unknown, index: number): RunStateCompletionRecord {
    const where = `Run state completed step ${index + 1}`;
    if (!isRecord(raw)) {
        throw new Error(`${where} must be an object.`);
    }
    assertOnlyKeys(raw, COMPLETION_RECORD_KEYS, where);
    const stepId = positiveInteger(raw.stepId, `${where} 'stepId'`);
    const outcome = raw.outcome;
    if (typeof outcome !== "string" || !TERMINAL_OUTCOMES.has(outcome) || !isTerminalOutcome(outcome as StepOutcome)) {
        throw new Error(`${where} 'outcome' must be a terminal step outcome (succeeded, failed, blocked, or invalid).`);
    }
    const completionCriteria = requiredStringArray(raw.completionCriteria, `${where} 'completionCriteria'`);
    const attemptId = optionalLabel(raw.attemptId, `${where} 'attemptId'`, MAX_LABEL_LENGTH);
    const feedbackResponseId = optionalLabelOrNull(raw.feedbackResponseId, `${where} 'feedbackResponseId'`, MAX_LABEL_LENGTH);
    const recordedAt = optionalIso(raw.recordedAt, `${where} 'recordedAt'`);
    return {
        stepId,
        outcome: outcome as StepOutcome,
        completionCriteria,
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(feedbackResponseId !== undefined ? { feedbackResponseId } : {}),
        ...(recordedAt !== undefined ? { recordedAt } : {}),
    };
}

function normalizeCompletedSteps(raw: unknown): readonly RunStateCompletionRecord[] {
    if (!Array.isArray(raw)) {
        throw new Error("Run state field 'completedSteps' must be an array.");
    }
    const records = raw.map((item, index) => normalizeCompletionRecord(item, index));
    const seen = new Set<PlanStepId>();
    for (const record of records) {
        if (seen.has(record.stepId)) {
            throw new Error(`Run state 'completedSteps' must not contain duplicate step id ${record.stepId}.`);
        }
        seen.add(record.stepId);
    }
    return records;
}

/**
 * Validate and normalize a raw run-state object into a `RunState`. Throws a
 * descriptive `Error` when the object fails any structural invariant. This is
 * the single validation boundary used by `createRunState`, `validateRunState`,
 * and `loadRunState` (after the envelope digest has been verified).
 */
export function normalizeRunState(raw: unknown): RunState {
    if (!isRecord(raw)) {
        throw new Error("Run state must be a JSON object.");
    }
    assertOnlyKeys(raw, RUN_STATE_KEYS, "Run state");
    if (raw.schemaVersion !== RUN_STATE_SCHEMA_VERSION) {
        throw new Error(`Run state schema version ${String(raw.schemaVersion)} is incompatible; expected ${RUN_STATE_SCHEMA_VERSION}.`);
    }
    const planId = requiredLabel(raw.planId, "planId", MAX_LABEL_LENGTH);
    const planVersion = positiveInteger(raw.planVersion, "planVersion");
    const activeStepId = optionalPositiveIntegerOrNull(raw.activeStepId, "activeStepId");
    const attemptId = optionalLabelOrNull(raw.attemptId, "attemptId", MAX_LABEL_LENGTH);
    const workspaceIdentity = normalizeWorkspaceIdentity(raw.workspaceIdentity);
    const evidenceReferences = normalizeEvidenceReferences(raw.evidenceReferences);
    const completedSteps = normalizeCompletedSteps(raw.completedSteps);
    const updatedAt = requiredIso(raw.updatedAt, "updatedAt");
    return {
        schemaVersion: RUN_STATE_SCHEMA_VERSION,
        planId,
        planVersion,
        activeStepId,
        attemptId,
        workspaceIdentity,
        evidenceReferences,
        completedSteps,
        updatedAt,
    };
}

/**
 * Validate an already-typed `RunState`. Returns the normalized state (a fresh
 * object) and throws when any invariant is violated. `normalizeRunState` is the
 * underlying implementation; this wrapper keeps call sites self-documenting.
 */
export function validateRunState(state: RunState): RunState {
    return normalizeRunState(state);
}

/** Shallow type guard for a normalized `RunState`. */
export function isRunState(value: unknown): value is RunState {
    if (!isRecord(value)) return false;
    if (value.schemaVersion !== RUN_STATE_SCHEMA_VERSION) return false;
    if (typeof value.planId !== "string" || !Number.isInteger(value.planVersion)) return false;
    if (!isRecord(value.workspaceIdentity)) return false;
    return Array.isArray(value.evidenceReferences) && Array.isArray(value.completedSteps);
}

/**
 * Build a validated `RunState` from plain fields. `updatedAt` defaults to the
 * current time; `activeStepId`, `attemptId`, `evidenceReferences`, and
 * `completedSteps` default to null/empty.
 */
export function createRunState(input: CreateRunStateInput): RunState {
    return normalizeRunState({
        schemaVersion: RUN_STATE_SCHEMA_VERSION,
        planId: input.planId,
        planVersion: input.planVersion,
        activeStepId: input.activeStepId === undefined ? null : input.activeStepId,
        attemptId: input.attemptId === undefined ? null : input.attemptId,
        workspaceIdentity: input.workspaceIdentity,
        evidenceReferences: input.evidenceReferences ?? [],
        completedSteps: input.completedSteps ?? [],
        updatedAt: input.updatedAt ?? new Date().toISOString(),
    });
}

/** Stable step IDs of the authoritative completion record, in stored order. */
export function completedStepIds(state: RunState): PlanStepId[] {
    return state.completedSteps.map((record) => record.stepId);
}

/** True when `stepId` has an authoritative completion record. */
export function isStepCompleted(state: RunState, stepId: PlanStepId): boolean {
    return state.completedSteps.some((record) => record.stepId === stepId);
}

/**
 * Canonical, digest-stable serialization of a validated `RunState`. Used to
 * compute the envelope digest; never the raw on-disk layout itself.
 */
export function serializeRunState(state: RunState): string {
    return serializeCanonicalJson(validateRunState(state));
}

/** SHA-256 (hex) of a validated run state's canonical serialization. */
export function runStateDigest(state: RunState): string {
    return createHash("sha256").update(serializeRunState(state), "utf8").digest("hex");
}

function validateFilePath(filePath: unknown): string {
    if (typeof filePath !== "string" || filePath.length === 0) {
        throw new TypeError("Run-state file path must be a non-empty string.");
    }
    if (filePath.includes("\u0000")) {
        throw new TypeError("Run-state file path must not contain NUL bytes.");
    }
    return filePath;
}

function isErrnoCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function wrapIoError(operation: string, filePath: string, error: unknown): Error {
    return new Error(`Failed to ${operation} run-state file '${filePath}': ${describeError(error)}`, {
        cause: error instanceof Error ? error : undefined,
    });
}

/** Atomically replace `filePath` with `content` (temp file + fsync + rename). */
function atomicWriteFile(filePath: string, content: string): void {
    const directory = dirname(filePath);
    const temporaryFilename = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        descriptor = openSync(temporaryFilename, "wx", 0o600);
        writeFileSync(descriptor, content, "utf-8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporaryFilename, filePath);
    } catch (error) {
        if (descriptor !== undefined) {
            try {
                closeSync(descriptor);
            } catch {
                // Preserve the original write error.
            }
        }
        try {
            rmSync(temporaryFilename, { force: true });
        } catch {
            // Preserve the original write error.
        }
        throw wrapIoError("write", filePath, error);
    }
}

/**
 * Atomically persist a validated run state as a sealed envelope. Throws on an
 * invalid state, an invalid path, or an I/O failure; the previous file (if any)
 * is never replaced until the new envelope is fully written and fsynced.
 */
export function writeRunState(filePath: string, state: RunState): void {
    const target = validateFilePath(filePath);
    const normalized = validateRunState(state);
    const digest = runStateDigest(normalized);
    const envelope: RunStateEnvelope = {
        kind: RUN_STATE_KIND,
        schemaVersion: RUN_STATE_SCHEMA_VERSION,
        digest,
        state: normalized,
    };
    atomicWriteFile(target, JSON.stringify(envelope, null, 2) + "\n");
}

function rejectEnvelope(parsed: unknown, filePath: string): LoadRunStateResult {
    if (!isRecord(parsed)) {
        return { status: "invalid", path: filePath, reason: "Run-state file must contain a JSON object." };
    }
    for (const key of Object.keys(parsed)) {
        if (!ENVELOPE_KEYS.has(key)) {
            return { status: "invalid", path: filePath, reason: `Run-state envelope must not contain the field '${key}'.` };
        }
    }
    if (parsed.kind !== RUN_STATE_KIND) {
        return { status: "invalid", path: filePath, reason: `Run-state envelope kind '${String(parsed.kind)}' is not trusted; expected '${RUN_STATE_KIND}'.` };
    }
    if (parsed.schemaVersion !== RUN_STATE_SCHEMA_VERSION) {
        return { status: "invalid", path: filePath, reason: `Run-state schema version ${String(parsed.schemaVersion)} is incompatible; expected ${RUN_STATE_SCHEMA_VERSION}.` };
    }
    if (typeof parsed.digest !== "string" || !/^[0-9a-f]{64}$/.test(parsed.digest)) {
        return { status: "invalid", path: filePath, reason: "Run-state envelope 'digest' is missing or malformed." };
    }
    if (!hasOwn(parsed, "state")) {
        return { status: "invalid", path: filePath, reason: "Run-state envelope is missing the 'state' payload." };
    }
    let actualDigest: string;
    try {
        actualDigest = createHash("sha256").update(serializeCanonicalJson(parsed.state), "utf8").digest("hex");
    } catch (error) {
        return { status: "invalid", path: filePath, reason: `Run-state payload could not be canonicalized: ${describeError(error)}` };
    }
    if (actualDigest !== parsed.digest) {
        return { status: "invalid", path: filePath, reason: "Run-state digest mismatch; the saved artifact is untrusted or corrupted." };
    }
    let state: RunState;
    try {
        state = normalizeRunState(parsed.state);
    } catch (error) {
        return { status: "invalid", path: filePath, reason: `Run-state payload failed validation: ${describeError(error)}` };
    }
    return { status: "loaded", path: filePath, state };
}

/**
 * Load and verify a durable run-state file.
 *
 * Returns a discriminated result rather than throwing so callers can treat a
 * missing file as a fresh start while still refusing to resume from an
 * incompatible or untrusted artifact:
 *
 *   - `loaded`  — the file parsed, its digest matched, and its state validated.
 *   - `absent`  — the file does not exist (fresh start).
 *   - `failure` — an I/O error other than a missing file prevented the read.
 *   - `invalid` — the artifact was present but rejected (wrong kind/version,
 *                 malformed or mismatched digest, or a state that failed
 *                 validation). Never use this result to authorize re-execution.
 */
export function loadRunState(filePath: string): LoadRunStateResult {
    const target = validateFilePath(filePath);
    let size: number;
    try {
        size = statSync(target).size;
    } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return { status: "absent", path: target };
        return { status: "failure", path: target, reason: describeError(error) };
    }
    if (size > DEFAULT_MAX_RUN_STATE_FILE_BYTES) {
        return {
            status: "invalid",
            path: target,
            reason: `Run-state file exceeds the maximum size of ${DEFAULT_MAX_RUN_STATE_FILE_BYTES} bytes.`,
        };
    }
    let text: string;
    try {
        text = readFileSync(target, "utf8");
    } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return { status: "absent", path: target };
        return { status: "failure", path: target, reason: describeError(error) };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return { status: "invalid", path: target, reason: `Run-state file is not valid JSON: ${describeError(error)}` };
    }
    return rejectEnvelope(parsed, target);
}
