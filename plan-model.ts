/**
 * Versioned structured plan model.
 *
 * This module owns the *model-authored intent* of a plan: plan identity and
 * version, goal, scope, steps (stable positive integer IDs, objectives,
 * expected artifacts/results, completion criteria, and dependencies), and
 * overall acceptance criteria. Runtime-owned state and evidence (attempt
 * history, outcomes, verification evidence) deliberately live OUTSIDE this
 * model — see `PlanRuntimeState` / `StepEvidenceReference` below and the
 * execution ledgers in main.ts. The model must never be able to mark a step
 * verified by returning a `status`/`outcome`/`verified`/`evidence` field; such
 * fields are rejected during normalization.
 *
 * The module is intentionally pure and dependency-free. Rendering to strings
 * happens only for prompts/display and is separated from the structured object,
 * which remains the source of truth during execution.
 */

/** The schema version emitted by this module. */
export const PLAN_MODEL_SCHEMA_VERSION = 1 as const;

/** Default initial step-count bound, mirrored with the revised-plan bound. */
export const DEFAULT_MAX_PLAN_STEPS = 50;

/** A stable, unique, positive integer step ID. */
export type PlanStepId = number;

/** One step of model-authored plan intent. */
export interface PlanStepModel {
    /** Stable positive integer ID. */
    readonly id: PlanStepId;
    /** What the step must accomplish. */
    readonly objective: string;
    /** The expected artifact or result produced by the step (may be empty). */
    readonly expectedArtifact: string;
    /** Non-empty, useful criteria that must hold for the step to be complete. */
    readonly completionCriteria: string[];
    /** Stable IDs of steps that must be completed before this one. */
    readonly dependencies: PlanStepId[];
    /** Legacy display-only summary (`tldr`), retained for readability. */
    readonly summary?: string;
    /** Legacy display-only justification, retained for readability. */
    readonly justification?: string;
    /** Legacy display-only details, retained for readability. */
    readonly details?: string;
}

/** The structured, model-authored plan intent. */
export interface PlanModel {
    readonly schemaVersion: typeof PLAN_MODEL_SCHEMA_VERSION;
    readonly planId: string;
    readonly version: number;
    readonly goal: string;
    readonly scope: string;
    readonly steps: PlanStepModel[];
    readonly acceptanceCriteria: string[];
    /** Optional top-level phase, only for very-high-complexity plans. */
    readonly phase?: string | number;
    /** True when the model was migrated from a legacy `step_number` plan. */
    readonly legacy?: boolean;
}

/** Options accepted by plan-model normalization/parsing functions. */
export interface PlanModelParseOptions {
    /** Maximum number of steps allowed in an initial plan. Defaults to 50. */
    readonly maxSteps?: number;
    /** When true, a top-level `phase` is required (very-high complexity). */
    readonly requirePhase?: boolean;
}

/** Non-throwing result for extracting/parsing a plan model. */
export type PlanModelResult =
    | { readonly valid: true; readonly model: PlanModel }
    | { readonly valid: false; readonly reason: string };

/**
 * Runtime-owned state and evidence, kept separate from `PlanModel`. This shape
 * is intentionally small and will be enriched by the durable run-state work;
 * execution code never writes these values into the model-authored plan.
 */
export interface StepEvidenceReference {
    readonly stepId: PlanStepId;
    readonly attemptId?: string;
    readonly feedbackResponseId?: string;
    readonly evidence?: unknown;
    readonly recordedAt?: string;
}

/** Runtime-owned plan execution state. */
export interface PlanRuntimeState {
    readonly activeStepId: PlanStepId | null;
    readonly attemptId: string | null;
    readonly completedStepIds: PlanStepId[];
    readonly evidenceReferences: StepEvidenceReference[];
}

/** Create an empty runtime plan state. */
export function createPlanRuntimeState(): PlanRuntimeState {
    return {
        activeStepId: null,
        attemptId: null,
        completedStepIds: [],
        evidenceReferences: [],
    };
}

