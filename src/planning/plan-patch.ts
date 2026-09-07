/**
 * Validated plan-patch representation for replanning.
 *
 * A plan patch describes a focused, reviewable change to a `PlanModel`: it can
 * add, modify, supersede, or cancel *pending* steps, each operation carrying a
 * required `reason` and optional `evidence`. A patch is validated against the
 * current model before application:
 *
 *   - `planId` must match the model and an optional `baseVersion` must match
 *     the model version, so a stale patch can never be applied silently.
 *   - Completed steps must form a prefix of the model and are preserved
 *     verbatim by application; no operation may target one.
 *   - Duplicate IDs (across the patch and against surviving steps), invalid
 *     dependency references, self-dependencies, and dependency cycles are
 *     rejected, including any that would be introduced by the patch itself.
 *
 * The module is intentionally pure and dependency-light. It never mutates its
 * inputs, never touches the runtime ledgers (`completedSteps`,
 * `executionAttempts`, attempt history), and returns a *new* `PlanModel` whose
 * completed prefix and plan identity are unchanged.
 */

import { extractJsonFromResponse } from "./prompt-parser.js";
import {
    DEFAULT_MAX_PLAN_STEPS,
    validatePlanModelDependencies,
    type PlanModel,
    type PlanStepId,
    type PlanStepModel,
} from "./plan-model.js";

/** The four operations a plan patch may apply to pending steps. */
export type PlanPatchOperationKind = "add" | "modify" | "supersede" | "cancel";

/** The maximum number of steps the patched model may contain. */
export const DEFAULT_MAX_PATCHED_PLAN_STEPS = DEFAULT_MAX_PLAN_STEPS;

/** Options accepted by plan-patch validation/application functions. */
export interface PlanPatchOptions {
    /** Maximum number of steps allowed in the patched model. Defaults to 50. */
    readonly maxSteps?: number;
}

/**
 * The model-authored fields of a step as they appear in an `add` or
 * `supersede` operation. This is exactly the shape src/planning/plan-model.ts owns, minus
 * runtime fields (which are never accepted here).
 */
export interface PlanStepModelSpec {
    /** Stable positive integer ID. Must be unique among surviving steps. */
    readonly id: PlanStepId;
    /** What the step must accomplish. */
    readonly objective: string;
    /** Expected artifact or result (may be empty). */
    readonly expectedArtifact: string;
    /** Non-empty, useful completion criteria. */
    readonly completionCriteria: string[];
    /** Stable IDs of steps that must be completed before this one. */
    readonly dependencies: PlanStepId[];
    /** Display-only summary. */
    readonly summary?: string;
    /** Display-only justification. */
    readonly justification?: string;
    /** Display-only details. */
    readonly details?: string;
}

/**
 * The allowed field updates for a `modify` operation. `id` is intentionally
 * absent: modify never changes a step's stable identity.
 */
export interface PlanStepUpdates {
    readonly objective?: string;
    readonly expectedArtifact?: string;
    readonly completionCriteria?: string[];
    readonly dependencies?: PlanStepId[];
    readonly summary?: string;
    readonly justification?: string;
    readonly details?: string;
}

interface PlanPatchOperationBase {
    readonly reason: string;
    readonly evidence: readonly unknown[];
}

/** A mutable step shape used only while assembling the patched step list. */
interface MutablePlanStep {
    id: PlanStepId;
    objective: string;
    expectedArtifact: string;
    completionCriteria: string[];
    dependencies: PlanStepId[];
    summary?: string;
    justification?: string;
    details?: string;
}

/** Introduce a new pending step, optionally positioned relative to one. */
export interface AddPlanPatchOperation extends PlanPatchOperationBase {
    readonly op: "add";
    readonly step: PlanStepModelSpec;
    readonly after?: PlanStepId;
    readonly before?: PlanStepId;
}

/** Update fields of an existing pending step while keeping its ID. */
export interface ModifyPlanPatchOperation extends PlanPatchOperationBase {
    readonly op: "modify";
    readonly stepId: PlanStepId;
    readonly updates: PlanStepUpdates;
}

