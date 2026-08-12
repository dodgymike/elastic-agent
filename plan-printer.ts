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
 * These helpers intentionally avoid ANSI so they can be exercised with plain
 * Node in unit tests. Missing or malformed fields are handled gracefully and
 * fall back to a summary so the pretty-print never throws. The downstream
 * text-based planSteps()/formatPlan() flow is untouched.
 */

type PlanStep = Record<string, unknown> & {
    step_number?: number | string;
    tldr?: unknown;
    justification?: unknown;
    details?: unknown;
};

type PlanObject = Record<string, unknown> & {
    tldr?: unknown;
    steps?: PlanStep[];
    expected_outcome?: unknown;
};

type ExtractResult =
    | { valid: true; plan: PlanObject }
    | { valid: false; reason: string };

/**
 * Extract a JSON object from a planning response text. Accepts plain JSON or a
 * JSON block fenced with ```json ... ```, and tolerates surrounding prose.
 */
export function extractPlanJson(text: string): ExtractResult {
    const trimmed = String(text).trim();
    if (!trimmed) return { valid: false, reason: "Planning response was empty." };

    let jsonText = trimmed;
    const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
    if (fenced) jsonText = fenced[1].trim();

    const start = jsonText.indexOf("{");
    if (start === -1) return { valid: false, reason: "Planning response did not contain a JSON object." };

    const end = jsonText.lastIndexOf("}");
    if (end < start) return { valid: false, reason: "Planning response did not contain a closing JSON brace." };

    jsonText = jsonText.slice(start, end + 1);
    try {
        const plan = JSON.parse(jsonText);
        if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
            return { valid: false, reason: "Planning response JSON is not an object." };
        }
        return { valid: true, plan: plan as PlanObject };
    } catch (error) {
        return { valid: false, reason: `Planning response JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/** Coerce a value to a non-empty single-line string, or return fallback. */
function text(value: unknown, fallback = "(not provided)"): string {
    if (value === undefined || value === null) return fallback;
    const s = String(value).replace(/\s+/g, " ").trim();
    return s.length > 0 ? s : fallback;
}

/**
 * Pretty-print a parsed plan object to stdout as readable, separated lines.
 * The write callback defaults to console.log and is parameterized only so
 * tests can capture the output.
 */
export function printPlan(plan: unknown, write: (line: string) => void = (line) => console.log(line)): void {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
        write("PLAN");
        write("  (plan could not be displayed: not a JSON object)");
        return;
    }

    const planObj = plan as PlanObject;
    const steps = Array.isArray(planObj.steps) ? planObj.steps : [];

    write("PLAN");
    write(`  TLDR: ${text(planObj.tldr)}`);
    write("  STEPS:");

    if (steps.length === 0) {
        write("    (no steps provided in the plan)");
    } else {
        for (const step of steps) {
            if (!step || typeof step !== "object" || Array.isArray(step)) {
                write("    STEP \u2014 (unparseable step entry)");
                continue;
            }
            const stepObj = step as PlanStep;
            const number = stepObj.step_number !== undefined && stepObj.step_number !== null ? String(stepObj.step_number) : "?";
            write(`    STEP ${number}`);
            write(`      TLDR: ${text(stepObj.tldr)}`);
            write(`      JUSTIFICATION: ${text(stepObj.justification)}`);
            write(`      DETAILS: ${text(stepObj.details)}`);
        }
    }

    if (planObj.expected_outcome !== undefined && planObj.expected_outcome !== null) {
        write(`  EXPECTED OUTCOME: ${text(planObj.expected_outcome)}`);
    }
}