const RUNTIME_PLAN_FIELDS = new Set(["status", "outcome", "completedSteps", "executionAttempts", "evidence"]);
const RUNTIME_STEP_FIELDS = new Set(["status", "outcome", "verified", "evidence"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null || value === undefined) return "";
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? "" : serialized;
    } catch {
        return String(value);
    }
}

function optionalString(value: unknown): string | null {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (value === undefined || value === null) return null;
    const s = stringify(value).trim();
    return s.length > 0 ? s : null;
}

function requiredString(value: unknown, field: string): string {
    const s = optionalString(value);
    if (s === null) throw new Error(`Plan model field '${field}' must be a non-empty string.`);
    return s;
}

function requiredPositiveInteger(value: unknown, field: string): number {
    const asNumber = typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
            ? Number(value.trim())
            : Number.NaN;
    if (!Number.isInteger(asNumber) || asNumber <= 0) {
        throw new Error(`Plan model field '${field}' must be a positive integer.`);
    }
    return asNumber;
}

function requiredStringArray(value: unknown, field: string): string[] {
    const items = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
    if (items.length === 0) {
        throw new Error(`Plan model field '${field}' must contain at least one non-empty string.`);
    }
    return items.map((item, index) => {
        if (typeof item !== "string" || item.trim().length === 0) {
            throw new Error(`Plan model field '${field}' must contain only non-empty strings (invalid item ${index + 1}).`);
        }
        return item.trim();
    });
}

function optionalStringArray(value: unknown, field: string): string[] | null {
    if (value === undefined || value === null) return null;
    const items = Array.isArray(value) ? value : [value];
    const normalized: string[] = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (typeof item !== "string" || item.trim().length === 0) {
            throw new Error(`Plan model field '${field}' must contain only non-empty strings (invalid item ${index + 1}).`);
        }
        normalized.push(item.trim());
    }
    return normalized.length > 0 ? normalized : null;
}

function assertNoRuntimeFields(record: Record<string, unknown>, forbidden: Set<string>, where: string): void {
    for (const field of forbidden) {
        if (Object.prototype.hasOwnProperty.call(record, field)) {
            throw new Error(`${where} must not contain the runtime-owned field '${field}'.`);
        }
    }
}

function normalizePhaseValue(value: unknown): string | number {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            throw new Error("Planning response 'phase' must be a non-empty string or integer when present.");
        }
        return trimmed;
    }
    if (typeof value === "number" && Number.isInteger(value)) {
        return value;
    }
    throw new Error("Planning response 'phase' must be a non-empty string or integer when present.");
}

function normalizePhaseField(record: Record<string, unknown>, requirePhase: boolean | undefined): string | number | undefined {
    const present = Object.prototype.hasOwnProperty.call(record, "phase") && record.phase !== undefined;
    if (!present) {
        if (requirePhase === true) {
            throw new Error("A very-high-complexity plan must include a top-level 'phase' field.");
        }
        return undefined;
    }
    return normalizePhaseValue(record.phase);
}

/**
 * True when `value` is already a normalized `PlanModel`.
 */
export function isPlanModel(value: unknown): value is PlanModel {
    if (!isRecord(value)) return false;
    if (value.schemaVersion !== PLAN_MODEL_SCHEMA_VERSION) return false;
    if (typeof value.planId !== "string" || typeof value.goal !== "string") return false;
    if (!Array.isArray(value.steps)) return false;
    return value.steps.every((step) => isRecord(step) && typeof step.id === "number" && typeof step.objective === "string");
}

/**
 * True when a raw JSON object looks like the structured plan schema rather than
 * the legacy `step_number` schema. Detection is intentionally conservative so
 * legacy plans that happen to carry a `planId` still take the legacy adapter.
 */
export function looksLikeStructuredPlan(value: unknown): boolean {
    if (!isRecord(value)) return false;
    if (!Array.isArray(value.steps) || value.steps.length === 0) return false;
    const firstStep = value.steps[0];
    if (isRecord(firstStep)) {
        if (Object.prototype.hasOwnProperty.call(firstStep, "id")
            || Object.prototype.hasOwnProperty.call(firstStep, "objective")
            || Object.prototype.hasOwnProperty.call(firstStep, "completionCriteria")
            || Object.prototype.hasOwnProperty.call(firstStep, "dependencies")) {
            return true;
        }
    }
    return typeof value.planId === "string" && Array.isArray(value.acceptanceCriteria);
}

