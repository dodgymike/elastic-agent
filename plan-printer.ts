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
 * The robust JSON extraction/parsing helpers that turn the LLM's planning
 * prompt response into a typed plan object live in prompt-parser.ts and are
 * re-exported here so existing consumers (main.ts, llm/replan-abort.ts, and
 * unit tests) keep a single stable import surface.
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

// Re-export the parsing surface (types + functions) owned by prompt-parser.ts
// so existing imports of "./plan-printer.js" keep resolving unchanged.
export {
    extractJsonFromResponse,
    parsePlanJson,
    planStepsFromObject,
    extractPlanJson,
    parsePlanOrAbort,
} from "./prompt-parser.js";
export type {
    PlanStep,
    PlanPhase,
    PlanObject,
    ParsedPlan,
    PlanJsonOptions,
    ParsedPlanOrAbort,
    PlanOrAbortResult,
} from "./prompt-parser.js";

import type { PlanObject, PlanStep } from "./prompt-parser.js";

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
