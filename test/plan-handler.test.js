// Unit tests for plan-handler.ts — the reusable plan/step shaping + reporting
// helpers extracted from main.ts:
//   planSteps
//   actionablePlanSteps
//   formatPlan
//   appendSuggestedUpdate
//   applyExecutionFeedback
//   fightingDenialCount
//   reportExecutionFeedback
//   reportAppliedPlanChanges
// Compiled into test/.plan-handler-build by the test:plan-handler npm script
// (which also compiles tool-renderer.ts, the only runtime dependency).
const {
    planSteps,
    actionablePlanSteps,
    formatPlan,
    appendSuggestedUpdate,
    applyExecutionFeedback,
    fightingDenialCount,
    reportExecutionFeedback,
    reportAppliedPlanChanges,
} = require("./.plan-handler-build/plan-handler.js");

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}

// A captured reporter that records calls by level.
function makeReporter() {
    const calls = [];
    const status = {
        warning: (msg, prefix) => calls.push({ level: "warning", msg, prefix }),
        feedback: (msg, prefix) => calls.push({ level: "feedback", msg, prefix }),
        replan: (msg, prefix) => calls.push({ level: "replan", msg, prefix }),
        change: (msg, prefix) => calls.push({ level: "change", msg, prefix }),
    };
    return { status, calls };
}
const indent = () => "      ";

// 1. planSteps: numbered lines are extracted and de-prefixed.
{
    const steps = planSteps("1. Inspect main.ts\n2. Write a test\n3. Run it");
    check("planSteps extracts numbered steps", steps.length === 3);
    check("planSteps de-prefixes the step number", steps[0] === "Inspect main.ts");
    check("planSteps preserves step text", steps[1] === "Write a test");
}

// 2. planSteps: whole-trimmed plan becomes a single step when un-numbered; empty
//    plan falls back to a default step.
{
    const single = planSteps("Just do the work");
    check("planSteps treats an un-numbered plan as one step", single.length === 1 && single[0] === "Just do the work");

    const empty = planSteps("   ");
    check("planSteps falls back to a default step for an empty plan", empty.length === 1 && /Execute the requested work/.test(empty[0]));
}

// 3. planSteps: `)` numbered lines are also recognized.
{
    const steps = planSteps("1) Read the file\n2) Edit it");
    check("planSteps recognizes )-numbered lines", steps.length === 2 && steps[0] === "Read the file");
}

// 4. actionablePlanSteps validates a revised plan.
{
    const ok = actionablePlanSteps("1. Verify ownership\n2. Write the test");
    check("actionablePlanSteps accepts a numbered revised plan", ok.valid === true && ok.steps.length === 2);

    const empty = actionablePlanSteps("   ");
    check("actionablePlanSteps rejects an empty revised plan", empty.valid === false && /empty/.test(empty.reason));

    const unnumbered = actionablePlanSteps("just prose");
    check("actionablePlanSteps rejects a plan without numbered steps", unnumbered.valid === false && /numbered step/.test(unnumbered.reason));

    const nonActionable = actionablePlanSteps("1. none");
    check("actionablePlanSteps rejects a non-actionable step", nonActionable.valid === false && /non-actionable/.test(nonActionable.reason));

    const tooMany = actionablePlanSteps(Array.from({ length: 3 }, (_, i) => `${i + 1}. step ${i}`).join("\n"), 2);
    check("actionablePlanSteps rejects plans over the step budget", tooMany.valid === false && /more than 2 steps/.test(tooMany.reason));

    const nonString = actionablePlanSteps({ steps: [] });
    check("actionablePlanSteps rejects a non-string plan", nonString.valid === false);
}

// 5. formatPlan renders a numbered plan listing.
{
    const listed = formatPlan(["a", "b", "c"]);
    check("formatPlan numbers each step from 1", listed === "1. a\n2. b\n3. c");
}

// 6. appendSuggestedUpdate appends an Update: line.
{
    const updated = appendSuggestedUpdate("Do the thing", "  Also verify it  ");
    check("appendSuggestedUpdate appends a trimmed Update line", updated === "Do the thing\nUpdate: Also verify it");
}

// 7. applyExecutionFeedback folds a local update into the just-completed step.
{
    const active = ["Step A", "Step B", "Step C"];
    const result = applyExecutionFeedback(
        { valid: true, feedback: { suggestedStepUpdate: "Add a check", suggestedPlanUpdates: [] } },
        active,
        0, // completedStepCount
    );
    check("applyExecutionFeedback applies the local update", result.localUpdate.step === 1 && result.localUpdate.update === "Add a check");
    check("applyExecutionFeedback folds the update into the completed step", active[0] === "Step A\nUpdate: Add a check");
    check("applyExecutionFeedback reports no plan updates", result.planUpdates.length === 0 && result.rejectedPlanUpdates.length === 0);
}

// 8. applyExecutionFeedback folds later-step updates onto remaining steps.
{
    const active = ["Step A", "Step B", "Step C"];
    const result = applyExecutionFeedback(
        { valid: true, feedback: { suggestedStepUpdate: "", suggestedPlanUpdates: [{ step: 3, update: "Expand scope" }, { step: 4, update: "New step" }] } },
        active,
        0, // step 1 done; steps 3 and 4 remain (indexes 2 and 3)
    );
    check("applyExecutionFeedback applies an in-range plan update", active[2] === "Step C\nUpdate: Expand scope");
    check("applyExecutionFeedback rejects an out-of-range update", result.rejectedPlanUpdates.length === 1 && /not a remaining plan step/.test(result.rejectedPlanUpdates[0].reason));
}

