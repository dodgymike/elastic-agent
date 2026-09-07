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

/* -------------------------------------------------------------------------
 * Consumer reducers
 *
 * The runtime funnels every execution attempt through `outcomeFromFeedback`
 * first, then maps that single normalized outcome into the values each
 * consumer needs (memory, Spec Keeper step tasks, task-lifecycle progress
 * log, and review inputs). Keeping the mappings here prevents any consumer
 * from re-deriving success/failure from the raw `stepStatus` string and
 * re-introducing the bug where invalid feedback was remembered as completed.
 * ------------------------------------------------------------------------- */

/** Memory-contract outcome status (mirrors src/memory/types.ts MemoryOutcomeStatus). */
export type MemoryContractOutcome = "completed" | "failed" | "aborted" | "skipped" | "unknown";

/**
 * Map a normalized step outcome onto the memory contract. Only `succeeded`
 * becomes `completed`; unverified or invalid outcomes become `unknown` so a
 * step that merely returned control is never remembered as completed work.
 */
export function memoryOutcomeFromOutcome(outcome: StepOutcome): MemoryContractOutcome {
    switch (outcome) {
        case "succeeded":
            return "completed";
        case "failed":
            return "failed";
        case "blocked":
            return "aborted";
        case "needs-verification":
        case "invalid":
        case "pending":
        case "running":
        default:
            return "unknown";
    }
}

/** Spec Keeper step-task statuses emitted by the reducer. */
export type SpecKeeperStepStatus = "done" | "blocked" | "failed" | "in_progress";

/**
 * Map a normalized step outcome onto the Spec Keeper step-task lifecycle.
 * Only `succeeded` becomes `done`. `blocked` maps to blocked, `failed` maps to
 * an explicit failed status, and `needs-verification`/`invalid` never become
 * `done` (`needs-verification` stays in_progress; invalid feedback is recorded
 * as an explicit failed status with a diagnostic note).
 */
export function specKeeperStepStatusFromOutcome(outcome: StepOutcome): SpecKeeperStepStatus {
    switch (outcome) {
        case "succeeded":
            return "done";
        case "blocked":
            return "blocked";
        case "failed":
            return "failed";
        case "needs-verification":
            return "in_progress";
        case "invalid":
            return "failed";
        case "pending":
        case "running":
        default:
            return "in_progress";
    }
}

/** Inputs shared by the per-consumer note builders. */
export interface StepOutcomeNoteInput {
    /** One-based plan step number the note refers to. */
    readonly stepNumber: number;
    /** Optional secret-free model summary for the step. */
    readonly summary?: string;
    /** Optional validation diagnostic for invalid/malformed feedback. */
    readonly validationError?: string;
}

function appendSummary(base: string, summary: string | undefined): string {
    const trimmed = typeof summary === "string" ? summary.trim() : "";
    return trimmed.length > 0 ? `${base} ${trimmed}` : base;
}

function invalidFeedbackDetail(validationError: string | undefined): string {
    const detail = typeof validationError === "string" ? validationError.trim() : "";
    return detail.length > 0 ? detail : "execution feedback was missing or malformed";
}

/** Human-readable diagnostic note for a Spec Keeper step task. */
export function specKeeperStepNoteFromOutcome(outcome: StepOutcome, input: StepOutcomeNoteInput): string {
    const step = `Step ${input.stepNumber}`;
    switch (outcome) {
        case "succeeded":
            return appendSummary(`${step} completed.`, input.summary);
        case "blocked":
            return appendSummary(`${step} blocked.`, input.summary);
        case "failed":
            return appendSummary(`${step} failed.`, input.summary);
        case "needs-verification":
            return appendSummary(`${step} needs verification: execution finished but success has not been evidenced.`, input.summary);
        case "invalid":
            return `${step} outcome invalid: ${invalidFeedbackDetail(input.validationError)}.`;
        case "pending":
        case "running":
        default:
            return `${step} in progress.`;
    }
}

/** Human-readable note for the task-lifecycle progress log. */
export function taskLifecycleNoteFromOutcome(outcome: StepOutcome, input: StepOutcomeNoteInput): string {
    const step = `Plan step ${input.stepNumber}`;
    switch (outcome) {
        case "succeeded":
            return appendSummary(`${step} succeeded.`, input.summary);
        case "blocked":
            return appendSummary(`${step} blocked.`, input.summary);
        case "failed":
            return appendSummary(`${step} failed.`, input.summary);
        case "needs-verification":
            return appendSummary(`${step} needs verification: execution finished but success has not been evidenced.`, input.summary);
        case "invalid":
            return `${step} outcome invalid: ${invalidFeedbackDetail(input.validationError)}.`;
        case "pending":
        case "running":
        default:
            return `${step} in progress.`;
    }
}

