/**
 * Replan decision parsing and plan-patch application helpers.
 *
 * attemptReplan in main.ts used to parse a revised `steps` array and splice
 * the rendered step strings in place, clearing the completion ledger when the
 * replanner proposed a different top-level phase. This module replaces that
 * with a validated plan-patch pipeline:
 *
 *   - parseReplanDecision accepts either the structured plan-patch shape
 *     (`planId` + `operations`) or the legacy `steps`/`abort` replan shape.
 *   - patchFromRevisedSteps converts a legacy `steps` response into an
 *     equivalent PlanPatch that preserves the verified (succeeded) prefix and
 *     replaces every later pending step.
 *   - succeededStepIdsFromLedger derives the contiguous succeeded prefix from
 *     the runtime completion ledger, which is the set plan-patch application
 *     must preserve verbatim.
 *   - computeReplanProgress measures whether an applied patch made progress by
 *     comparing pending objective/criterion coverage and looking for new
 *     operation evidence, rather than comparing rendered step strings.
 *
 * Everything here is pure (no I/O, no globals) so replan behavior can be
 * exercised with fake clients without booting the CLI.
 */

import { extractJsonFromResponse, type PlanPhase } from "../plan-printer.js";
import {
    normalizePlanPatch,
    type PlanPatch,
    type PlanPatchOperation,
} from "../plan-patch.js";
import type { PlanModel, PlanStepId, PlanStepModel } from "../plan-model.js";
import { parseReplanResponse } from "./replan-abort.js";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed form of a replan response, before model-relative validation. */
export type ReplanDecision =
    | { readonly valid: false; readonly reason: string }
    | { readonly valid: true; readonly kind: "abort"; readonly reason: string }
    | { readonly valid: true; readonly kind: "patch"; readonly patch: PlanPatch }
    | { readonly valid: true; readonly kind: "steps"; readonly steps: string[]; readonly phase?: PlanPhase };

/**
 * Parse one replan response into a normalized decision. A structured
 * plan-patch (an object carrying an `operations` array) takes precedence over
 * the legacy `steps`/`abort` shape so the replanner can express add/modify/
 * supersede/cancel operations directly; otherwise the legacy parser handles
 * the historical revised-steps contract unchanged.
 */
export function parseReplanDecision(text: string): ReplanDecision {
    let extracted: string | null = null;
    try {
        extracted = extractJsonFromResponse(text);
    } catch {
        extracted = null;
    }
    if (extracted !== null) {
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(extracted);
        } catch {
            parsed = null;
        }
        if (isRecord(parsed) && Array.isArray(parsed.operations)) {
            try {
                return { valid: true, kind: "patch", patch: normalizePlanPatch(parsed) };
            } catch (error) {
                return { valid: false, reason: error instanceof Error ? error.message : String(error) };
            }
        }
    }
    const legacy = parseReplanResponse(text);
    if (!legacy.valid) return { valid: false, reason: legacy.reason };
    if (legacy.abort) return { valid: true, kind: "abort", reason: legacy.reason };
    return {
        valid: true,
        kind: "steps",
        steps: legacy.steps,
        ...(legacy.phase !== undefined ? { phase: legacy.phase } : {}),
    };
}

/**
 * Derive the contiguous verified (succeeded) prefix of the model from the
 * runtime completion ledger. Plan-patch application preserves exactly this
 * prefix; failed/blocked/invalid/non-terminal steps stop the prefix so a
 * replan can revise or retry them instead of leaving them permanently
 * unresolved.
 */
export function succeededStepIdsFromLedger(
    model: PlanModel,
    completedSteps: readonly unknown[],
): Set<PlanStepId> {
    const succeeded = new Set<PlanStepId>();
    for (const entry of completedSteps) {
        if (!isRecord(entry)) continue;
        if (entry.outcome !== "succeeded") continue;
        let id: number | undefined;
        if (Number.isInteger(entry.stepId) && (entry.stepId as number) > 0) {
            id = entry.stepId as number;
        } else if (Number.isInteger(entry.step) && (entry.step as number) > 0) {
            id = model.steps[(entry.step as number) - 1]?.id;
        }
        if (id !== undefined) succeeded.add(id);
    }
    // Plan-patch application requires completed steps to form a prefix of the
    // model. Only the contiguous verified prefix is preserved; the first step
    // that is not recorded as succeeded (or is recorded as a failure) stops
    // the prefix so the replan can replace it and everything after it.
    const prefix = new Set<PlanStepId>();
    for (const step of model.steps) {
        if (succeeded.has(step.id)) prefix.add(step.id);
        else break;
    }
    return prefix;
}

