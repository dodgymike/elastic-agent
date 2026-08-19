/**
 * Pretty-print a parsed plan JSON object in a human-readable, formatted
 * layout. The planning step of the agent asks the LLM to respond in JSON with
 * the shape:
 *
 *   {
 *     "tldr": "...",
 *     "steps": [
 *       { "step_number": 1, "tldr": "...", "justification": "...", "details": "..." }
 *     ],
 *     "expected_outcome": "..."
 *   }
 *
 * This module also owns the robust JSON extraction/parsing helpers that turn
 * the LLM's planning prompt response into a typed plan object (the source of
 * the plan used throughout the agent). The LLM may wrap the JSON in a fenced
 * ```json``` code block or include surrounding prose, so the extraction
 * helpers isolate the JSON substring before parsing.
 *
 * These helpers intentionally avoid ANSI so they can be exercised with plain
 * Node in unit tests. Missing or malformed fields are handled gracefully and
 * fall back to a summary so the pretty-print never throws.
 *
 * Console indentation follows a fixed hierarchy, mirroring the agent loop's
 * output layout (see the agent execution plan for the indent scheme):
 *
 *   level             spaces    example line
 *   ----------------  ------    --------------------------------------
 *   phase              0        Creating an execution plan...
 *   plan               2        PLAN / TLDR: ... / STEPS: / EXPECTED OUTCOME
 *   plan step          4        STEP 1
 *   content in step    6        TLDR: ... / JUSTIFICATION: ... / DETAILS: ...
 *   tool result        8        SUCCESS/ERROR/RESPONSE below a [TOOL] pending line
 *
 * The phase-level lines are produced by `status.*` helpers in main.ts (which
 * are not ANSI-free), while `printPlan` enforces the plan (2), plan step (4),
 * and content-in-step (6) levels. The `indent` helper below is the single
 * source of truth for all five prefixes so main.ts and printPlan share one
 * indentation scheme.
 */

export interface PlanStep {
    step_number?: number | string;
    tldr?: unknown;
    justification?: unknown;
    details?: unknown;
}

/**
 * A validated top-level `phase` value: a trimmed non-empty string or an
 * integer, as constrained by the planning prompt (`prompts/planning-suffix.txt`).
 */
export type PlanPhase = string | number;

export interface PlanObject {
    tldr?: unknown;
    steps?: PlanStep[];
    expected_outcome?: unknown;
    /**
     * Optional top-level field identifying a major stage of work with its own
     * steps. Only present for very-high-complexity plans; when present it is a
     * non-empty string or integer (see prompts/planning-suffix.txt).
     */
    phase?: PlanPhase;
}

/**
 * A validated plan: an object with a `steps` array whose entries are
 * PlanStep objects.
 */
export interface ParsedPlan extends PlanObject {
    steps: PlanStep[];
}

/**
 * Parse options understood by the plan JSON parsers.
 */
export interface PlanJsonOptions {
    /**
     * When true, the top-level `phase` field is required. This is intended for
     * very-high-complexity plans that the prompt contract requires to carry a
     * phase. When false (the default, low/medium complexity) `phase` is
     * optional: it may be present (and must then be valid) or absent.
     */
    requirePhase?: boolean;
}

type ExtractResult =
    | { valid: true; plan: ParsedPlan }
    | { valid: false; reason: string };

/**
 * Validate a top-level `phase` value that is present on a plan object.
 * Returns a normalized phase (trimmed string or integer) and throws a
 * descriptive error when it is not a non-empty string or integer, matching the
 * contract in prompts/planning-suffix.txt.
 */
