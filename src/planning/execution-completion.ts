import type { StepOutcome } from "./step-outcome.js";
import { RunAbortError } from "../llm/run-abort.js";

/** Missing or non-success outcomes never authorize plan-level completion. */
export function assertExecutionComplete(stepCount: number, outcomes: ReadonlyMap<number, StepOutcome>): void {
    const unresolved: string[] = [];
    for (let step = 1; step <= stepCount; step++) {
        const outcome = outcomes.get(step) ?? "pending";
        if (outcome !== "succeeded") unresolved.push(`${step}: ${outcome}`);
    }
    if (unresolved.length) {
        throw new RunAbortError("unable-to-complete", "execution",
            `Execution has ${unresolved.length} unresolved step(s): ${unresolved.slice(0, 20).join("; ")}${unresolved.length > 20 ? "; …" : ""}. Work is not complete.`);
    }
}

/** Report normalized outcomes rather than treating every returned attempt as done. */
export function stepOutcomeMessage(step: number, total: number, outcome: StepOutcome): string {
    return `Step ${step}/${total} ${outcome === "succeeded" ? "succeeded" : `ended with outcome ${outcome}`}.`;
}