function normalizeStep(step: unknown, index: number, usedIds: Set<number>): PlanStepModel {
    if (!isRecord(step)) {
        throw new Error(`Plan step ${index + 1} must be an object.`);
    }
    assertNoRuntimeFields(step, RUNTIME_STEP_FIELDS, `Plan step ${index + 1}`);

    const id = requiredPositiveInteger(step.id, `plan step ${index + 1} 'id'`);
    if (usedIds.has(id)) {
        throw new Error(`Plan step ids must be unique; duplicate id ${id}.`);
    }
    usedIds.add(id);

    const objective = requiredString(step.objective, `plan step ${id} 'objective'`);
    const expectedArtifactValue = step.expectedArtifact ?? step.expectedResult ?? step.expected_artifact ?? step.expected_result;
    const expectedArtifact = optionalString(expectedArtifactValue) ?? "";
    const completionCriteriaValue = step.completionCriteria ?? step.completion_criteria;
    const completionCriteria = requiredStringArray(completionCriteriaValue, `plan step ${id} 'completionCriteria'`);
    const dependencies = normalizeDependencies(step.dependencies, id);

    return {
        id,
        objective,
        expectedArtifact,
        completionCriteria,
        dependencies,
        summary: optionalString(step.summary) ?? undefined,
        justification: optionalString(step.justification) ?? undefined,
        details: optionalString(step.details) ?? undefined,
    };
}

function normalizeDependencies(value: unknown, stepId: number): number[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new Error(`Plan step ${stepId} 'dependencies' must be an array of step ids.`);
    }
    return value.map((dependency, index) => requiredPositiveInteger(dependency, `plan step ${stepId} 'dependencies' item ${index + 1}`));
}

function assertDependencyReferencesAndCycles(steps: readonly PlanStepModel[]): void {
    const ids = new Set(steps.map((step) => step.id));
    for (const step of steps) {
        for (const dependency of step.dependencies) {
            if (!ids.has(dependency)) {
                throw new Error(`Plan step ${step.id} depends on missing step ${dependency}.`);
            }
            if (dependency === step.id) {
                throw new Error(`Plan step ${step.id} must not depend on itself.`);
            }
        }
    }

    const state = new Map<number, 0 | 1 | 2>();
    const visit = (id: number): void => {
        const current = state.get(id) ?? 0;
        if (current === 2) return;
        if (current === 1) {
            throw new Error(`Plan step dependencies contain a cycle involving step ${id}.`);
        }
        state.set(id, 1);
        const step = steps.find((candidate) => candidate.id === id);
        if (!step) throw new Error(`Plan step ${id} is missing from the dependency graph.`);
        for (const dependency of step.dependencies) visit(dependency);
        state.set(id, 2);
    };
    for (const step of steps) visit(step.id);
}

/**
 * Validate that a step list has unique IDs, every dependency references a
 * present step, no step depends on itself, and the dependency graph is
 * acyclic. Shared by `normalizePlanModel`/`legacyPlanToModel` and the plan
 * patch application logic so replan patches are held to the same invariants
 * as initial plans. Throws a descriptive `Error` on the first violation.
 */
export function validatePlanModelDependencies(steps: readonly PlanStepModel[]): void {
    const ids = new Set<number>();
    for (const step of steps) {
        if (ids.has(step.id)) {
            throw new Error(`Plan step ids must be unique; duplicate id ${step.id}.`);
        }
        ids.add(step.id);
    }
    assertDependencyReferencesAndCycles(steps);
}

/**
 * Validate and normalize a raw structured plan object into a `PlanModel`.
 * Throws a descriptive `Error` when the object fails any invariant.
 */
