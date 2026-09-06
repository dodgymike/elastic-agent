/**
 * Normalized step-outcome model.
 *
 * This module is intentionally pure and dependency-free: it maps raw execution
 * feedback (the `stepStatus` a model returns) into a small, closed set of
 * normalized outcomes used by memory, the execution ledger, Spec Keeper task
 * lifecycle, and review inputs. Keeping the mapping in one place guarantees
 * every consumer agrees on what "done" means.
 *
 * Outcome states:
 *   pending            - step not started yet (runtime-owned lifecycle state)
 *   running            - step currently executing (runtime-owned lifecycle state)
 *   needs-verification - execution ended but success has not been evidenced yet
 *   succeeded          - terminal success: evidence criteria for completion met
 *   failed             - terminal failure: execution/checks failed
 *   blocked            - terminal block: execution could not proceed
 *   invalid            - terminal: feedback was malformed or missing, so the
 *                        outcome cannot be determined from the model's word
 *
 * The central safety rule is: the model merely returning control (or claiming
 * `completed`) is never enough to infer success. A `completed` status maps to
 * `succeeded` only when the supplied evidence meets the configured criteria.
 */

export type StepOutcome =
    | "pending"
    | "running"
    | "needs-verification"
    | "succeeded"
    | "failed"
    | "blocked"
    | "invalid";

/** Every valid normalized outcome, in declaration order. */
export const STEP_OUTCOMES: readonly StepOutcome[] = [
    "pending",
    "running",
    "needs-verification",
    "succeeded",
    "failed",
    "blocked",
    "invalid",
] as const;

export function isStepOutcome(value: unknown): value is StepOutcome {
    return typeof value === "string" && (STEP_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Best-effort presence test for evidence. Evidence is "present" when it is a
 * non-empty string, a non-empty array, a non-empty object, the boolean `true`,
 * or any other non-null primitive (for example a non-zero check count). This is
 * a *presence* test only; callers that need a stronger success criterion (for
 * example "all checks passed") should supply `evidenceSatisfied`.
 */
export function hasEvidence(evidence: unknown): boolean {
    if (evidence === null || evidence === undefined) return false;
    if (typeof evidence === "string") return evidence.trim().length > 0;
    if (Array.isArray(evidence)) return evidence.length > 0;
    if (typeof evidence === "boolean") return evidence;
    if (typeof evidence === "object") return Object.keys(evidence as object).length > 0;
    return true;
}

export interface StepOutcomeOptions {
    /**
     * Evidence collected for the step (check outputs, diff references, tool
     * results, artifact references, ...). Used to judge whether a `completed`
     * status may be promoted to `succeeded`.
     */
    readonly evidence?: unknown;
    /**
     * When `false`, a `completed` status maps directly to `succeeded` without
     * consulting evidence. Defaults to `true`: evidence is required for
     * success. Prefer leaving this enabled so a bare model claim cannot be
     * mistaken for verified work.
     */
    readonly requireEvidence?: boolean;
    /**
     * Optional success predicate. When supplied it replaces the default
     * evidence-presence test. If it throws, the outcome degrades to
     * `needs-verification` rather than inferring success.
     */
    readonly evidenceSatisfied?: (evidence: unknown) => boolean;
}

/**
 * Map a raw execution-feedback `stepStatus` into a normalized outcome.
 *
 *   completed -> succeeded      only when evidence criteria are met; otherwise
 *                                needs-verification
 *   partial  -> needs-verification
 *   failed   -> failed
 *   blocked  -> blocked
 *   missing/malformed/unknown -> invalid
 *
 * This never returns `succeeded` merely because the model produced a
 * `completed` status: with `requireEvidence` enabled (the default) a
 * `completed` without acceptable evidence becomes `needs-verification`.
 */
export function outcomeFromFeedback(stepStatus: unknown, opts: StepOutcomeOptions = {}): StepOutcome {
    if (typeof stepStatus !== "string") return "invalid";
    const status = stepStatus.trim();
    switch (status) {
        case "completed": {
            if (opts.requireEvidence === false) return "succeeded";
            const criterion = typeof opts.evidenceSatisfied === "function" ? opts.evidenceSatisfied : hasEvidence;
            let satisfied = false;
            try {
                satisfied = criterion(opts.evidence);
            } catch {
                // A throwing predicate must never be treated as evidence of
                // success; degrade to needs-verification.
                satisfied = false;
            }
            return satisfied ? "succeeded" : "needs-verification";
        }
        case "partial":
            return "needs-verification";
        case "failed":
            return "failed";
        case "blocked":
            return "blocked";
        default:
            return "invalid";
    }
}

/** True only for the single terminal success state. */
export function isTerminalSuccess(outcome: StepOutcome): boolean {
    return outcome === "succeeded";
}

/**
 * True when an outcome closes out the attempt with a definitive result. Only
 * `needs-verification` (and the runtime-owned `pending`/`running` lifecycle
 * states) are non-terminal; a terminal outcome needs no automatic re-execution.
 */
export function isTerminalOutcome(outcome: StepOutcome): boolean {
    return outcome === "succeeded" || outcome === "failed" || outcome === "blocked" || outcome === "invalid";
}

/** Append-only record of one execution-feedback attempt for a step. */
export interface StepAttemptRecord {
    /** Provider response id the feedback came from, or null when unavailable. */
    readonly responseId: string | null;
    /** The raw, unmodified `stepStatus` value (null when it was absent). */
    readonly rawStatus: unknown;
    /** The normalized outcome derived from the raw status plus evidence. */
    readonly outcome: StepOutcome;
    /** The evidence considered when normalizing the outcome. */
    readonly evidence: unknown;
    /** ISO-8601 timestamp when the attempt was recorded. */
    readonly timestamp: string;
}

export interface AttemptFromFeedbackInput extends StepOutcomeOptions {
    /** Provider response id for this attempt. */
    readonly responseId?: string | null;
    /** Raw execution-feedback status for this attempt. */
    readonly rawStatus?: unknown;
    /** Timestamp for the record; ISO string, epoch millis, or Date. */
    readonly timestamp?: string | number | Date;
}

function normalizeTimestamp(timestamp?: string | number | Date): string {
    if (timestamp === undefined) return new Date().toISOString();
    if (timestamp instanceof Date) return timestamp.toISOString();
    if (typeof timestamp === "number") return new Date(timestamp).toISOString();
    return timestamp;
}

/**
 * Build an append-only attempt record from one piece of execution feedback.
 * The normalized outcome is always recomputed via `outcomeFromFeedback`, so a
 * `completed` claim with no acceptable evidence is recorded as
 * `needs-verification`, never `succeeded`.
 */
export function attemptFromFeedback(input: AttemptFromFeedbackInput = {}): StepAttemptRecord {
    return {
        responseId: input.responseId === undefined ? null : input.responseId,
        rawStatus: input.rawStatus === undefined ? null : input.rawStatus,
        outcome: outcomeFromFeedback(input.rawStatus, input),
        evidence: input.evidence === undefined ? null : input.evidence,
        timestamp: normalizeTimestamp(input.timestamp),
    };
}