/** Retire an existing pending step and replace it (same position) with a new ID. */
export interface SupersedePlanPatchOperation extends PlanPatchOperationBase {
    readonly op: "supersede";
    readonly stepId: PlanStepId;
    readonly replacement: PlanStepModelSpec;
}

/** Remove an existing pending step because it is no longer needed. */
export interface CancelPlanPatchOperation extends PlanPatchOperationBase {
    readonly op: "cancel";
    readonly stepId: PlanStepId;
}

export type PlanPatchOperation =
    | AddPlanPatchOperation
    | ModifyPlanPatchOperation
    | SupersedePlanPatchOperation
    | CancelPlanPatchOperation;

/** A validated plan patch: a non-empty, ordered list of operations. */
export interface PlanPatch {
    /** The plan this patch applies to. Must equal the current model's planId. */
    readonly planId: string;
    /** Optional base version the patch was authored against. */
    readonly baseVersion?: number;
    /** Overall, human-readable reason for the patch. */
    readonly reason: string;
    /** Optional new top-level phase; applied to the resulting model when set. */
    readonly phase?: string | number;
    /** Ordered operations, applied in sequence. */
    readonly operations: readonly PlanPatchOperation[];
}

/** Non-throwing result for `validatePlanPatch`. */
export type PlanPatchResult =
    | { readonly valid: true }
    | { readonly valid: false; readonly reason: string };

/** A summary of what a successfully applied patch changed. */
export interface AppliedPlanPatch {
    readonly patch: PlanPatch;
    readonly addedStepIds: readonly PlanStepId[];
    readonly modifiedStepIds: readonly PlanStepId[];
    readonly supersededStepIds: readonly PlanStepId[];
    readonly cancelledStepIds: readonly PlanStepId[];
    /** Completed steps preserved verbatim by the application. */
    readonly preservedCompletedStepIds: readonly PlanStepId[];
}

/** The result of a successful patch application. */
export interface PlanPatchApplication {
    readonly model: PlanModel;
    readonly applied: AppliedPlanPatch;
}

/** Non-throwing result for `tryApplyPlanPatch`. */
export type PlanPatchApplicationResult =
    | { readonly valid: true; readonly model: PlanModel; readonly applied: AppliedPlanPatch }
    | { readonly valid: false; readonly reason: string };

const OPERATION_KINDS = new Set<string>(["add", "modify", "supersede", "cancel"]);
const STEP_SPEC_KEYS = new Set<string>([
    "id",
    "objective",
    "expectedArtifact",
    "completionCriteria",
    "dependencies",
    "summary",
    "justification",
    "details",
]);
const UPDATE_KEYS = new Set<string>([
    "objective",
    "expectedArtifact",
    "completionCriteria",
    "dependencies",
    "summary",
    "justification",
    "details",
]);
const RUNTIME_FIELDS = new Set<string>(["status", "outcome", "verified", "evidence"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new Error(`Plan patch field '${field}' must be a non-empty string.`);
    return text;
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
        throw new Error(`Plan patch field '${field}' must be a string when present.`);
    }
    const text = value.trim();
    return text.length > 0 ? text : undefined;
}

function positiveInteger(value: unknown, field: string): number {
    const asNumber = typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
            ? Number(value.trim())
            : Number.NaN;
    if (!Number.isInteger(asNumber) || asNumber <= 0) {
        throw new Error(`Plan patch field '${field}' must be a positive integer.`);
    }
    return asNumber;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    return positiveInteger(value, field);
}

function requiredStringArray(value: unknown, field: string): string[] {
    const items = Array.isArray(value) ? value : [value];
    if (items.length === 0) {
        throw new Error(`Plan patch field '${field}' must contain at least one non-empty string.`);
    }
    return items.map((item, index) => {
        if (typeof item !== "string" || item.trim().length === 0) {
            throw new Error(`Plan patch field '${field}' must contain only non-empty strings (invalid item ${index + 1}).`);
        }
        return item.trim();
    });
}

function optionalDependencies(value: unknown, field: string): PlanStepId[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new Error(`Plan patch field '${field}' must be an array of step ids.`);
    }
    return value.map((dependency, index) => positiveInteger(dependency, `${field} item ${index + 1}`));
}