export function normalizePlanModel(raw: unknown, options: PlanModelParseOptions = {}): PlanModel {
    if (!isRecord(raw)) {
        throw new Error("Plan model JSON must be an object.");
    }
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_PLAN_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
        throw new Error("Plan model 'maxSteps' must be a positive integer.");
    }
    assertNoRuntimeFields(raw, RUNTIME_PLAN_FIELDS, "Plan model");

    const planId = requiredString(raw.planId, "planId");
    const version = requiredPositiveInteger(raw.version, "version");
    const goal = requiredString(raw.goal, "goal");
    const scope = optionalString(raw.scope) ?? "";
    const acceptanceCriteria = requiredStringArray(raw.acceptanceCriteria, "acceptanceCriteria");

    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
        throw new Error("Plan model 'steps' must be a non-empty array.");
    }
    if (raw.steps.length > maxSteps) {
        throw new Error(`Plan model has ${raw.steps.length} steps, which exceeds the maximum of ${maxSteps}.`);
    }

    const usedIds = new Set<number>();
    const steps = raw.steps.map((step, index) => normalizeStep(step, index, usedIds));
    assertDependencyReferencesAndCycles(steps);

    const phase = normalizePhaseField(raw, options.requirePhase);

    return {
        schemaVersion: PLAN_MODEL_SCHEMA_VERSION,
        planId,
        version,
        goal,
        scope,
        steps,
        acceptanceCriteria,
        phase,
    };
}

function legacyGoal(raw: Record<string, unknown>): string {
    return optionalString(raw.goal) ?? optionalString(raw.tldr) ?? "Legacy plan";
}

function legacyCriteria(value: unknown): string[] | null {
    if (value === undefined || value === null) return null;
    const items = Array.isArray(value) ? value : [value];
    const normalized = items
        .map((item) => {
            if (typeof item === "string") return item.trim();
            const s = stringify(item).trim();
            return s.length > 0 ? s : "";
        })
        .filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized : null;
}

function legacyStepId(step: Record<string, unknown>, index: number, usedIds: Set<number>): number {
    let candidate: number | null = null;
    if (typeof step.step_number === "number" && Number.isInteger(step.step_number) && step.step_number > 0) {
        candidate = step.step_number;
    } else if (typeof step.step_number === "string" && /^\d+$/.test(step.step_number.trim())) {
        const numeric = Number(step.step_number.trim());
        if (Number.isInteger(numeric) && numeric > 0) candidate = numeric;
    }
    if (candidate !== null && !usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
    }
    let fallback = index + 1;
    while (usedIds.has(fallback)) fallback += 1;
    usedIds.add(fallback);
    return fallback;
}

/**
 * Migrate a legacy `{ step_number, tldr, justification, details }` plan object
 * into the structured model. Legacy plans remain readable during migration:
 * valid `step_number` values become unique positive integer IDs, missing or
 * duplicate numbers are replaced with fresh positive IDs, and the legacy
 * display fields are retained for prompt/display rendering.
 */
export function legacyPlanToModel(raw: unknown, options: PlanModelParseOptions = {}): PlanModel {
    if (!isRecord(raw)) {
        throw new Error("Legacy plan must be a JSON object.");
    }
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_PLAN_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
        throw new Error("Plan model 'maxSteps' must be a positive integer.");
    }
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
        throw new Error("Legacy plan 'steps' must be a non-empty array.");
    }
    if (raw.steps.length > maxSteps) {
        throw new Error(`Legacy plan has ${raw.steps.length} steps, which exceeds the maximum of ${maxSteps}.`);
    }

    const goal = legacyGoal(raw);
    const acceptanceCriteria = legacyCriteria(raw.acceptanceCriteria ?? raw.expected_outcome) ?? ["Complete the legacy plan successfully."];
    const version = typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version > 0
        ? raw.version
        : 1;
    const planId = optionalString(raw.planId) ?? `legacy-plan-${version}`;
    const scope = optionalString(raw.scope) ?? "";

    const usedIds = new Set<number>();
    const steps = raw.steps.map((step, index) => {
        if (!isRecord(step)) {
            throw new Error(`Legacy plan step ${index + 1} must be an object.`);
        }
        const id = legacyStepId(step, index, usedIds);
        const objective = optionalString(step.objective) ?? optionalString(step.tldr) ?? `Execute legacy step ${index + 1}.`;
        const expectedArtifact = optionalString(step.expectedArtifact ?? step.expectedResult ?? step.expected_artifact ?? step.expected_result ?? step.details) ?? "";
        const completionCriteria = optionalStringArray(step.completionCriteria ?? step.completion_criteria, `legacy plan step ${id} 'completionCriteria'`)
            ?? [`Complete step ${id}: ${objective}`];
        const dependencies = Array.isArray(step.dependencies)
            ? step.dependencies.map((dependency, dependencyIndex) => requiredPositiveInteger(dependency, `legacy plan step ${id} 'dependencies' item ${dependencyIndex + 1}`))
            : [];

        return {
            id,
            objective,
            expectedArtifact,
            completionCriteria,
            dependencies,
            summary: optionalString(step.summary ?? step.tldr) ?? undefined,
            justification: optionalString(step.justification) ?? undefined,
            details: optionalString(step.details) ?? undefined,
        };
    });

    assertDependencyReferencesAndCycles(steps);

    const phase = normalizePhaseField(raw, options.requirePhase);

    return {
        schemaVersion: PLAN_MODEL_SCHEMA_VERSION,
        planId,
        version,
        goal,
        scope,
        steps,
        acceptanceCriteria,
        phase,
        legacy: true,
    };
}

