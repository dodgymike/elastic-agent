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
    formatExecutedSteps,
    formatReviewPlanSteps,
    formatEvidenceReferences,
    planVersionSummary,
    FIXED_REVIEW_CHECKLIST,
} = require("./.plan-handler-build/plan-handler.js");
const { snapshotStepFeedback } = require("./.plan-handler-build/step-outcome.js");

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

// 18. PI-01 behavioral coverage: the same five fake feedback entries reduce to
//     ONE normalized outcome that the local ledgers (attempt + completion
//     entry), memory, the external Spec Keeper status, and the review input all
//     agree on. This exercises the real production code path
//     (snapshotStepFeedback + formatExecutedSteps), not a hand-rolled mirror.
{
    const fixtures = [
        {
            name: "invalid JSON",
            feedbackEntry: { valid: false, response_id: "resp-invalid-json", validationError: "Feedback JSON could not be parsed" },
            stepText: "Run the checks",
            outcome: "invalid",
            memory: "unknown",
            specKeeper: "failed",
        },
        {
            name: "failed checks",
            feedbackEntry: { valid: true, response_id: "resp-failed-checks", feedback: { stepStatus: "failed", summary: "checks failed", findings: ["lint failed"] } },
            stepText: "Run the checks",
            outcome: "failed",
            memory: "failed",
            specKeeper: "failed",
        },
        {
            name: "blocked tools",
            feedbackEntry: { valid: true, response_id: "resp-blocked-tool", feedback: { stepStatus: "blocked", summary: "tool unavailable", findings: [] } },
            stepText: "Use the sandbox tool",
            outcome: "blocked",
            memory: "aborted",
            specKeeper: "blocked",
        },
        {
            name: "successful checks",
            feedbackEntry: { valid: true, response_id: "resp-success-checks", feedback: { stepStatus: "completed", summary: "checks passed", findings: ["lint ok", "test ok"] } },
            stepText: "Run the checks",
            outcome: "succeeded",
            memory: "completed",
            specKeeper: "done",
        },
        {
            name: "successful non-code deliverables",
            feedbackEntry: { valid: true, response_id: "resp-success-report", feedback: { stepStatus: "completed", summary: "wrote report", findings: ["deliverable: docs/REPORT.md created"] } },
            stepText: "Write the summary report",
            outcome: "succeeded",
            memory: "completed",
            specKeeper: "done",
        },
    ];

    for (const fixture of fixtures) {
        const snapshot = snapshotStepFeedback({ feedbackEntry: fixture.feedbackEntry, step: 1, stepText: fixture.stepText });
        check(`${fixture.name}: local attempt outcome is ${fixture.outcome}`, snapshot.attempt.outcome === fixture.outcome);
        check(`${fixture.name}: completion ledger records the terminal outcome`, snapshot.ledgerEntry !== null && snapshot.ledgerEntry.outcome === fixture.outcome);
        check(`${fixture.name}: completion ledger carries the executed step text`, snapshot.ledgerEntry !== null && snapshot.ledgerEntry.text === fixture.stepText);
        check(
            `${fixture.name}: ledger evidence is secret-free (no data.json/file contents)`,
            snapshot.ledgerEntry !== null && !JSON.stringify(snapshot.ledgerEntry.evidence).includes("data.json"),
        );
        check(`${fixture.name}: memory outcome agrees (${fixture.memory})`, snapshot.reduced.memoryOutcome === fixture.memory);
        check(`${fixture.name}: external Spec Keeper status agrees (${fixture.specKeeper})`, snapshot.reduced.specKeeperStatus === fixture.specKeeper);
        check(
            `${fixture.name}: review input renders the step with the normalized outcome`,
            formatExecutedSteps([snapshot.ledgerEntry]) === `1. ${fixture.stepText} [${fixture.outcome}]`,
        );
        // The four consumers must agree: success is the only way to reach
        // `done`/`completed`, and a non-success outcome can never look done.
        check(
            `${fixture.name}: done/completed agree with the normalized outcome`,
            (snapshot.reduced.specKeeperStatus === "done") === (snapshot.reduced.memoryOutcome === "completed") &&
                (snapshot.reduced.specKeeperStatus === "done") === (fixture.outcome === "succeeded"),
        );
    }

    // Invalid JSON must never emit done/completed anywhere in the fan-out.
    {
        const invalid = snapshotStepFeedback({ feedbackEntry: { valid: false, response_id: "resp-invalid-2", validationError: "bad shape" }, step: 2, stepText: "Do the work" });
        check("invalid JSON: local ledger outcome is never succeeded", invalid.ledgerEntry !== null && invalid.ledgerEntry.outcome !== "succeeded");
        check("invalid JSON: memory outcome is never completed", invalid.reduced.memoryOutcome !== "completed");
        check("invalid JSON: external status is never done", invalid.reduced.specKeeperStatus !== "done");
        check("invalid JSON: spec keeper note carries the diagnostic", invalid.reduced.specKeeperNote.includes("outcome invalid"));
    }
}

