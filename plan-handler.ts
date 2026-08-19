/**
 * Plan / step handler logic.
 *
 * This module owns the reusable *shaping and reporting* helpers that the CLI
 * uses to turn a parsed plan into executable steps, validate a _revised_ plan,
 * format a plan listing, apply execution-feedback suggestions (local step
 * updates and remaining-step updates), count classifier-denial goals that
 * reached the "fighting" threshold, and report execution feedback / applied
 * plan changes through an injectable status reporter.
 *
 * Design notes:
 *  - Every helper is a pure function except the two reporting helpers, which
 *    take a `PlanHandlerReporter` (a structural subset of the `status`
 *    reporter defined in main.ts) so no global/console state leaks in. This
 *    keeps the module unit-testable without booting the CLI.
 *  - The heavier, stateful orchestration (running steps, invoking tools, the
 *    replan request loop, phase-restart application, and the Spec Keeper /
 *    worktree / LLM interactions) intentionally remains in main.ts, where it
 *    is already anchored by the CLI's source-text structure tests and bound to
 *    the run's module-level configuration. This module therefore concentrates
 *    the deterministic, dependency-light plan/step logic.
 */

import { truncate } from "./tool-renderer.js";

/** The default handler for a revised-plan step count (mirrors main.ts). */
export const DEFAULT_MAX_REVISED_PLAN_STEPS = 50;

/**
 * Structural subset of main.ts's `status` reporter needed by the reporting
 * helpers. Only `warning`, `feedback`, `replan`, and `change` are used; each
 * takes a message and an optional already-indented prefix.
 */
export interface PlanHandlerReporter {
    warning(message: string, prefix?: string): void;
    feedback(message: string, prefix?: string): void;
    replan(message: string, prefix?: string): void;
    change(message: string, prefix?: string): void;
}

/**
 * Parse a free-text plan (as produced by the planner when it returns plain
 * steps rather than a JSON steps array) into an array of step strings. Numbered
 * lines (`1. ...` / `1) ...`) are extracted and de-prefixed; when no numbered
 * lines are present the whole trimmed plan is treated as a single step, falling
 * back to a sensible default step for a completely empty plan.
 */
export function planSteps(plan: unknown): string[] {
    const text = typeof plan === "string" ? plan : "";
    const steps = text.split("\n").map((line) => line.trim())
        .filter((line) => /^\d+[.)]\s+/.test(line))
        .map((line) => line.replace(/^\d+[.)]\s+/, "").trim())
        .filter(Boolean);
    return steps.length > 0
        ? steps
        : [text.trim() || "Execute the requested work and report the result."];
}

/**
 * Validate a _revised_ plan (a text plan returned by the replanner) into a
 * non-throwing result: `{ valid: true, steps }` when it has 1..maxRevisedPlanSteps
 * non-empty, actionable numbered steps, or `{ valid: false, reason }` otherwise.
 */
export function actionablePlanSteps(plan: unknown, maxRevisedPlanSteps = DEFAULT_MAX_REVISED_PLAN_STEPS): { valid: boolean; steps?: string[]; reason?: string } {
    if (typeof plan !== "string" || !plan.trim()) return { valid: false, reason: "The revised plan response was empty." };
    const steps = plan.split("\n").map((line) => line.trim())
        .filter((line) => /^\d+[.)]\s+/.test(line))
        .map((line) => line.replace(/^\d+[.)]\s+/, "").trim());
    if (steps.length === 0) return { valid: false, reason: "The revised plan must contain at least one numbered step." };
    if (steps.length > maxRevisedPlanSteps) return { valid: false, reason: `The revised plan has more than ${maxRevisedPlanSteps} steps.` };
    if (steps.some((step) => !step || /^(none|n\/?a|no action)$/i.test(step))) return { valid: false, reason: "The revised plan contains an empty or non-actionable step." };
    return { valid: true, steps };
}

/**
 * Render a step array into the numbered `1. step` plan listing used by the
 * execution and review prompts.
 */
