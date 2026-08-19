/**
 * Planner prompt template logic.
 *
 * This module owns the *assembly* of the planner-facing LLM prompts: the
 * initial planning prompt (a user prompt plus the phase-aware planning suffix),
 * the phase-aware replanner prompt (focused revised-plan request), and the
 * review-plan prompt. The external prompt *templates* remain under
 * /elastic-agent/prompts/ (planning-suffix.txt, replan-prompt.txt) and are
 * supplied by the caller or resolved here; this module only composes them.
 *
 * All helpers are pure string constructors (no I/O, no side effects), so they
 * can be unit tested without booting the CLI or touching the filesystem.
 * `renderPrompt` is imported from ./prompt-builder.js (a leaf module) so no
 * circular import is introduced.
 */

import { renderPrompt } from "./prompt-builder.js";

/** Inputs consumed by `buildReplanPrompt`. */
export interface ReplanPromptInputs {
    readonly claudeInstructions: string;
    readonly completedWork: string;
    /** The validated execution-feedback object (see execution-feedback-format.txt). */
    readonly feedback: unknown;
    readonly toolFindings: string;
    /** Renders a step array into the numbered "1. step" plan listing. */
    readonly formatPlan: (steps: readonly string[]) => string;
    readonly remainingSteps: readonly string[];
    /** The current top-level plan phase, already stringified ("(none)" when absent). */
    readonly currentPhase: string;
}

/**
 * Build the initial planning prompt: the user-facing prompt followed by the
 * phase-aware planning suffix from prompts/planning-suffix.txt, which instructs
 * the model to return JSON (plan, optional top-level "phase", or abort).
 */
export function buildPlanningPrompt(prompt: string, planningSuffix: string): string {
    return `${prompt}\n\n${planningSuffix}`;
}

/**
 * Retry variant of the planning prompt, appended when the previous response was
 * not valid plan JSON. The parsing error is surfaced so the model can correct
 * only the malformed field instead of re-inventing the whole plan.
 */
export function buildPlanningRetryPrompt(
    planningPrompt: string,
    planParseFailure: string | null,
): string {
    return `${planningPrompt}\n\nThe previous response was not valid plan JSON. Here's the error: ${planParseFailure}. Please return either a valid plan JSON object or an abort object.`;
}

/**
 * Build the review-plan prompt: a goal plus the same phase-aware planning
 * suffix, so the model plans how to conduct the review using the same JSON
 * contract as ordinary planning.
 */
export function buildReviewPlanPrompt(reviewPlanGoal: string, planningSuffix: string): string {
    return `${reviewPlanGoal}\n\n${planningSuffix}`;
}

/**
 * Build the focused replanner prompt from prompts/replan-prompt.txt. The
 * template interpolates the completed work, current-step feedback, recent
 * tool-result summaries, the remaining steps, and the current phase so the
 * model can produce a phase-aware revised plan (a different "phase" restarts the
 * whole plan; in-phase edits replace only the remaining steps).
 */
export function buildReplanPrompt(
    replanPromptTemplate: string,
    inputs: ReplanPromptInputs,
): string {
    return renderPrompt(replanPromptTemplate, {
        claudeInstructions: inputs.claudeInstructions,
        completedWork: inputs.completedWork,
        feedback: inputs.feedback,
        toolFindings: inputs.toolFindings,
        formatPlan: inputs.formatPlan,
        remainingSteps: inputs.remainingSteps,
        currentPhase: inputs.currentPhase,
    });
}

/**
 * Retry variant of the replanner prompt, appended when the previous revised-plan
 * response was not valid JSON. The parsing error is surfaced so the model can
 * return valid JSON following the requested structure.
 */
export function buildReplanRetryPrompt(request: string, lastFailure: string): string {
    return `${request}\n\nThe previous revised plan response was not valid JSON. Here's the error: ${lastFailure}. Please return valid JSON following the requested structure.`;
}