function optionalPhase(value: unknown): string | number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) throw new Error("Plan patch 'phase' must be a non-empty string or integer when present.");
        return trimmed;
    }
    if (typeof value === "number" && Number.isInteger(value)) return value;
    throw new Error("Plan patch 'phase' must be a non-empty string or integer when present.");
}

function optionalEvidence(value: unknown): readonly unknown[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new Error("Plan patch operation 'evidence' must be an array when present.");
    }
    return value.slice();
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            throw new Error(`${where} must not contain the field '${key}'.`);
        }
    }
}

function normalizeStepSpec(value: unknown, field: string): PlanStepModelSpec {
    if (!isRecord(value)) {
        throw new Error(`Plan patch field '${field}' must be an object.`);
    }
    assertOnlyKeys(value, STEP_SPEC_KEYS, `Plan patch field '${field}'`);
    for (const runtimeField of RUNTIME_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(value, runtimeField)) {
            throw new Error(`Plan patch field '${field}' must not contain the runtime-owned field '${runtimeField}'.`);
        }
    }
    const id = positiveInteger(value.id, `${field} 'id'`);
    const objective = requiredString(value.objective, `${field} 'objective'`);
    const expectedArtifact = typeof value.expectedArtifact === "string" ? value.expectedArtifact.trim() : "";
    const completionCriteria = requiredStringArray(value.completionCriteria, `${field} 'completionCriteria'`);
    const dependencies = optionalDependencies(value.dependencies, `${field} 'dependencies'`);
    return {
        id,
        objective,
        expectedArtifact,
        completionCriteria,
        dependencies,
        summary: optionalString(value.summary, `${field} 'summary'`),
        justification: optionalString(value.justification, `${field} 'justification'`),
        details: optionalString(value.details, `${field} 'details'`),
    };
}

function normalizeUpdates(value: unknown, field: string): PlanStepUpdates {
    if (!isRecord(value)) {
        throw new Error(`Plan patch field '${field}' must be an object.`);
    }
    const keys = Object.keys(value);
    if (keys.length === 0) {
        throw new Error(`Plan patch field '${field}' must provide at least one field to update.`);
    }
    assertOnlyKeys(value, UPDATE_KEYS, `Plan patch field '${field}'`);
    for (const runtimeField of RUNTIME_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(value, runtimeField)) {
            throw new Error(`Plan patch field '${field}' must not contain the runtime-owned field '${runtimeField}'.`);
        }
    }
    const updates: {
        objective?: string;
        expectedArtifact?: string;
        completionCriteria?: string[];
        dependencies?: PlanStepId[];
        summary?: string;
        justification?: string;
        details?: string;
    } = {};
    if (value.objective !== undefined) {
        updates.objective = requiredString(value.objective, `${field} 'objective'`);
    }
    if (value.expectedArtifact !== undefined) {
        if (typeof value.expectedArtifact !== "string") {
            throw new Error(`Plan patch field '${field} 'expectedArtifact'' must be a string when present.`);
        }
        updates.expectedArtifact = value.expectedArtifact.trim();
    }
    if (value.completionCriteria !== undefined) {
        updates.completionCriteria = requiredStringArray(value.completionCriteria, `${field} 'completionCriteria'`);
    }
    if (value.dependencies !== undefined) {
        updates.dependencies = optionalDependencies(value.dependencies, `${field} 'dependencies'`);
    }
    if (value.summary !== undefined) updates.summary = optionalString(value.summary, `${field} 'summary'`);
    if (value.justification !== undefined) updates.justification = optionalString(value.justification, `${field} 'justification'`);
    if (value.details !== undefined) updates.details = optionalString(value.details, `${field} 'details'`);
    return updates;
}

