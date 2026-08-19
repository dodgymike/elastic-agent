/**
 * Replan abort parsing and stuck-plan detection helpers. These pure functions
 * implement ABORT_SEMANTICS.md sections 4 and 5 and are extracted from main.ts
 * so the abort paths can be tested without importing the side-effecting CLI
 * entrypoint.
 */

import { extractJsonFromResponse, type PlanPhase } from "../plan-printer.js";
import { RunAbortError } from "./run-abort.js";

export type ReplanParseResult =
    | { readonly valid: false; readonly reason: string }
    | { readonly valid: true; readonly abort: true; readonly reason: string }
    | { readonly valid: true; readonly abort: false; readonly steps: string[]; readonly phase?: PlanPhase };

export const DEFAULT_MAX_REVISED_PLAN_STEPS = 50;

/**
 * True when a replanning response proposes a different top-level phase than the
 * one the plan is currently in, which the handler treats as a full restart.
 * A proposed phase always wins (if the replanner returns a phase at all) and a
 * change of value — or introducing a phase where none existed — is a restart.
 * Keeping the same phase (or omitting it, meaning steps are edited within the
 * current phase) returns false so the plan continues without restarting.
 */
export function phaseRestartRequired(previousPhase: PlanPhase | undefined, nextPhase: PlanPhase | undefined): boolean {
    return nextPhase !== undefined && nextPhase !== previousPhase;
}

/**
 * Validate a top-level `phase` value present on a replan response object.
 * Mirrors the plan-parser contract in prompts/planning-suffix.txt: a present
 * value must be a non-empty string or integer. Throws a descriptive error
 * otherwise.
 */
function validateReplanPhase(value: unknown): PlanPhase {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            throw new Error("Replan response 'phase' must be a non-empty string or integer when present.");
        }
        return trimmed;
    }
    if (typeof value === "number" && Number.isInteger(value)) {
        return value;
    }
    throw new Error("Replan response 'phase' must be a non-empty string or integer when present.");
}

/**
 * Parse a replan response. The replan prompt asks for JSON with either a
 * revised `steps` array or the explicit abort object. `abort: true` wins when
 * both are present, matching ABORT_SEMANTICS.md section 4.1.
 */
export function parseReplanResponse(text: string, maxRevisedPlanSteps = DEFAULT_MAX_REVISED_PLAN_STEPS): ReplanParseResult {
    let extracted: string;
    try {
        extracted = extractJsonFromResponse(text);
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(extracted);
    } catch (error) {
        return { valid: false, reason: `Replan response JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { valid: false, reason: "Replan response must be a JSON object." };
    }

    const record = parsed as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "abort")) {
        if (typeof record.abort !== "boolean") return { valid: false, reason: "Replan response 'abort' must be a boolean." };
        if (record.abort === true) {
            const reason = typeof record.reason === "string" ? record.reason.trim() : "";
            if (!reason) return { valid: false, reason: "An aborted replan response must provide a non-empty 'reason'." };
            return { valid: true, abort: true, reason };
        }
    }

    if (!Array.isArray(record.steps)) return { valid: false, reason: "Replan response JSON must contain a 'steps' array." };
    if (record.steps.length === 0) return { valid: false, reason: "The revised plan must contain at least one step." };
    if (record.steps.length > maxRevisedPlanSteps) return { valid: false, reason: `The revised plan has more than ${maxRevisedPlanSteps} steps.` };
    const steps = record.steps.map((step) => typeof step === "string" ? step.trim() : "");
    if (steps.some((step) => !step || /^(none|n\/?a|no action)$/i.test(step))) return { valid: false, reason: "The revised plan contains an empty or non-actionable step." };

    // The optional top-level "phase" lets the replanner (for very-high-complexity
    // plans) propose a move to a different major stage. When present it must be a
    // non-empty string or integer; when absent the steps are treated as edits
    // within the current phase. The handler compares this against the phase the
    // plan is currently in to decide on a full restart (see phaseRestartRequired).
    let phase: PlanPhase | undefined;
    const hasPhase = Object.prototype.hasOwnProperty.call(record, "phase") && record.phase !== undefined;
    if (hasPhase) {
        try {
            phase = validateReplanPhase(record.phase);
        } catch (error) {
            return { valid: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    return { valid: true, abort: false, steps, ...(phase !== undefined ? { phase } : {}) };
}

/** Normalized key of the remaining plan used for duplicate/no-progress detection. */
export function replanRemainingKey(activeSteps: readonly string[], completedStepCount: number): string {
    return activeSteps.slice(completedStepCount + 1).map((step) => String(step ?? "").trim()).filter(Boolean).join("\n");
}

export function throwIfReplanAttemptLimitReached(
    configData: { readonly replanAttemptCount?: number },
    step: number,
    maxReplanAttempts: number,
): void {
    if ((configData.replanAttemptCount ?? 0) >= maxReplanAttempts) {
        throw new RunAbortError(
            "stuck",
            "replan",
            `replan attempt limit reached (${maxReplanAttempts}/${maxReplanAttempts}) while step ${step} still requires replanning`,
            { step },
        );
    }
}

export function throwIfReplanTimeBudgetExceeded(
    configData: { readonly replanElapsedMs?: number },
    step: number,
    maxReplanDurationMs: number,
): void {
    const elapsed = configData.replanElapsedMs ?? 0;
    if (elapsed >= maxReplanDurationMs) {
        throw new RunAbortError("stuck", "replan", `replan time budget exceeded (${maxReplanDurationMs} ms)`, { step });
    }
}

/**
 * Add the wall-clock time spent inside the current replan attempt to the run
 * total and enforce the replan time budget. Called after an attempt returns so
 * a successful parse cannot hide an exhausted budget.
 */
export function recordReplanElapsedAndAssertBudget(
    configData: { replanElapsedMs?: number },
    step: number,
    startedAt: number,
    maxReplanDurationMs: number,
): void {
    configData.replanElapsedMs = (configData.replanElapsedMs ?? 0) + (Date.now() - startedAt);
    throwIfReplanTimeBudgetExceeded(configData, step, maxReplanDurationMs);
}

/** Advance the consecutive no-progress counter after an accepted replan. */
export function nextConsecutiveNoProgressReplans(progressed: boolean, current: number): number {
    return progressed ? 0 : current + 1;
}

/** Throw a stuck abort once consecutive identical replans reach the budget. */
export function throwIfConsecutiveNoProgressReplansReached(
    count: number,
    maxConsecutiveNoProgressReplans: number,
    step: number,
): void {
    if (count >= maxConsecutiveNoProgressReplans) {
        throw new RunAbortError("stuck", "replan", `no progress after ${maxConsecutiveNoProgressReplans} consecutive identical replans`, { step });
    }
}
