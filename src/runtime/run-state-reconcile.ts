/**
 * Durable run-state reconciliation (PI-06, resume logic).
 *
 * `src/runtime/run-state.ts` owns the sealed on-disk envelope: plan/version identity, the
 * active step ID, the current attempt ID, workspace/branch identity, evidence
 * references, and the authoritative completion record. This module owns the
 * *decision* layer on top of that state: given a loaded (or absent/invalid)
 * run-state artifact and the current workspace identity, it classifies whether
 * the interrupted attempt
 *
 *   - succeeded (a terminal success record exists),
 *   - failed (a terminal failed/blocked/invalid record exists),
 *   - is uncertain (a tool effect may have been applied but no terminal record
 *     exists), or
 *   - is replay-safe (an attempt was started but no external effect happened).
 *
 * It also builds the idempotency keys used by integrations that support them
 * (Spec Keeper task keys, Git commit trailers) and resolves pending tool
 * effects through an injected inspector so non-idempotent, ambiguous effects
 * are reported for inspection instead of being blindly replayed.
 *
 * The module is pure: it performs no file or network I/O and never mutates its
 * inputs. Trust decisions are made exclusively from the validated `RunState`
 * produced by `loadRunState` (digest already verified) plus caller-supplied
 * workspace identity and inspection hooks.
 */

import type { StepEvidenceReference } from "../planning/plan-model.js";
import type {
    LoadRunStateResult,
    RunState,
    RunStateCompletionRecord,
    RunStateToolEffect,
    RunStateWorkspaceIdentity,
} from "./run-state.js";

/**
 * Marker stored inside a `StepEvidenceReference.evidence` payload to identify
 * a recorded tool side effect. Any other evidence shape is treated as ordinary
 * (non-effect) evidence and is ignored by the effect resolver.
 */
export const TOOL_EFFECT_EVIDENCE_KIND = "elastic-agent-tool-effect" as const;

/** Git trailer name used for idempotent review commits. */
export const GIT_COMMIT_TRAILER_NAME = "Elastic-Agent-Run" as const;

/** Integrations the effect resolver knows how to inspect by idempotency key. */
export type ToolEffectIntegration = "git" | "spec-keeper";

/** The lifecycle position of an interrupted attempt, derived from run-state. */
export type AttemptRecoveryPhase =
    | "idle"
    | "attempt-started"
    | "tool-effect-recorded"
    | "terminal-recorded";

/**
 * The result of classifying a loaded run-state artifact against the current
 * workspace. Exactly one of these statuses is returned, and every non-`fresh`
 * status carries enough information to act without re-reading the file.
 */
export type RecoveryDecision =
    | { readonly status: "fresh" }
    | { readonly status: "untrusted"; readonly reason: string }
    | { readonly status: "incompatible"; readonly reason: string }
    | {
        readonly status: "replay-safe";
        readonly planId: string;
        readonly planVersion: number;
        readonly activeStepId: number | null;
        readonly attemptId: string | null;
      }
    | {
        readonly status: "uncertain";
        readonly planId: string;
        readonly planVersion: number;
        readonly stepId: number;
        readonly attemptId: string;
        readonly reason: string;
        readonly pendingEffects: RunStateToolEffect[];
      }
    | {
        readonly status: "succeeded";
        readonly planId: string;
        readonly planVersion: number;
        readonly stepId: number;
        readonly recordedAt?: string;
      }
    | {
        readonly status: "failed";
        readonly planId: string;
        readonly planVersion: number;
        readonly stepId: number;
        readonly outcome: "failed" | "blocked" | "invalid";
        readonly recordedAt?: string;
      };

/** Input accepted by `buildToolEffectRecord`. */
export interface ToolEffectRecordInput {
    readonly stepId: number;
    readonly attemptId: string;
    readonly toolCallId: string;
    readonly toolName?: string;
    readonly integration?: ToolEffectIntegration;
    /** Idempotency key the integration can use to verify/deduplicate the effect. */
    readonly idempotencyKey?: string;
    readonly recordedAt?: string;
}

/** Inspection hooks used to verify recorded effects on resume. */
export interface RecoveryInspector {
    /** Return true/false when the task exists/does not exist; null when unknown. */
    readonly hasSpecKeeperTask?: (idempotencyKey: string) => boolean | null;
    /** Return true/false when a commit carrying the trailer exists/does not; null when unknown. */
    readonly hasGitCommitWithTrailer?: (trailer: string) => boolean | null;
}

/** Per-effect resolution produced by `resolvePendingEffects`. */
export interface PendingEffectResolution {
    /** True when at least one effect could not be verified and needs inspection. */
    readonly requiresInspection: boolean;
    /** Effects the integration confirmed as already applied. */
    readonly confirmed: readonly RunStateToolEffect[];
    /** Effects the integration confirmed as absent (safe to retry). */
    readonly absent: readonly RunStateToolEffect[];
    /** Effects that could not be verified (no key/checker, or unknown result). */
    readonly ambiguous: readonly RunStateToolEffect[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireLabel(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Tool effect field '${field}' must be a non-empty string.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error(`Tool effect field '${field}' must not contain control characters.`);
    }
    return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
    if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new Error(`Tool effect field '${field}' must be a positive integer.`);
    }
    return value as number;
}