const SYNTHESIZED_COMPLETION_CRITERIA = "The revised step is completed and its result is verified.";

/**
 * Convert a legacy `steps` replan response into an equivalent PlanPatch:
 * cancel every pending step after the preserved prefix and add fresh steps for
 * each revised string. Completed steps are preserved verbatim by the patch
 * application and the resulting model carries the optional top-level phase.
 */
export function patchFromRevisedSteps(
    model: PlanModel,
    preservedStepIds: ReadonlySet<PlanStepId>,
    revisedSteps: readonly string[],
    phase?: PlanPhase,
): PlanPatch {
    const pending = model.steps.filter((step) => !preservedStepIds.has(step.id));
    const startId = model.steps.reduce((max, step) => Math.max(max, step.id), 0) + 1;
    const operations: PlanPatchOperation[] = [];
    for (const step of pending) {
        operations.push({
            op: "cancel",
            stepId: step.id,
            reason: "Focused replan replaced the remaining work.",
            evidence: [],
        });
    }
    revisedSteps.forEach((text, index) => {
        const objective = String(text ?? "").trim();
        operations.push({
            op: "add",
            step: {
                id: startId + index,
                objective: objective.length > 0 ? objective : `Revised plan step ${startId + index}`,
                expectedArtifact: "",
                completionCriteria: [SYNTHESIZED_COMPLETION_CRITERIA],
                dependencies: [],
            },
            reason: "Focused replan added a revised remaining step.",
            evidence: [],
        });
    });
    return {
        planId: model.planId,
        baseVersion: model.version,
        reason: "Focused replan",
        ...(phase !== undefined ? { phase } : {}),
        operations,
    };
}

function canonicalText(value: string): string {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function canonicalStepCoverage(step: PlanStepModel): string {
    return [step.objective, ...step.completionCriteria].map(canonicalText).join("\u0000");
}

function canonicalPendingCoverage(model: PlanModel, preservedStepIds: ReadonlySet<PlanStepId>): string {
    return model.steps
        .filter((step) => !preservedStepIds.has(step.id))
        .map((step) => canonicalStepCoverage(step))
        .join("\n");
}

/** Progress signal for one accepted replan. */
export interface ReplanProgress {
    /** True when the replan advanced the remaining work or added evidence. */
    readonly progressed: boolean;
    /** True when the pending objective/criterion coverage actually changed. */
    readonly coverageChanged: boolean;
    /** True when the patch carried at least one operation with new evidence. */
    readonly newEvidence: boolean;
    /** Human-readable explanation for the progress decision. */
    readonly reason: string;
}

/**
 * Measure whether an applied patch made progress. Progress is computed from
 * the pending objective/criterion coverage of the model plus new evidence on
 * the patch operations, instead of comparing rendered step strings (which
 * treats paraphrases as progress forever).
 */
export function computeReplanProgress(
    before: PlanModel,
    after: PlanModel,
    preservedStepIds: ReadonlySet<PlanStepId>,
    patch?: PlanPatch,
): ReplanProgress {
    const coverageChanged =
        canonicalPendingCoverage(before, preservedStepIds) !== canonicalPendingCoverage(after, preservedStepIds);
    const newEvidence = Boolean(
        patch && patch.operations.some((operation) => Array.isArray(operation.evidence) && operation.evidence.length > 0),
    );
    const progressed = coverageChanged || newEvidence;
    return {
        progressed,
        coverageChanged,
        newEvidence,
        reason: coverageChanged
            ? "pending objective/criterion coverage changed"
            : newEvidence
                ? "the patch introduced new evidence"
                : "pending objective/criterion coverage and evidence are unchanged",
    };
}