function normalizeOperation(value: unknown, index: number): PlanPatchOperation {
    if (!isRecord(value)) {
        throw new Error(`Plan patch operation ${index + 1} must be an object.`);
    }
    const op = requiredString(value.op, `operation ${index + 1} 'op'`);
    if (!OPERATION_KINDS.has(op)) {
        throw new Error(`Plan patch operation ${index + 1} 'op' must be one of add, modify, supersede, cancel.`);
    }
    const kind = op as PlanPatchOperationKind;
    const reason = requiredString(value.reason, `operation ${index + 1} 'reason'`);
    const evidence = optionalEvidence(value.evidence);

    if (kind === "add") {
        assertOnlyKeys(value, new Set(["op", "reason", "evidence", "step", "after", "before"]), `Plan patch operation ${index + 1}`);
        const step = normalizeStepSpec(value.step, `operation ${index + 1} 'step'`);
        const after = optionalPositiveInteger(value.after, `operation ${index + 1} 'after'`);
        const before = optionalPositiveInteger(value.before, `operation ${index + 1} 'before'`);
        if (after !== undefined && before !== undefined) {
            throw new Error(`Plan patch operation ${index + 1} must not specify both 'after' and 'before'.`);
        }
        return { op: kind, reason, evidence, step, after, before };
    }

    if (kind === "modify") {
        assertOnlyKeys(value, new Set(["op", "reason", "evidence", "stepId", "updates"]), `Plan patch operation ${index + 1}`);
        const stepId = positiveInteger(value.stepId, `operation ${index + 1} 'stepId'`);
        const updates = normalizeUpdates(value.updates, `operation ${index + 1} 'updates'`);
        return { op: kind, reason, evidence, stepId, updates };
    }

    if (kind === "supersede") {
        assertOnlyKeys(value, new Set(["op", "reason", "evidence", "stepId", "replacement"]), `Plan patch operation ${index + 1}`);
        const stepId = positiveInteger(value.stepId, `operation ${index + 1} 'stepId'`);
        const replacement = normalizeStepSpec(value.replacement, `operation ${index + 1} 'replacement'`);
        return { op: kind, reason, evidence, stepId, replacement };
    }

    assertOnlyKeys(value, new Set(["op", "reason", "evidence", "stepId"]), `Plan patch operation ${index + 1}`);
    const stepId = positiveInteger(value.stepId, `operation ${index + 1} 'stepId'`);
    return { op: kind, reason, evidence, stepId };
}

/**
 * Validate and normalize a raw plan-patch object into a `PlanPatch`. Throws a
 * descriptive `Error` when the object fails any structural invariant. This is
 * purely structural (field shapes and operation kinds); model-relative checks
 * (planId/version match, completed-step targeting, duplicate IDs, cycles, and
 * dependency references in the result) happen in `validatePlanPatch` /
 * `applyPlanPatch`.
 */
export function normalizePlanPatch(raw: unknown): PlanPatch {
    if (!isRecord(raw)) {
        throw new Error("Plan patch must be a JSON object.");
    }
    assertOnlyKeys(raw, new Set(["planId", "baseVersion", "reason", "phase", "operations"]), "Plan patch");

    const planId = requiredString(raw.planId, "planId");
    const baseVersion = optionalPositiveInteger(raw.baseVersion, "baseVersion");
    const reason = requiredString(raw.reason, "reason");
    const phase = optionalPhase(raw.phase);

    if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
        throw new Error("Plan patch 'operations' must be a non-empty array.");
    }
    const operations = raw.operations.map((operation, index) => normalizeOperation(operation, index));

    return {
        planId,
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        reason,
        ...(phase !== undefined ? { phase } : {}),
        operations,
    };
}

/**
 * Parse a plan-patch response (plain JSON or fenced ```json``` with prose) into
 * a normalized `PlanPatch`. Structural validation matches `normalizePlanPatch`.
 */
