// Unit tests for the plan JSON extraction + pretty-printer (plan-printer.ts).
// The compiled module lives in test/.plan-print-build (see the test:plan-print
// npm script, which compiles plan-printer.ts there and then runs this file).
const { extractPlanJson, printPlan } = require("./.plan-print-build/plan-printer.js");

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}

function capture(fn) {
    const lines = [];
    fn((line) => lines.push(line));
    return lines.join("\n");
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
    const out = capture((w) => printPlan(samplePlan, w));
    check("output contains PLAN heading", out.includes("PLAN"));
    check("output contains TLDR", out.includes("TLDR: Add pretty-printing of the planning step output"));
    check("output contains STEP 1", out.includes("STEP 1"));
    check("output contains STEP 2", out.includes("STEP 2"));
    check("output contains first step tldr", out.includes("Inspect how the planning step output is produced"));
    check("output contains justification label", out.includes("JUSTIFICATION: We need to know where the plan is generated."));
    check("output contains details label", out.includes("DETAILS: Open main.ts and find the PLAN prompt"));
    check("output contains EXPECTED OUTCOME", out.includes("EXPECTED OUTCOME: The agent prints a clearly formatted plan after the planning step."));
}

// 5. printPlan handles missing fields gracefully.
{
    const partial = { tldr: "Only a tldr" };
    const out = capture((w) => printPlan(partial, w));
    check("partial plan still prints PLAN + TLDR", out.includes("PLAN") && out.includes("Only a tldr"));
    check("partial plan with no steps is handled", out.includes("(no steps provided in the plan)"));
}

// 6. printPlan handles a non-object gracefully.
{
    const out = capture((w) => printPlan("oops", w));
    check("printPlan tolerates non-object input", out.includes("could not be displayed"));
}

if (failures === 0) { console.log("\nAll plan-print tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