/** Derive a deterministic, URL-safe token from arbitrary identity text. */
export function sanitizeIdempotencyToken(value: string): string {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 96);
    return slug || "run";
}

/**
 * Build a validated tool-effect record. This is the single construction point
 * for the effect evidence persisted into the run-state envelope, so every
 * effect carries a stable step/attempt identity and (when the integration
 * supports one) an idempotency key.
 */
export function buildToolEffectRecord(input: ToolEffectRecordInput): RunStateToolEffect {
    const stepId = requirePositiveInteger(input.stepId, "stepId");
    const attemptId = requireLabel(input.attemptId, "attemptId");
    const toolCallId = requireLabel(input.toolCallId, "toolCallId");
    const integration = input.integration;
    if (integration !== undefined && integration !== "git" && integration !== "spec-keeper") {
        throw new Error("Tool effect field 'integration' must be 'git' or 'spec-keeper' when provided.");
    }
    const idempotencyKey = input.idempotencyKey === undefined ? undefined : requireLabel(input.idempotencyKey, "idempotencyKey");
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(recordedAt))) {
        throw new Error("Tool effect field 'recordedAt' must be an ISO-8601 timestamp.");
    }
    const toolName = typeof input.toolName === "string" && input.toolName.trim().length > 0
        ? input.toolName
        : undefined;
    return {
        kind: TOOL_EFFECT_EVIDENCE_KIND,
        stepId,
        attemptId,
        toolCallId,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(integration !== undefined ? { integration } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        recordedAt,
    };
}

/** Wrap a tool-effect record as a run-state evidence reference. */
export function toolEffectReference(effect: RunStateToolEffect): StepEvidenceReference {
    return {
        stepId: effect.stepId,
        attemptId: effect.attemptId,
        evidence: effect,
        recordedAt: effect.recordedAt,
    };
}

/** True when an evidence payload is a recorded tool effect. */
export function isToolEffectEvidence(evidence: unknown): evidence is RunStateToolEffect {
    if (!isRecord(evidence)) return false;
    return evidence.kind === TOOL_EFFECT_EVIDENCE_KIND;
}

/** Every tool-effect record carried by a run-state's evidence references. */
export function toolEffectsFromState(state: RunState): RunStateToolEffect[] {
    return state.evidenceReferences
        .map((reference) => reference.evidence)
        .filter(isToolEffectEvidence);
}

/** Tool effects recorded for one step/attempt pair, in stored order. */
export function toolEffectsForAttempt(state: RunState, stepId: number, attemptId: string): RunStateToolEffect[] {
    return toolEffectsFromState(state).filter(
        (effect) => effect.stepId === stepId && effect.attemptId === attemptId,
    );
}

/** The terminal completion record for a step, when one exists. */
export function terminalRecordForStep(state: RunState, stepId: number): RunStateCompletionRecord | null {
    return state.completedSteps.find((record) => record.stepId === stepId) ?? null;
}

/**
 * Derive the interrupted attempt's lifecycle position from a validated state.
 *
 *   - `idle`              — no active step pointer (nothing in flight).
 *   - `attempt-started`   — an attempt ID exists but no effect/terminal record.
 *   - `tool-effect-recorded` — an effect exists but no terminal record.
 *   - `terminal-recorded` — the active step has a terminal completion record.
 */
export function deriveAttemptPhase(state: RunState): AttemptRecoveryPhase {
    if (state.activeStepId === null) return "idle";
    const terminal = terminalRecordForStep(state, state.activeStepId);
    if (terminal) return "terminal-recorded";
    const effects = toolEffectsForAttempt(state, state.activeStepId, state.attemptId ?? "");
    return effects.length > 0 ? "tool-effect-recorded" : "attempt-started";
}

function sameWorkspaceIdentity(saved: RunStateWorkspaceIdentity, current: RunStateWorkspaceIdentity): string | null {
    if (saved.workspacePath !== current.workspacePath) {
        return `saved workspace '${saved.workspacePath}' does not match the current workspace '${current.workspacePath}'.`;
    }
    if (saved.branch !== null && current.branch !== null && saved.branch !== current.branch) {
        return `saved branch '${saved.branch}' does not match the current branch '${current.branch}'.`;
    }
    return null;
}

/**
 * Classify a loaded run-state artifact for resume.
 *
 * Trust boundary: only `loaded` results are considered; `invalid` (wrong kind
 * or schema version, malformed/mismatched digest, failed validation) and
 * `failure` (I/O error other than ENOENT) are `untrusted`, and a loaded state
 * whose workspace/branch identity no longer matches is `incompatible`. None of
 * those may authorize re-execution.
 */