/**
 * Return `plan` unchanged when it is already a `PlanModel`, otherwise migrate
 * it through the legacy adapter. This is the single coercion point used by
 * main.ts to retain a structured object as the source of truth for both new
 * and legacy planning responses.
 */
export function planModelFromPlan(plan: unknown, options: PlanModelParseOptions = {}): PlanModel {
    if (isPlanModel(plan)) return plan;
    return legacyPlanToModel(plan, options);
}

/**
 * Render a structured plan's steps into strings for prompts/display. The
 * structured object remains the source of truth; this output is never parsed
 * back as the authoritative plan.
 */
export function planStepsFromModel(model: PlanModel): string[] {
    return model.steps.map((step) => {
        const parts = [step.objective];
        if (step.expectedArtifact.length > 0) {
            parts.push(`Expected artifact/result: ${step.expectedArtifact}`);
        }
        if (step.completionCriteria.length > 0) {
            parts.push(`Completion criteria: ${step.completionCriteria.join("; ")}`);
        }
        return parts.join(" — ");
    });
}

/**
 * Resolve a stable step ID to its zero-based execution index in `model.steps`.
 * Returns -1 when the ID is absent. Execution keeps the rendered step strings
 * for prompts/display, but this mapping is what ties a running step back to
 * its model-authored identity.
 */
export function planModelStepIndexById(model: PlanModel, stepId: PlanStepId): number {
    for (let index = 0; index < model.steps.length; index += 1) {
        if (model.steps[index].id === stepId) return index;
    }
    return -1;
}

/** Resolve the stable step ID at a zero-based execution index (null when absent). */
export function planModelStepIdByIndex(model: PlanModel, index: number): PlanStepId | null {
    if (!Number.isInteger(index) || index < 0 || index >= model.steps.length) return null;
    return model.steps[index].id;
}

/** Resolve a plan step by stable ID (null when absent). */
export function planModelStepById(model: PlanModel, stepId: PlanStepId): PlanStepModel | null {
    const index = planModelStepIndexById(model, stepId);
    return index >= 0 ? model.steps[index] : null;
}

/** Return a copy of the completion criteria for a stable step ID ([] when absent). */
export function planModelCriteriaById(model: PlanModel, stepId: PlanStepId): string[] {
    const step = planModelStepById(model, stepId);
    return step ? step.completionCriteria.slice() : [];
}

/** Return every stable step ID in model order. */
export function planModelStepIds(model: PlanModel): PlanStepId[] {
    return model.steps.map((step) => step.id);
}

/** Derive a fresh positive step ID larger than every ID in the model. */
function freshPlanStepIdStart(model: PlanModel): number {
    return model.steps.reduce((max, step) => Math.max(max, step.id), 0) + 1;
}