/** One normalized outcome reduced into every consumer's per-step values. */
export interface ReducedStepOutcome {
    readonly outcome: StepOutcome;
    /** True only for `succeeded`; never true for an unverified model claim. */
    readonly terminalSuccess: boolean;
    readonly memoryOutcome: MemoryContractOutcome;
    readonly specKeeperStatus: SpecKeeperStepStatus;
    readonly specKeeperNote: string;
    readonly taskLifecycleNote: string;
}

/**
 * Reduce one normalized outcome into the values all step consumers need.
 * Callers that record a step to memory, Spec Keeper, and the task-lifecycle
 * log in one place should use this once and fan the fields out, guaranteeing
 * every consumer agrees on the same outcome.
 */
export function reduceStepOutcome(outcome: StepOutcome, input: StepOutcomeNoteInput = { stepNumber: 1 }): ReducedStepOutcome {
    return {
        outcome,
        terminalSuccess: isTerminalSuccess(outcome),
        memoryOutcome: memoryOutcomeFromOutcome(outcome),
        specKeeperStatus: specKeeperStepStatusFromOutcome(outcome),
        specKeeperNote: specKeeperStepNoteFromOutcome(outcome, input),
        taskLifecycleNote: taskLifecycleNoteFromOutcome(outcome, input),
    };
}

/* -------------------------------------------------------------------------
 * Execution-feedback snapshot
 *
 * The execution loop funnels every executePlanStep result through one reducer
 * and then fans the single normalized outcome out to the local ledgers
 * (executionAttempts / completedSteps), memory, Spec Keeper step tasks, the
 * task-lifecycle progress log, and the review input. `snapshotStepFeedback`
 * computes that entire fan-out in one place so every consumer agrees on the
 * same outcome and so the behavior can be tested without booting main.ts.
 * ------------------------------------------------------------------------- */

/**
 * Secret-free evidence built from one execution-feedback entry. Valid feedback
 * contributes only the model-reported stepStatus/summary/findings; invalid or
 * missing feedback contributes only the validation diagnostic. Nothing here
 * reads file contents, data.json, or credentials.
 */
export function feedbackEvidence(feedbackEntry: unknown): unknown {
    const entry = feedbackEntry as any;
    if (entry?.valid && entry.feedback) {
        const feedback = entry.feedback;
        return {
            stepStatus: typeof feedback.stepStatus === "string" ? feedback.stepStatus : null,
            summary: typeof feedback.summary === "string" ? feedback.summary : "",
            findings: Array.isArray(feedback.findings) ? feedback.findings.slice() : [],
        };
    }
    return {
        validationError: typeof entry?.validationError === "string"
            ? entry.validationError
            : "execution feedback was missing or malformed",
    };
}

/**
 * Evidence-presence criterion used to promote a `completed` status to
 * `succeeded`. A step only succeeds when the model supplied at least one
 * non-empty finding or a non-empty summary; a bare `completed` claim with no
 * evidence degrades to `needs-verification` instead of being trusted.
 */
export function feedbackEvidenceSatisfied(evidence: unknown): boolean {
    if (Array.isArray(evidence)) return evidence.length > 0;
    if (!evidence || typeof evidence !== "object") return hasEvidence(evidence);
    const value = evidence as { findings?: unknown; summary?: unknown };
    return hasEvidence(value.findings) || hasEvidence(value.summary);
}

/** Append-only execution-attempt entry recorded in `configData.executionAttempts`. */
export interface StepAttemptEntry {
    /** One-based plan step number. */
    readonly step: number;
    /** Stable plan-model step ID when available; falls back to `step` otherwise. */
    readonly stepId?: number;
    /** Provider response id the feedback came from, or null when unavailable. */
    readonly feedbackResponseId: string | null;
    /** The raw, unmodified `stepStatus` value (null when it was absent). */
    readonly rawStatus: unknown;
    /** The normalized outcome derived from the raw status plus evidence. */
    readonly outcome: StepOutcome;
    /** The secret-free evidence considered when normalizing the outcome. */
    readonly evidence: unknown;
    /** ISO-8601 timestamp when the attempt was recorded. */
    readonly timestamp: string;
}