export function reconcileRecovery(
    loadResult: LoadRunStateResult,
    currentIdentity: RunStateWorkspaceIdentity,
): RecoveryDecision {
    if (loadResult.status === "absent") return { status: "fresh" };
    if (loadResult.status === "failure") {
        return { status: "untrusted", reason: `Run-state could not be read: ${loadResult.reason}` };
    }
    if (loadResult.status === "invalid") {
        return { status: "untrusted", reason: loadResult.reason };
    }

    const state = loadResult.state;
    const mismatch = sameWorkspaceIdentity(state.workspaceIdentity, currentIdentity);
    if (mismatch !== null) return { status: "incompatible", reason: mismatch };

    const plan = { planId: state.planId, planVersion: state.planVersion };
    if (state.activeStepId === null) {
        const hasEffects = toolEffectsFromState(state).length > 0 || state.completedSteps.length > 0;
        if (hasEffects) {
            return {
                status: "uncertain",
                ...plan,
                stepId: 0,
                attemptId: state.attemptId ?? "",
                reason: "Run-state has recorded effects or completions but no active step pointer; inspection is required before resuming.",
                pendingEffects: toolEffectsFromState(state),
            };
        }
        return { status: "replay-safe", ...plan, activeStepId: null, attemptId: null };
    }

    const stepId = state.activeStepId;
    const terminal = terminalRecordForStep(state, stepId);
    if (terminal) {
        if (terminal.outcome === "succeeded") {
            return { status: "succeeded", ...plan, stepId, ...(terminal.recordedAt !== undefined ? { recordedAt: terminal.recordedAt } : {}) };
        }
        return {
            status: "failed",
            ...plan,
            stepId,
            outcome: terminal.outcome,
            ...(terminal.recordedAt !== undefined ? { recordedAt: terminal.recordedAt } : {}),
        };
    }

    const attemptId = state.attemptId ?? "";
    const pendingEffects = toolEffectsForAttempt(state, stepId, attemptId);
    if (pendingEffects.length > 0) {
        return {
            status: "uncertain",
            ...plan,
            stepId,
            attemptId,
            reason: `A tool effect for step ${stepId} (attempt ${attemptId}) was recorded before success; the effect must be reconciled before resuming.`,
            pendingEffects,
        };
    }

    return { status: "replay-safe", ...plan, activeStepId: stepId, attemptId: state.attemptId };
}

/**
 * Resolve each pending effect from an `uncertain` decision through the
 * injected integration inspector.
 *
 *   - An effect with a known integration and idempotency key is `confirmed`
 *     when the inspector returns true and `absent` when it returns false.
 *   - An effect without a key, without a checker, or with an unknown/null
 *     inspection result is `ambiguous` and requires operator inspection.
 *
 * `requiresInspection` is true exactly when at least one effect is ambiguous.
 */
export function resolvePendingEffects(
    decision: RecoveryDecision,
    inspector: RecoveryInspector = {},
): PendingEffectResolution {
    if (decision.status !== "uncertain") {
        return { requiresInspection: false, confirmed: [], absent: [], ambiguous: [] };
    }
    const confirmed: RunStateToolEffect[] = [];
    const absent: RunStateToolEffect[] = [];
    const ambiguous: RunStateToolEffect[] = [];

    for (const effect of decision.pendingEffects) {
        let result: boolean | null = null;
        if (effect.idempotencyKey !== undefined) {
            try {
                if (effect.integration === "spec-keeper" && inspector.hasSpecKeeperTask) {
                    result = inspector.hasSpecKeeperTask(effect.idempotencyKey);
                } else if (effect.integration === "git" && inspector.hasGitCommitWithTrailer) {
                    result = inspector.hasGitCommitWithTrailer(effect.idempotencyKey);
                }
            } catch {
                result = null;
            }
        }
        if (result === true) confirmed.push(effect);
        else if (result === false) absent.push(effect);
        else ambiguous.push(effect);
    }

    return { requiresInspection: ambiguous.length > 0, confirmed, absent, ambiguous };
}

/**
 * Deterministic run-level idempotency token combining plan, step, and attempt
 * identity. Used as the value of the Git commit trailer and (in a shorter,
 * step-scoped form) Spec Keeper task keys.
 */
export function runIdempotencyKey(planId: string, stepId: number, attemptId: string): string {
    return `elagent-${sanitizeIdempotencyToken(planId)}-step-${requirePositiveInteger(stepId, "stepId")}-${sanitizeIdempotencyToken(attemptId)}`;
}

/** A Git commit trailer carrying the run idempotency token. */
export function gitCommitTrailer(planId: string, stepId: number, attemptId: string): string {
    return `${GIT_COMMIT_TRAILER_NAME}: ${runIdempotencyKey(planId, stepId, attemptId)}`;
}

/**
 * Stable, plan-scoped Spec Keeper step-task key. Passing this key to
 * `syncSpecKeeperTask` makes task create/reuse idempotent across replans and
 * process restarts: the same plan+step always resolves the same external task.
 */
export function specKeeperStepTaskKey(planId: string, stepId: number): string {
    return `elagent-${sanitizeIdempotencyToken(planId)}-step-${requirePositiveInteger(stepId, "stepId")}`;
}
