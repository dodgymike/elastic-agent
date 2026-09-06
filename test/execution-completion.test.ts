import assert from "node:assert/strict";
import { assertExecutionComplete, stepOutcomeMessage } from "../execution-completion.js";
import { STEP_OUTCOMES, reduceStepOutcome } from "../step-outcome.js";

for (const outcome of STEP_OUTCOMES) {
    const reduction = reduceStepOutcome(outcome);
    const outcomes = new Map([[1, outcome]]);
    if (outcome === "succeeded") {
        assert.doesNotThrow(() => assertExecutionComplete(1, outcomes));
        assert.equal(reduction.memoryOutcome, "completed");
        assert.equal(reduction.specKeeperStatus, "done");
    } else {
        assert.throws(() => assertExecutionComplete(1, outcomes), /Work is not complete/);
        assert.notEqual(reduction.memoryOutcome, "completed");
        assert.notEqual(reduction.specKeeperStatus, "done");
        assert.doesNotMatch(stepOutcomeMessage(1, 1, outcome), /completed|succeeded/);
    }
}
assert.throws(() => assertExecutionComplete(2, new Map([[1, "succeeded"]])), /2: pending/);
assert.throws(() => assertExecutionComplete(2, new Map([[1, "failed"], [2, "succeeded"]])), /1: failed/);
const revised = new Map([[1, "succeeded" as const]]);
revised.clear(); // A new phase must not inherit a prior phase's success by index.
assert.throws(() => assertExecutionComplete(1, revised), /pending/);
assert.doesNotThrow(() => assertExecutionComplete(0, new Map()));
console.log("Execution completion gate and consumer consistency tests passed.");