export function parsePlanPatch(text: string): PlanPatch {
    let extracted: string;
    try {
        extracted = extractJsonFromResponse(text);
    } catch (error) {
        throw new Error(`Plan patch JSON could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(extracted);
    } catch (error) {
        throw new Error(`Plan patch JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return normalizePlanPatch(parsed);
}

function toCompletedSet(completedStepIds: readonly PlanStepId[] | ReadonlySet<PlanStepId>): ReadonlySet<PlanStepId> {
    return completedStepIds instanceof Set ? completedStepIds : new Set(completedStepIds);
}

/**
 * Build the patched model, validating everything in one pass. This is the single
 * implementation shared by `validatePlanPatch`, `applyPlanPatch`, and
 * `tryApplyPlanPatch`. Throws a descriptive `Error` on the first violation and
 * never mutates `model` or `patch`.
 */
function buildPatchedModel(
    model: PlanModel,
    patch: PlanPatch,
    completedStepIds: readonly PlanStepId[] | ReadonlySet<PlanStepId>,
    options: PlanPatchOptions,
): PlanPatchApplication {
    const completed = toCompletedSet(completedStepIds);
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_PATCHED_PLAN_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
        throw new Error("Plan patch 'maxSteps' must be a positive integer.");
    }

    if (patch.planId !== model.planId) {
        throw new Error(`Plan patch targets plan '${patch.planId}' but the current model is '${model.planId}'.`);
    }
    if (patch.baseVersion !== undefined && patch.baseVersion !== model.version) {
        throw new Error(`Plan patch was authored against version ${patch.baseVersion} but the current model is version ${model.version}.`);
    }

    // Completed steps must be a prefix so application can preserve them in place
    // and every later step is safely pending.
    const existingIds = new Set<PlanStepId>();
    let prefixDone = false;
    for (const step of model.steps) {
        existingIds.add(step.id);
        if (completed.has(step.id)) {
            if (prefixDone) {
                throw new Error("Completed steps must form a prefix of the plan model; refusing to reorder completed work.");
            }
        } else {
            prefixDone = true;
        }
    }

    const completedSteps = model.steps.filter((step) => completed.has(step.id));
    const pending = model.steps.filter((step) => !completed.has(step.id));

    // Track IDs introduced and step IDs targeted by the patch so duplicate IDs
    // and duplicate targets are rejected before any step is rebuilt.
    const introducedIds = new Set<PlanStepId>();
    const targetedIds = new Set<PlanStepId>();
    for (const operation of patch.operations) {
        if (operation.op === "add") {
            const id = operation.step.id;
            if (existingIds.has(id) || introducedIds.has(id)) {
                throw new Error(`Plan patch would create a duplicate step id ${id}.`);
            }
            introducedIds.add(id);
            if (operation.after !== undefined && !pending.some((step) => step.id === operation.after)) {
                throw new Error(`Plan patch 'add' anchor 'after' references step ${operation.after}, which is not a pending step.`);
            }
            if (operation.before !== undefined && !pending.some((step) => step.id === operation.before)) {
                throw new Error(`Plan patch 'add' anchor 'before' references step ${operation.before}, which is not a pending step.`);
            }
            continue;
        }
        const target = operation.stepId;
        if (!existingIds.has(target)) {
            throw new Error(`Plan patch operation '${operation.op}' targets step ${target}, which does not exist.`);
        }
        if (completed.has(target)) {
            throw new Error(`Plan patch operation '${operation.op}' targets step ${target}, which is already completed.`);
        }
        if (targetedIds.has(target)) {
            throw new Error(`Plan patch targets step ${target} more than once.`);
        }
        targetedIds.add(target);
        if (operation.op === "supersede") {
            const replacementId = operation.replacement.id;
            if (replacementId === target || existingIds.has(replacementId) || introducedIds.has(replacementId)) {
                throw new Error(`Plan patch 'supersede' replacement id ${replacementId} must be a fresh, unique step id.`);
            }
            introducedIds.add(replacementId);
        }
    }

    // Apply operations to the mutable pending list, preserving completed steps.
    const addedStepIds: PlanStepId[] = [];
    const modifiedStepIds: PlanStepId[] = [];
    const supersededStepIds: PlanStepId[] = [];
    const cancelledStepIds: PlanStepId[] = [];
    const pendingSteps: MutablePlanStep[] = pending.map((step) => ({ ...step }));

    for (const operation of patch.operations) {
        if (operation.op === "add") {
            const added: MutablePlanStep = { ...operation.step };
            if (operation.after !== undefined) {
                const index = pendingSteps.findIndex((step) => step.id === operation.after);
                pendingSteps.splice(index + 1, 0, added);
            } else if (operation.before !== undefined) {
                const index = pendingSteps.findIndex((step) => step.id === operation.before);
                pendingSteps.splice(index, 0, added);
            } else {
                pendingSteps.push(added);
            }
            addedStepIds.push(operation.step.id);
            continue;
        }

        const index = pendingSteps.findIndex((step) => step.id === operation.stepId);
        if (index < 0) {
            // Unreachable after validation, but fail safely rather than silently.
            throw new Error(`Plan patch could not locate pending step ${operation.stepId} during application.`);
        }
        if (operation.op === "cancel") {
            pendingSteps.splice(index, 1);
            cancelledStepIds.push(operation.stepId);
            continue;
        }
        if (operation.op === "modify") {
            const merged: MutablePlanStep = { ...pendingSteps[index] };
            const updates = operation.updates;
            if (updates.objective !== undefined) merged.objective = updates.objective;
            if (updates.expectedArtifact !== undefined) merged.expectedArtifact = updates.expectedArtifact;
            if (updates.completionCriteria !== undefined) merged.completionCriteria = updates.completionCriteria;
            if (updates.dependencies !== undefined) merged.dependencies = updates.dependencies;
            if (updates.summary !== undefined) merged.summary = updates.summary;
            if (updates.justification !== undefined) merged.justification = updates.justification;
            if (updates.details !== undefined) merged.details = updates.details;
            pendingSteps[index] = merged;
            modifiedStepIds.push(operation.stepId);
            continue;
        }
        // supersede
        pendingSteps[index] = { ...operation.replacement };
        supersededStepIds.push(operation.stepId);
        addedStepIds.push(operation.replacement.id);
    }

    const resultSteps = [...completedSteps, ...pendingSteps];
    if (resultSteps.length > maxSteps) {
        throw new Error(`Plan patch result has ${resultSteps.length} steps, which exceeds the maximum of ${maxSteps}.`);
    }
    // Reject duplicate IDs, self-dependencies, dangling references, and cycles
    // that may only appear once the patch has been applied (for example a
    // cancelled step still referenced by a surviving dependency).
    validatePlanModelDependencies(resultSteps);

    const applied: AppliedPlanPatch = {
        patch,
        addedStepIds,
        modifiedStepIds,
        supersededStepIds,
        cancelledStepIds,
        preservedCompletedStepIds: completedSteps.map((step) => step.id),
    };

    const nextModel: PlanModel = {
        ...model,
        steps: resultSteps,
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
    };
    return { model: nextModel, applied };
}

/**
 * Validate a normalized patch against the current model and a set of completed
 * step IDs. Non-throwing: returns `{ valid: true }` or `{ valid: false, reason }`.
 * Rejects a mismatched planId/baseVersion, patches that target completed steps,
 * duplicate IDs, cycles, and invalid dependency references (including ones the
 * patch would introduce).
 */
export function validatePlanPatch(
    patch: PlanPatch,
    model: PlanModel,
    completedStepIds: readonly PlanStepId[] | ReadonlySet<PlanStepId>,
    options: PlanPatchOptions = {},
): PlanPatchResult {
    try {
        buildPatchedModel(model, patch, completedStepIds, options);
        return { valid: true };
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Apply a validated patch to the current model and return the new model plus an
 * applied summary. Throws a descriptive `Error` when the patch is invalid; use
 * `validatePlanPatch` first when a non-throwing check is needed. Completed steps
 * are preserved verbatim and the input model/patch are never mutated.
 */
export function applyPlanPatch(
    model: PlanModel,
    patch: PlanPatch,
    completedStepIds: readonly PlanStepId[] | ReadonlySet<PlanStepId>,
    options: PlanPatchOptions = {},
): PlanPatchApplication {
    return buildPatchedModel(model, patch, completedStepIds, options);
}

/** Non-throwing wrapper around `applyPlanPatch`. */
export function tryApplyPlanPatch(
    model: PlanModel,
    patch: PlanPatch,
    completedStepIds: readonly PlanStepId[] | ReadonlySet<PlanStepId>,
    options: PlanPatchOptions = {},
): PlanPatchApplicationResult {
    try {
        const { model: nextModel, applied } = buildPatchedModel(model, patch, completedStepIds, options);
        return { valid: true, model: nextModel, applied };
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