// 19. PI-02 review-plan validation: a valid review-plan response contributes its
//     rendered, numbered steps; an abort or invalid response falls back to the
//     fixed four-criteria checklist with a reason.
{
    const validPlan = formatReviewPlanSteps('{"steps":[{"step_number":1,"tldr":"Check acceptance criteria"},{"step_number":2,"tldr":"Inspect the diff"}]}');
    check("formatReviewPlanSteps accepts a valid review plan", validPlan.usedFallback === false && validPlan.reason === null);
    check("formatReviewPlanSteps renders numbered steps", validPlan.steps === "1. Check acceptance criteria\n2. Inspect the diff");

    const abort = formatReviewPlanSteps('{"abort":true,"reason":"Cannot review without the diff"}');
    check("formatReviewPlanSteps falls back for an abort", abort.usedFallback === true);
    check("formatReviewPlanSteps reports the abort reason", abort.reason === "review plan was an abort: Cannot review without the diff");
    check("formatReviewPlanSteps abort falls back to the fixed checklist", abort.steps === FIXED_REVIEW_CHECKLIST);

    const invalid = formatReviewPlanSteps('not json at all');
    check("formatReviewPlanSteps falls back for invalid JSON", invalid.usedFallback === true && typeof invalid.reason === "string" && invalid.reason.length > 0);
    check("formatReviewPlanSteps invalid falls back to the fixed checklist", invalid.steps === FIXED_REVIEW_CHECKLIST);

    const empty = formatReviewPlanSteps("");
    check("formatReviewPlanSteps falls back for an empty response", empty.usedFallback === true && empty.steps === FIXED_REVIEW_CHECKLIST);

    check("FIXED_REVIEW_CHECKLIST carries all four canonical criteria",
        ["(a)", "(b)", "(c)", "(d)"].every((marker) => FIXED_REVIEW_CHECKLIST.includes(marker)));
}

// 20. PI-02 evidence references: the review input renders secret-free evidence
//     references (summary/findings + provider response id) per completed step.
{
    const ledger = [
        {
            step: 1,
            text: "Run the checks",
            feedbackResponseId: "resp-success-checks",
            outcome: "succeeded",
            evidence: { stepStatus: "completed", summary: "checks passed", findings: ["lint ok", "test ok"] },
        },
        {
            step: 2,
            text: "Write the report",
            feedbackResponseId: null,
            outcome: "invalid",
            evidence: { validationError: "Feedback JSON could not be parsed" },
        },
        {
            step: 3,
            text: "Record learnings",
            feedbackResponseId: "resp-no-evidence",
            outcome: "succeeded",
            evidence: { stepStatus: "completed", summary: "", findings: [] },
        },
    ];
    const refs = formatEvidenceReferences(ledger);
    check("formatEvidenceReferences renders empty as (none)", formatEvidenceReferences([]) === "(none)");
    check("formatEvidenceReferences includes the provider response id", refs.includes("[response resp-success-checks]"));
    check("formatEvidenceReferences includes findings", refs.includes("findings: lint ok; test ok"));
    check("formatEvidenceReferences renders a validation diagnostic for invalid feedback", refs.includes("invalid feedback — Feedback JSON could not be parsed"));
    check("formatEvidenceReferences notes a missing evidence payload", refs.includes("no evidence recorded."));
    check("formatEvidenceReferences never renders file contents", !refs.includes("data.json"));
}

// 21. PI-02 plan version: prefer an explicit numeric planVersion, otherwise
//     derive one plus the number of applied replans (phase appended when set).
{
    check("planVersionSummary prefers an explicit numeric version", planVersionSummary({ planVersion: 7, replanHistory: [{ applied: true }] }) === "7");
    check("planVersionSummary ignores a non-positive explicit version", planVersionSummary({ planVersion: 0, replanHistory: [] }) === "1");
    check("planVersionSummary derives 1 with no applied replans", planVersionSummary({ replanHistory: [] }) === "1");
    check("planVersionSummary counts only applied replans", planVersionSummary({ replanHistory: [{ applied: true }, { applied: false }, { applied: true }] }) === "3");
    check("planVersionSummary appends the phase when present", planVersionSummary({ planPhase: "design", replanHistory: [{ applied: true }] }) === "2 (phase design)");
    check("planVersionSummary tolerates a missing config", planVersionSummary(null) === "1");
}

if (failures === 0) { console.log("\nAll plan-handler tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
