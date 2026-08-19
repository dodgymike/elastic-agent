// Unit tests for the planner prompt template assembly (planner-prompt.ts):
//   buildPlanningPrompt       - initial planning prompt (user prompt + planning suffix)
//   buildPlanningRetryPrompt  - retry hint when the plan was not valid JSON
//   buildReviewPlanPrompt     - review-plan prompt (goal + planning suffix)
//   buildReplanPrompt         - phase-aware replanner prompt (template interpolation)
//   buildReplanRetryPrompt    - retry hint when the revised plan was not valid JSON
// Compiled into test/.planner-prompt-build by the test:planner-prompt npm script.
const {
    buildPlanningPrompt,
    buildPlanningRetryPrompt,
    buildReviewPlanPrompt,
    buildReplanPrompt,
    buildReplanRetryPrompt,
} = require("./.planner-prompt-build/planner-prompt.js");

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}

// A representative planning suffix template (mirrors prompts/planning-suffix.txt
// structure). Contains a ${phase} interpolation point so we can assert that the
// phase-aware suffix contents flow through unchanged to the prompt.
const PLANNING_SUFFIX = "Return a JSON plan object. For very-high-complexity work include a top-level \"phase\". ${phaseHint}";

// A representative replan-prompt template with the interpolation points consumed
// by buildReplanPrompt (see planner-prompt.ts ReplanPromptInputs). It mirrors
// prompts/replan-prompt.txt, which stringifies the feedback object so the model
// sees its JSON content rather than a mangled `[object Object]`.
const REPLAN_TEMPLATE = [
    "${claudeInstructions}",
    "Completed work:\n${completedWork}",
    "Current-step feedback:\n${JSON.stringify(feedback)}",
    "Recent tool findings:\n${toolFindings}",
    "Remaining steps:\n${formatPlan(remainingSteps)}",
    "Current phase: ${currentPhase}",
].join("\n");

// Simple numbered plan formatter matching the CLI's formatPlan shape.
const formatPlan = (steps) => steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

// 1. buildPlanningPrompt appends the phase-aware planning suffix to the prompt.
{
    const out = buildPlanningPrompt("Review the codebase", PLANNING_SUFFIX);
    check("buildPlanningPrompt keeps the prompt text", out.startsWith("Review the codebase"));
    check("buildPlanningPrompt appends the planning suffix", out.endsWith(PLANNING_SUFFIX));
    check("buildPlanningPrompt separates sections with a blank line", out.includes("Review the codebase\n\nReturn"));
}

// 2. buildPlanningRetryPrompt surfaces the parse failure on the prompt.
{
    const out = buildPlanningRetryPrompt("some planning prompt", "Missing steps array");
    check("buildPlanningRetryPrompt keeps the original prompt", out.startsWith("some planning prompt"));
    check("buildPlanningRetryPrompt mentions the JSON error", out.includes("Missing steps array"));
    check("buildPlanningRetryPrompt asks for valid plan or abort", /valid plan JSON object or an abort object/.test(out));
}

// 3. buildReviewPlanPrompt carries the review goal plus the same phase-aware
//    planning suffix so the review uses the identical JSON contract.
{
    const out = buildReviewPlanPrompt("Conduct a review", PLANNING_SUFFIX);
    check("buildReviewPlanPrompt keeps the review goal", out.startsWith("Conduct a review"));
    check("buildReviewPlanPrompt appends the planning suffix", out.endsWith(PLANNING_SUFFIX));
    check("buildReviewPlanPrompt separates sections with a blank line", out.includes("Conduct a review\n\nReturn"));
}

// 4. buildReplanPrompt interpolates every replanner input (phase-aware). The
//    current phase must appear so the model can decide between a full restart
//    (phase change) and an in-phase revision.
{
    const inputs = {
        claudeInstructions: "Be concise.",
        completedWork: "1. Inspected main.ts",
        feedback: { stepStatus: "needs-verification", summary: "check ownership", replanRequired: false, findings: [] },
        toolFindings: "Read returned the file.",
        formatPlan,
        remainingSteps: ["Verify ownership", "Write test"],
        currentPhase: "implement",
    };
    const out = buildReplanPrompt(REPLAN_TEMPLATE, inputs);
    check("buildReplanPrompt renders the claude instructions", out.includes("Be concise."));
    check("buildReplanPrompt renders completed work", out.includes("Completed work:\n1. Inspected main.ts"));
    check("buildReplanPrompt renders the feedback", out.includes("check ownership"));
    check("buildReplanPrompt renders tool findings", out.includes("Recent tool findings:\nRead returned the file."));
    check("buildReplanPrompt renders remaining steps via formatPlan", out.includes("Remaining steps:\n1. Verify ownership\n2. Write test"));
    check("buildReplanPrompt renders the current phase (phase awareness)", out.includes("Current phase: implement"));
}

// 5. buildReplanPrompt with phase "(none)" — the model should see no phase so it
//    knows the plan was not phase-scoped.
{
    const out = buildReplanPrompt(REPLAN_TEMPLATE, {
        claudeInstructions: "Be concise.",
        completedWork: "",
        feedback: { stepStatus: "complete", summary: "done", replanRequired: false, findings: [] },
        toolFindings: "",
        formatPlan,
        remainingSteps: ["Wrap up"],
        currentPhase: "(none)",
    });
    check("buildReplanPrompt renders a '(none)' current phase", out.includes("Current phase: (none)"));
}

// 6. buildReplanPrompt formats many remaining steps with the injected formatter,
//    so pluralization of the step listing is driven by the caller's formatPlan.
{
    const remaining = ["a", "b", "c"];
    const out = buildReplanPrompt(REPLAN_TEMPLATE, {
        claudeInstructions: "X",
        completedWork: "",
        feedback: {},
        toolFindings: "",
        formatPlan,
        remainingSteps: remaining,
        currentPhase: "verify",
    });
    check("buildReplanPrompt renders all remaining steps", out.includes("1. a\n2. b\n3. c"));
    check("buildReplanPrompt applies the plural formatter across steps", out.includes("Remaining steps:\n1. a\n2. b\n3. c"));
}

// 7. buildReplanRetryPrompt surfaces the prior JSON failure for the revised plan.
{
    const out = buildReplanRetryPrompt("revised plan request", "Unexpected token");
    check("buildReplanRetryPrompt keeps the request", out.startsWith("revised plan request"));
    check("buildReplanRetryPrompt mentions the JSON error", out.includes("Unexpected token"));
    check("buildReplanRetryPrompt asks for valid JSON", /valid JSON following the requested structure/.test(out));
}

if (failures === 0) { console.log("\nAll planner-prompt tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