// 9. applyExecutionFeedback rejects empty suggested updates.
{
    const active = ["Step A", "Step B"];
    const result = applyExecutionFeedback(
        { valid: true, feedback: { suggestedStepUpdate: "", suggestedPlanUpdates: [{ step: 2, update: "   " }] } },
        active,
        0,
    );
    check("applyExecutionFeedback rejects an empty update", result.rejectedPlanUpdates.length === 1 && /empty/.test(result.rejectedPlanUpdates[0].reason));
    check("applyExecutionFeedback leaves the target step unchanged", active[1] === "Step B");
}

// 10. applyExecutionFeedback ignores an invalid or feedback-less entry.
{
    const active = ["Step A"];
    const invalid = applyExecutionFeedback({ valid: false, feedback: null }, active, 0);
    check("applyExecutionFeedback is a no-op for an invalid entry", invalid.localUpdate === null && invalid.planUpdates.length === 0 && invalid.rejectedPlanUpdates.length === 0);

    const noFeedback = applyExecutionFeedback({ valid: true, feedback: null }, active, 0);
    check("applyExecutionFeedback is a no-op without feedback", noFeedback.localUpdate === null);
}

// 11. fightingDenialCount counts goals that reached the fighting threshold.
{
    const state = {
        denialTrackerState: {
            goals: {
                goalA: { count: 3, lastTool: "Read", lastReason: "x" },
                goalB: { count: 5, lastTool: "Edit", lastReason: "y" },
                goalC: { count: 1, lastTool: "Grep", lastReason: "z" },
            },
        },
    };
    check("fightingDenialCount counts only goals at/above the threshold", fightingDenialCount(state, 4) === 1);
    check("fightingDenialCount counts goals exactly at the threshold", fightingDenialCount(state, 3) === 2);
}

// 12. fightingDenialCount handles a missing tracker state gracefully.
{
    check("fightingDenialCount returns 0 with no tracker state", fightingDenialCount({}, 3) === 0);
    check("fightingDenialCount returns 0 with no goals", fightingDenialCount({ denialTrackerState: {} }, 3) === 0);
}

// 13. reportExecutionFeedback: valid feedback reports the step status.
{
    const { status, calls } = makeReporter();
    reportExecutionFeedback(
        { valid: true, step: 2, feedback: { stepStatus: "complete", summary: "all good", findings: ["check A"], replanRequired: false, replanReason: "" } },
        status,
        indent,
    );
    const statusCall = calls.find((c) => c.level === "feedback" && c.msg.includes("Step 2 status: complete"));
    check("reportExecutionFeedback reports the step status", statusCall && statusCall.msg.includes("Step 2 status: complete"));
    check("reportExecutionFeedback passes the content-in-step indent", statusCall && statusCall.prefix === indent());
    const findingsCall = calls.find((c) => c.level === "feedback" && c.msg.includes("Step 2 findings"));
    check("reportExecutionFeedback reports a finding", findingsCall && findingsCall.msg.includes("check A"));
}

// 14. reportExecutionFeedback: replan recommendation is surfaced.
{
    const { status, calls } = makeReporter();
    reportExecutionFeedback(
        { valid: true, step: 1, feedback: { stepStatus: "blocked", summary: "stuck", findings: [], replanRequired: true, replanReason: "ownership unclear" } },
        status,
        indent,
    );
    const replan = calls.find((c) => c.level === "replan");
    check("reportExecutionFeedback recommends replanning", replan && /recommends replanning/.test(replan.msg) && replan.msg.includes("ownership unclear"));
}

// 15. reportExecutionFeedback: an invalid entry is reported as a retained note.
{
    const { status, calls } = makeReporter();
    reportExecutionFeedback({ valid: false, step: 3, validationError: "bad shape" }, status, indent);
    const warning = calls.find((c) => c.level === "warning");
    check("reportExecutionFeedback warns on an invalid entry", warning && warning.msg.includes("Step 3 feedback was retained") && warning.msg.includes("bad shape"));
}

// 16. reportAppliedPlanChanges: accepted local/plan updates and rejected updates.
{
    const { status, calls } = makeReporter();
    reportAppliedPlanChanges(
        {
            localUpdate: { step: 1, update: "local fix" },
            planUpdates: [{ step: 3, update: "expand" }],
            rejectedPlanUpdates: [{ step: 5, reason: "not a remaining plan step" }],
        },
        status,
        indent,
    );
    const changes = calls.filter((c) => c.level === "change");
    check("reportAppliedPlanChanges reports the local update", changes.some((c) => c.msg.includes("Accepted local update for step 1")));
    check("reportAppliedPlanChanges reports the remaining-step update", changes.some((c) => c.msg.includes("Accepted update for remaining step 3")));
    const warning = calls.find((c) => c.level === "warning");
    check("reportAppliedPlanChanges reports a rejected update", warning && warning.msg.includes("Skipped suggested update for step 5") && warning.msg.includes("not a remaining plan step"));
}

// 17. reportAppliedPlanChanges is quiet when nothing changed.
{
    const { status, calls } = makeReporter();
    reportAppliedPlanChanges({ localUpdate: null, planUpdates: [], rejectedPlanUpdates: [] }, status, indent);
    check("reportAppliedPlanChanges emits nothing when there are no changes", calls.length === 0);
}

if (failures === 0) { console.log("\nAll plan-handler tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