/** Build a valid replacement step from a rendered string plus a fresh ID. */
function synthesizedPlanStep(id: PlanStepId, text: string): PlanStepModel {
    const objective = text.trim().length > 0 ? text.trim() : `Revised plan step ${id}`;
    return {
        id,
        objective,
        expectedArtifact: "",
        completionCriteria: [`Step ${id} is completed and verified as described.`],
        dependencies: [],
        summary: undefined,
        justification: undefined,
        details: undefined,
    };
}

/**
 * Return a new `PlanModel` that preserves the first `keepCount` steps exactly
 * — their stable IDs and completion criteria survive — and replaces every later
 * step with fresh, uniquely-identified steps built from the supplied rendered
 * strings. Used by focused replans while revised plans still arrive as
 * rendered steps; the structured object stays the execution source of truth.
 */
export function replacePlanModelRemainingSteps(
    model: PlanModel,
    keepCount: number,
    revisedStepTexts: readonly string[],
): PlanModel {
    if (!Number.isInteger(keepCount) || keepCount < 0) {
        throw new Error("Plan model 'keepCount' must be a non-negative integer.");
    }
    const keptCount = Math.min(keepCount, model.steps.length);
    const kept = model.steps.slice(0, keptCount);
    const startId = freshPlanStepIdStart(model);
    const replacements = revisedStepTexts.map((text, index) =>
        synthesizedPlanStep(startId + index, String(text ?? "")));
    return { ...model, steps: [...kept, ...replacements] };
}

/**
 * Return a new `PlanModel` whose step list is entirely rebuilt from rendered
 * strings with fresh stable IDs, optionally moving into a new top-level phase.
 * Plan identity (planId), version, goal, scope, and acceptance criteria are
 * preserved. Used by the legacy phase-changing replan path, which replaces the
 * whole plan and restarts execution from the first step.
 */
export function rebuildPlanModelSteps(
    model: PlanModel,
    revisedStepTexts: readonly string[],
    nextPhase?: string | number,
): PlanModel {
    const startId = freshPlanStepIdStart(model);
    const steps = revisedStepTexts.map((text, index) =>
        synthesizedPlanStep(startId + index, String(text ?? "")));
    return {
        ...model,
        steps,
        phase: nextPhase !== undefined ? nextPhase : model.phase,
    };
}

/**
 * Render one step object (string, legacy step, or structured step) into a
 * single display string. Used by replan parsing while revised plans still
 * produce string steps for the execution loop.
 */
export function planStepDisplayString(step: unknown): string {
    if (typeof step === "string") return step.trim();
    if (!isRecord(step)) return "";
    if (Object.prototype.hasOwnProperty.call(step, "id") || Object.prototype.hasOwnProperty.call(step, "objective")) {
        const objective = optionalString(step.objective) ?? optionalString(step.tldr) ?? "";
        const expectedArtifact = optionalString(step.expectedArtifact ?? step.expectedResult ?? step.expected_artifact ?? step.expected_result) ?? "";
        const criteria = optionalStringArray(step.completionCriteria ?? step.completion_criteria, "replan step 'completionCriteria'") ?? [];
        const parts = [objective];
        if (expectedArtifact.length > 0) parts.push(`Expected artifact/result: ${expectedArtifact}`);
        if (criteria.length > 0) parts.push(`Completion criteria: ${criteria.join("; ")}`);
        return parts.filter(Boolean).join(" — ");
    }
    const tldr = optionalString(step.tldr) ?? "";
    const details = optionalString(step.details) ?? "";
    return [tldr, details].filter(Boolean).join(" — ");
}

/**
 * Parse an extracted JSON string into a normalized `PlanModel`, accepting both
 * the structured schema and the legacy `step_number` schema.
 */
export function parsePlanModel(extracted: string, options: PlanModelParseOptions = {}): PlanModel {
    let parsed: unknown;
    try {
        parsed = JSON.parse(extracted);
    } catch (error) {
        throw new Error(`Plan model JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed)) {
        throw new Error("Plan model JSON must be an object.");
    }
    if (looksLikeStructuredPlan(parsed)) {
        return normalizePlanModel(parsed, options);
    }
    return legacyPlanToModel(parsed, options);
}