function validatePhase(value: unknown): PlanPhase {
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

/**
 * Validate and normalize a plan object's top-level `phase` field onto the plan.
 * `requirePhase` reflects high-complexity expectations: phase must be present.
 * When present the value is validated regardless of the requirement. Mutates
 * and returns `plan`.
 */
function applyPhase(plan: Record<string, unknown>, options: PlanJsonOptions): void {
    const requires = options.requirePhase === true;
    // Only a missing key or an explicit undefined counts as "absent". An
    // explicit null is a supplied (malformed) value and is rejected by the
    // type check below — the prompt contract requires a non-empty string or
    // integer, so emitting `"phase": null` is a parse error, not an omission.
    const present = Object.prototype.hasOwnProperty.call(plan, "phase")
        && plan.phase !== undefined;

    if (!present) {
        if (requires) {
            throw new Error("A very-high-complexity plan must include a top-level 'phase' field.");
        }
        return;
    }

    plan.phase = validatePhase(plan.phase);
}

/** Fixed indentation width per hierarchy level (spaces). */
const INDENT = {
    phase: 0,
    plan: 2,
    planStep: 4,
    contentInStep: 6,
    toolResult: 8,
} as const;

/**
 * Return an indentation prefix (a run of spaces) for the given hierarchy level.
 * Level "phase" -> 0 spaces, "plan" -> 2 spaces, "planStep" -> 4 spaces,
 * "contentInStep" -> 6 spaces, "toolResult" -> 8 spaces. This is the single
 * source of truth for the console indent scheme so tests can assert the exact
 * prefix for each level.
 */
export function indent(level: keyof typeof INDENT): string {
    return " ".repeat(INDENT[level]);
}

/**
 * Extract the JSON object substring from a planning response text. Accepts
 * plain JSON or a JSON block fenced with ```json ... ```, and tolerates
 * surrounding prose. Throws a descriptive error when no JSON object is found.
 *
 * Steps: (a) trim whitespace; (b) if the response contains a fenced ```json
 * block, use its content; (c) otherwise isolate the substring from the first
 * '{' to the last '}' and return it.
 */
export function extractJsonFromResponse(response: string): string {
    const trimmed = String(response ?? "").trim();
    if (!trimmed) throw new Error("Planning response was empty.");

    let jsonText = trimmed;
    const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
    if (fenced) jsonText = fenced[1].trim();

    const start = jsonText.indexOf("{");
    if (start === -1) throw new Error("Planning response did not contain a JSON object.");

    const end = jsonText.lastIndexOf("}");
    if (end < start) throw new Error("Planning response did not contain a closing JSON brace.");

    return jsonText.slice(start, end + 1);
}

/**
 * Parse an extracted JSON string into a validated plan object and return it.
 * Throws a descriptive error when parsing fails or the result does not have
 * the required shape: an object with a `steps` array whose entries are
 * objects, each carrying a `step_number` (number) and a `tldr` (string).
 *
 * The optional top-level `phase` field is validated when present (it must be a
 * non-empty string or integer, per prompts/planning-suffix.txt) and exposed on
 * the returned plan. When `options.requirePhase` is true (very-high-complexity
 * plans) the field is required and its absence is a validation error.
 */
export function parsePlanJson(extracted: string, options: PlanJsonOptions = {}): ParsedPlan {
    let parsed: unknown;
    try {
        parsed = JSON.parse(extracted);
    } catch (error) {
        throw new Error(`Planning response JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Planning response JSON is not an object.");
    }

    const plan = parsed as Record<string, unknown>;
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        throw new Error("Planning response JSON must contain a non-empty 'steps' array.");
    }

    for (const step of plan.steps) {
        if (!step || typeof step !== "object" || Array.isArray(step)) {
            throw new Error("Each plan step must be an object.");
        }
        const stepObj = step as PlanStep;
        if (typeof stepObj.step_number !== "number") {
            throw new Error("Each plan step must have a numeric step_number.");
        }
        if (typeof stepObj.tldr !== "string" || !stepObj.tldr.trim()) {
            throw new Error("Each plan step must have a non-empty string tldr.");
        }
    }

    applyPhase(plan, options);

    return plan as unknown as ParsedPlan;
}

/**
 * Convert a validated plan object into the array of step strings used by the
 * agent's execution/review loops. Each step string is its `tldr`, with the
 * `details` appended when present. This is the bridge between the parsed JSON
 * plan object and the existing text-based step flow.
 */
export function planStepsFromObject(plan: PlanObject): string[] {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const strings = steps
        .map((step) => {
            if (!step || typeof step !== "object" || Array.isArray(step)) return "";
            const tldr = typeof step.tldr === "string" ? step.tldr.trim() : "";
            const details = typeof step.details === "string" ? step.details.trim() : "";
            return [tldr, details].filter(Boolean).join(" \u2014 ");
        })
        .filter((s) => s.length > 0);
    return strings;
}

/**
 * Extract a JSON plan object from a planning response text and return it as a
 * non-throwing result ({ valid: true, plan } or { valid: false, reason }).
 * This is the compatibility wrapper used for best-effort parsing and display;
 * it delegates to extractJsonFromResponse + parsePlanJson.
 */
export function extractPlanJson(text: string, options: PlanJsonOptions = {}): ExtractResult {
    try {
        const extracted = extractJsonFromResponse(text);
        return { valid: true, plan: parsePlanJson(extracted, options) };
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** A parsed planning response: either a usable plan or an explicit abort. */
export type ParsedPlanOrAbort =
    | { readonly kind: "plan"; readonly plan: ParsedPlan }
    | { readonly kind: "abort"; readonly reason: string };

/** Non-throwing parse result for a planning response that may be a plan or an abort. */
export type PlanOrAbortResult =
    | { readonly valid: true; readonly result: ParsedPlanOrAbort }
    | { readonly valid: false; readonly reason: string };

/**
 * Parse a planning response that may contain either a valid plan object or the
 * explicit abort object defined by ABORT_SEMANTICS.md section 4.1:
 *
 *   { "abort": true, "reason": "why no plan could be produced" }
 *
 * Rules:
 * - `abort` must be a boolean. When absent or `false`, normal plan parsing
 *   continues unchanged.
 * - When `abort` is `true`, `reason` must be a non-empty string after
 *   trimming, and `abort` wins even if plan steps are also present.
 */
export function parsePlanOrAbort(text: string, options: PlanJsonOptions = {}): PlanOrAbortResult {
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
        return { valid: false, reason: `Planning response JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { valid: false, reason: "Planning response JSON is not an object." };
    }

    const record = parsed as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "abort")) {
        if (typeof record.abort !== "boolean") {
            return { valid: false, reason: "Planning response 'abort' must be a boolean." };
        }
        if (record.abort === true) {
            const reason = typeof record.reason === "string" ? record.reason.trim() : "";
            if (!reason) {
                return { valid: false, reason: "An aborted planning response must provide a non-empty 'reason'." };
            }
            return { valid: true, result: { kind: "abort", reason } };
        }
    }

    try {
        return { valid: true, result: { kind: "plan", plan: parsePlanJson(extracted, options) } };
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** Best-effort single-line serialization of a plan field that never throws. */
function stringify(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value && typeof value === "object") {
        try {
            const serialized = JSON.stringify(value);
            if (serialized !== undefined) return serialized;
        } catch {
            // Fall through to a defensive representation below.
        }
    }
    return String(value);
}

/**
 * Coerce a plan field value to a non-empty single-line string, or return the
 * fallback. Object and array values are serialized as compact JSON rather than
 * being mangled by `String()` into "[object Object]".
 */
function text(value: unknown, fallback = "(not provided)"): string {
    if (value === undefined || value === null) return fallback;
    const s = stringify(value).replace(/\s+/g, " ").trim();
    return s.length > 0 ? s : fallback;
}

/**
 * Pretty-print a parsed plan object to stdout as readable, separated lines,
 * indented according to the hierarchy (plan=2, plan step=4, content=6 spaces).
 * The write callback defaults to console.log and is parameterized only so
 * tests can capture the output.
 */
export function printPlan(plan: unknown, write: (line: string) => void = (line) => console.log(line)): void {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
        write(`${indent("plan")}PLAN`);
        write(`${indent("contentInStep")}(plan could not be displayed: not a JSON object)`);
        return;
    }

    const planObj = plan as PlanObject;
    const steps = Array.isArray(planObj.steps) ? planObj.steps : [];

    write(`${indent("plan")}PLAN`);
    write(`${indent("plan")}TLDR: ${text(planObj.tldr)}`);
    if (planObj.phase !== undefined && planObj.phase !== null) {
        write(`${indent("plan")}PHASE: ${text(planObj.phase)}`);
    }
    write(`${indent("plan")}STEPS:`);

    if (steps.length === 0) {
        write(`${indent("contentInStep")}(no steps provided in the plan)`);
    } else {
        for (const step of steps) {
            if (!step || typeof step !== "object" || Array.isArray(step)) {
                write(`${indent("planStep")}STEP \u2014 (unparseable step entry)`);
                continue;
            }
            const stepObj = step as PlanStep;
            const number = stepObj.step_number !== undefined && stepObj.step_number !== null ? String(stepObj.step_number) : "?";
            write(`${indent("planStep")}STEP ${number}`);
            write(`${indent("contentInStep")}TLDR: ${text(stepObj.tldr)}`);
            write(`${indent("contentInStep")}JUSTIFICATION: ${text(stepObj.justification)}`);
            write(`${indent("contentInStep")}DETAILS: ${text(stepObj.details)}`);
        }
    }

    if (planObj.expected_outcome !== undefined && planObj.expected_outcome !== null) {
        write(`${indent("plan")}EXPECTED OUTCOME: ${text(planObj.expected_outcome)}`);
    }
}