/** Completion-ledger entry recorded in `configData.completedSteps` for terminal outcomes. */
export interface StepLedgerEntry {
    /** One-based plan step number. */
    readonly step: number;
    /** Stable plan-model step ID when available; falls back to `step` otherwise. */
    readonly stepId?: number;
    /** The plan step text that was executed. */
    readonly text: string;
    /** Provider response id the feedback came from, or null when unavailable. */
    readonly feedbackResponseId: string | null;
    /** The normalized terminal outcome (succeeded/failed/blocked/invalid). */
    readonly outcome: StepOutcome;
    /** The secret-free evidence that produced the outcome. */
    readonly evidence: unknown;
    /** ISO-8601 timestamp when the entry was recorded. */
    readonly timestamp: string;
}

/** One feedback entry reduced into every consumer's per-step values. */
export interface StepFeedbackSnapshot {
    /** The append-only `executionAttempts` entry. */
    readonly attempt: StepAttemptEntry;
    /** The `completedSteps` ledger entry, or null for a non-terminal outcome. */
    readonly ledgerEntry: StepLedgerEntry | null;
    /** Memory / Spec Keeper / task-lifecycle values derived from the same outcome. */
    readonly reduced: ReducedStepOutcome;
}

export interface StepFeedbackSnapshotInput extends AttemptFromFeedbackInput {
    /**
     * The raw executePlanStep feedback entry: `{ valid, feedback, response_id,
     * validationError }`. Used to derive the raw status, evidence, and notes
     * unless the corresponding explicit override is supplied.
     */
    readonly feedbackEntry?: unknown;
    /** One-based plan step number (defaults to 1). */
    readonly step?: number;
    /** Stable plan-model step ID (falls back to `step` when omitted). */
    readonly stepId?: number;
    /** The executed plan step text recorded on the completion ledger (defaults to "Plan step N"). */
    readonly stepText?: string;
}

/**
 * Reduce one execution-feedback entry into the complete fan-out consumed by
 * the execution loop: the append-only attempt entry, the terminal-only
 * completion-ledger entry, and the memory/Spec Keeper/task-lifecycle values.
 *
 * The normalized outcome is always recomputed via `outcomeFromFeedback`, so a
 * `completed` claim with no acceptable evidence is recorded as
 * `needs-verification` (and therefore absent from the completion ledger),
 * never as succeeded.
 */
export function snapshotStepFeedback(input: StepFeedbackSnapshotInput = {}): StepFeedbackSnapshot {
    const step = Number.isInteger(input.step) ? (input.step as number) : 1;
    const stepId = Number.isInteger(input.stepId) && (input.stepId as number) > 0
        ? (input.stepId as number)
        : step;
    const stepText = typeof input.stepText === "string" && input.stepText.trim().length > 0
        ? input.stepText
        : `Plan step ${step}`;
    const entry = input.feedbackEntry as any;
    const valid = Boolean(entry?.valid && entry?.feedback);
    const evidence = input.evidence !== undefined ? input.evidence : feedbackEvidence(entry);
    const attemptRecord = attemptFromFeedback({
        responseId: input.responseId !== undefined
            ? input.responseId
            : (entry?.response_id === undefined ? null : entry.response_id),
        rawStatus: input.rawStatus !== undefined
            ? input.rawStatus
            : (valid ? entry.feedback.stepStatus : undefined),
        evidence,
        evidenceSatisfied: input.evidenceSatisfied !== undefined ? input.evidenceSatisfied : feedbackEvidenceSatisfied,
        requireEvidence: input.requireEvidence,
        timestamp: input.timestamp,
    });
    const attempt: StepAttemptEntry = {
        step,
        stepId,
        feedbackResponseId: attemptRecord.responseId,
        rawStatus: attemptRecord.rawStatus,
        outcome: attemptRecord.outcome,
        evidence: attemptRecord.evidence,
        timestamp: attemptRecord.timestamp,
    };
    const ledgerEntry: StepLedgerEntry | null = isTerminalOutcome(attemptRecord.outcome)
        ? {
            step,
            stepId,
            text: stepText,
            feedbackResponseId: attemptRecord.responseId,
            outcome: attemptRecord.outcome,
            evidence: attemptRecord.evidence,
            timestamp: attemptRecord.timestamp,
        }
        : null;
    const reduced = reduceStepOutcome(attemptRecord.outcome, {
        stepNumber: step,
        summary: valid && typeof entry.feedback.summary === "string"
            ? entry.feedback.summary
            : undefined,
        validationError: valid
            ? undefined
            : (typeof entry?.validationError === "string"
                ? entry.validationError
                : "execution feedback was missing or malformed"),
    });
    return { attempt, ledgerEntry, reduced };
}
