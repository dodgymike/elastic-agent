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
 *
 * The phase-level lines are produced by `status.*` helpers in main.ts (which
 * are not ANSI-free), while `printPlan` enforces the plan (2), plan step (4),
 * and content-in-step (6) levels. The `indent` helper below is the single
 * source of truth for all four prefixes so main.ts and printPlan share one
 * indentation scheme.
 */

export interface PlanStep {
    step_number?: number | string;
    tldr?: unknown;
    justification?: unknown;
    details?: unknown;
}

export interface PlanObject {
    tldr?: unknown;
    steps?: PlanStep[];
    expected_outcome?: unknown;
}

/**
 * A validated plan: an object with a `steps` array whose entries are
 * PlanStep objects.
 */
export interface ParsedPlan extends PlanObject {
    steps: PlanStep[];
}

type ExtractResult =
    | { valid: true; plan: ParsedPlan }
    | { valid: false; reason: string };

/** Fixed indentation width per hierarchy level (spaces). */
const INDENT = {
    phase: 0,
    plan: 2,
    planStep: 4,
    contentInStep: 6,
} as const;

/**
 * Return an indentation prefix (a run of spaces) for the given hierarchy level.
 * Level "phase" -> 0 spaces, "plan" -> 2 spaces, "planStep" -> 4 spaces,
 * "contentInStep" -> 6 spaces. This is the single source of truth for the
 * console indent scheme so tests can assert the exact prefix for each level.
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
 */
export function parsePlanJson(extracted: string): ParsedPlan {
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
export function extractPlanJson(text: string): ExtractResult {
    try {
        const extracted = extractJsonFromResponse(text);
        return { valid: true, plan: parsePlanJson(extracted) };
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** Coerce a value to a non-empty single-line string, or return fallback. */
function text(value: unknown, fallback = "(not provided)"): string {
    if (value === undefined || value === null) return fallback;
    const s = String(value).replace(/\s+/g, " ").trim();
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
