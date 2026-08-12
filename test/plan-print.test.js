// Unit tests for the plan JSON extraction + pretty-printer (plan-printer.ts).
// The compiled module lives in test/.plan-print-build (see the test:plan-print
// npm script, which compiles plan-printer.ts there and then runs this file).
const { extractPlanJson, printPlan, indent } = require("./.plan-print-build/plan-printer.js");

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}

function capture(fn) {
    const lines = [];
    fn((line) => lines.push(line));
    return { text: lines.join("\n"), lines };
}

// Sample plan matching the shape revealed by prompts/planning-suffix.txt.
const samplePlan = {
    tldr: "Add pretty-printing of the planning step output",
    steps: [
        {
            step_number: 1,
            tldr: "Inspect how the planning step output is produced",
            justification: "We need to know where the plan is generated.",
            details: "Open main.ts and find the PLAN prompt, parsing, and usage.",
        },
        {
            step_number: 2,
            tldr: "Add a utility function that pretty-prints a plan",
            justification: "A dedicated printer keeps main.ts clean.",
            details: "Create printPlan(plan) that outputs the plan to stdout.",
        },
    ],
    expected_outcome: "The agent prints a clearly formatted plan after the planning step.",
};

// 0. indent helper matches the documented hierarchy indentation scheme:
//    plan=2 spaces, plan step=4 spaces, content-in-step=6 spaces.
{
    check("indent('plan') is exactly 2 spaces", indent("plan") === "  ");
    check("indent('planStep') is exactly 4 spaces", indent("planStep") === "    ");
    check("indent('contentInStep') is exactly 6 spaces", indent("contentInStep") === "      ");
}

// 1. extractPlanJson: plain JSON object.
{
    const r = extractPlanJson(JSON.stringify(samplePlan));
    check("extractPlanJson parses plain JSON", r.valid === true && r.plan.tldr === samplePlan.tldr);
}

// 2. extractPlanJson: fenced ```json``` block with surrounding prose.
{
    const fenced = `Here is the plan:\n\`\`\`json\n${JSON.stringify(samplePlan)}\n\`\`\`\nDone.`;
    const r = extractPlanJson(fenced);
    check("extractPlanJson parses fenced JSON with prose", r.valid === true && Array.isArray(r.plan.steps) && r.plan.steps.length === 2);
}

// 3. extractPlanJson: invalid input yields valid=false with a reason.
{
    const r = extractPlanJson("not json at all");
    check("extractPlanJson rejects non-JSON", r.valid === false && typeof r.reason === "string");
}

// 4. printPlan output contains key plan elements.
{
    const { text } = capture((w) => printPlan(samplePlan, w));
    check("output contains PLAN heading", text.includes("PLAN"));
    check("output contains TLDR", text.includes("TLDR: Add pretty-printing of the planning step output"));
    check("output contains STEP 1", text.includes("STEP 1"));
    check("output contains STEP 2", text.includes("STEP 2"));
    check("output contains first step tldr", text.includes("Inspect how the planning step output is produced"));
    check("output contains justification label", text.includes("JUSTIFICATION: We need to know where the plan is generated."));
    check("output contains details label", text.includes("DETAILS: Open main.ts and find the PLAN prompt"));
    check("output contains EXPECTED OUTCOME", text.includes("EXPECTED OUTCOME: The agent prints a clearly formatted plan after the planning step."));
}

// 4b. printPlan indentation matches the hierarchy: plan=2, plan step=4,
//     content in step=6 spaces (addressed by this plan's indent change).
{
    const { lines } = capture((w) => printPlan(samplePlan, w));
    check("PLAN heading is indented at the plan level (2 spaces)", lines[0] === `${indent("plan")}PLAN`);
    check("plan TLDR is at the plan level (2 spaces)", lines[1] === `${indent("plan")}TLDR: Add pretty-printing of the planning step output`);
    check("plan STEPS marker is at the plan level (2 spaces)", lines[2] === `${indent("plan")}STEPS:`);
    check("STEP 1 is indented at the plan-step level (4 spaces)", lines[3] === `${indent("planStep")}STEP 1`);
    check("step 1 TLDR is indented at the content-in-step level (6 spaces)", lines[4] === `${indent("contentInStep")}TLDR: Inspect how the planning step output is produced`);
    check("step 1 JUSTIFICATION is indented at 6 spaces", lines[5] === `${indent("contentInStep")}JUSTIFICATION: We need to know where the plan is generated.`);
    check("step 1 DETAILS is indented at 6 spaces", lines[6] === `${indent("contentInStep")}DETAILS: Open main.ts and find the PLAN prompt, parsing, and usage.`);
    const step2Index = lines.findIndex((l) => l === `${indent("planStep")}STEP 2`);
    check("STEP 2 is indented at the plan-step level (4 spaces)", step2Index !== -1 && lines[step2Index + 1] === `${indent("contentInStep")}TLDR: Add a utility function that pretty-prints a plan`);
    check("EXPECTED OUTCOME is at the plan level (2 spaces)", lines[lines.length - 1] === `${indent("plan")}EXPECTED OUTCOME: The agent prints a clearly formatted plan after the planning step.`);
}

// 5. printPlan handles missing fields gracefully.
{
    const partial = { tldr: "Only a tldr" };
    const { text } = capture((w) => printPlan(partial, w));
    check("partial plan still prints PLAN + TLDR", text.includes("PLAN") && text.includes("Only a tldr"));
    check("partial plan with no steps is handled", text.includes("(no steps provided in the plan)"));
    check("no-steps note is indented at 6 spaces", text.includes(`${indent("contentInStep")}(no steps provided in the plan)`));
}

// 6. printPlan handles a non-object gracefully.
{
    const out = capture((w) => printPlan("oops", w)).text;
    check("printPlan tolerates non-object input", out.includes("could not be displayed"));
}

if (failures === 0) { console.log("\nAll plan-print tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