export function formatPlan(steps: readonly string[]): string {
    return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

/**
 * Append an accepted suggested update onto a step's text as a trailing
 * `Update:` line.
 */
export function appendSuggestedUpdate(step: string, update: string): string {
    return `${step}\nUpdate: ${update.trim()}`;
}

export interface ExecutionFeedbackChange {
    localUpdate: { step: number; update: string } | null;
    planUpdates: { step: number; update: string }[];
    rejectedPlanUpdates: { step: number; update?: string; reason: string }[];
}

/**
 * Apply an execution-feedback entry's suggested updates onto the active steps
 * array in place, returning a summary of what was accepted and what was
 * rejected. A suggested update for the step just completed is folded into that
 * step; suggested updates for later remaining steps are folded into those
 * steps. Out-of-range or empty suggestions are rejected with a reason.
 */
export function applyExecutionFeedback(feedbackEntry: any, activeSteps: string[], completedStepCount: number): ExecutionFeedbackChange {
    const result: ExecutionFeedbackChange = { localUpdate: null, planUpdates: [], rejectedPlanUpdates: [] };
    if (!feedbackEntry?.valid || !feedbackEntry.feedback) return result;

    const feedback = feedbackEntry.feedback;
    if (feedback.suggestedStepUpdate?.trim()) {
        activeSteps[completedStepCount] = appendSuggestedUpdate(activeSteps[completedStepCount], feedback.suggestedStepUpdate);
        result.localUpdate = { step: completedStepCount + 1, update: feedback.suggestedStepUpdate };
    }

    for (const suggestion of feedback.suggestedPlanUpdates) {
        const targetIndex = suggestion.step - 1;
        if (targetIndex < completedStepCount + 1 || targetIndex >= activeSteps.length) {
            result.rejectedPlanUpdates.push({ ...suggestion, reason: "The target is not a remaining plan step." });
            continue;
        }
        if (!suggestion.update.trim()) {
            result.rejectedPlanUpdates.push({ ...suggestion, reason: "The update is empty." });
            continue;
        }
        activeSteps[targetIndex] = appendSuggestedUpdate(activeSteps[targetIndex], suggestion.update);
        result.planUpdates.push({ step: suggestion.step, update: suggestion.update });
    }
    return result;
}

/**
 * Count classifier-denial goals that reached the "fighting" threshold during
 * this run. `denialTrackerState` is the serialized DenialTracker (see
 * denial-tracker.ts): `{ goals: { goalKey: { count, lastTool, lastReason } } }`.
 * A goal counts as fighting once its consecutive-denial count reaches the
 * `denialReplanThreshold`.
 */
export function fightingDenialCount(configData: any, denialReplanThreshold: number): number {
    const goals = configData?.denialTrackerState?.goals ?? {};
    const values = typeof goals === "object" && !Array.isArray(goals) ? Object.values(goals) : [];
    return values.filter((goal: any) => goal && Number.isInteger(goal.count) && goal.count >= denialReplanThreshold).length;
}

/**
 * Report an execution-feedback entry through the injectable `status` reporter,
 * surfacing the step status, any findings, and whether a replan is recommended.
 */
export function reportExecutionFeedback(feedbackEntry: any, status: PlanHandlerReporter, hierarchyIndent: (level: "contentInStep") => string): void {
    const stepLabel = `Step ${feedbackEntry?.step ?? "unknown"}`;
    if (!feedbackEntry?.valid) {
        status.warning(`${stepLabel} feedback was retained as an execution note but not applied: ${feedbackEntry?.validationError ?? "unknown validation error"}`, hierarchyIndent("contentInStep"));
        return;
    }

    const feedback = feedbackEntry.feedback;
    status.feedback(`${stepLabel} status: ${feedback.stepStatus}. ${truncate(feedback.summary)}`, hierarchyIndent("contentInStep"));
    if (feedback.findings.length > 0) {
        status.feedback(`${stepLabel} findings: ${feedback.findings.map((finding: string) => truncate(finding, 160)).join("; ")}`, hierarchyIndent("contentInStep"));
    }
    if (feedback.replanRequired) {
        status.replan(`${stepLabel} recommends replanning: ${truncate(feedback.replanReason)}`, hierarchyIndent("contentInStep"));
    } else {
        status.replan(`${stepLabel} does not recommend replanning.`, hierarchyIndent("contentInStep"));
    }
}

/**
 * Report the result of `applyExecutionFeedback` through the injectable `status`
 * reporter: accepted local/remaining-step updates and any rejected suggestions.
 */
export function reportAppliedPlanChanges(appliedChanges: ExecutionFeedbackChange, status: PlanHandlerReporter, hierarchyIndent: (level: "contentInStep") => string): void {
    if (appliedChanges.localUpdate) {
        status.change(`Accepted local update for step ${appliedChanges.localUpdate.step}: ${truncate(appliedChanges.localUpdate.update)}`, hierarchyIndent("contentInStep"));
    }
    for (const update of appliedChanges.planUpdates) {
        status.change(`Accepted update for remaining step ${update.step}: ${truncate(update.update)}`, hierarchyIndent("contentInStep"));
    }
    for (const rejected of appliedChanges.rejectedPlanUpdates) {
        status.warning(`Skipped suggested update for step ${rejected.step}: ${rejected.reason}`, hierarchyIndent("contentInStep"));
    }
}
