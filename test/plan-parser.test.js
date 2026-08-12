// Unit tests for the plan JSON extraction + parsing helpers (plan-printer.ts):
//   extractJsonFromResponse  - isolate the JSON object substring
//   parsePlanJson            - parse + validate into a typed plan object
//   planStepsFromObject      - bridge parsed plan steps into step strings
//   extractPlanJson          - non-throwing compatibility wrapper
// Compiled into test/.plan-parser-build by the test:plan-parser npm script.
const {
    extractJsonFromResponse,
    parsePlanJson,
    planStepsFromObject,
    extractPlanJson,
} = require("./.plan-parser-build/plan-printer.js");

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}
function throws(fn) {
    try { fn(); return false; } catch { return true; }
}

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

// 1. extractJsonFromResponse: plain JSON.
{
    const extracted = extractJsonFromResponse(JSON.stringify(samplePlan));
    check("extractJsonFromResponse isolates plain JSON", JSON.parse(extracted).tldr === samplePlan.tldr);
}

// 2. extractJsonFromResponse: fenced ```json``` block with surrounding prose.
{
    const fenced = `Here is the plan:\n\`\`\`json\n${JSON.stringify(samplePlan)}\n\`\`\`\nDone.`;
    const extracted = extractJsonFromResponse(fenced);
    const parsed = JSON.parse(extracted);
    check("extractJsonFromResponse parses fenced JSON with prose", parsed.tldr === samplePlan.tldr && parsed.steps.length === 2);
}

// 3. extractJsonFromResponse: invalid input throws a descriptive error.
{
    check("extractJsonFromResponse throws on non-JSON", throws(() => extractJsonFromResponse("not json at all")));
    check("extractJsonFromResponse throws on empty", throws(() => extractJsonFromResponse("   ")));
}

// 4. parsePlanJson: valid plan parses and returns steps array.
{
    const plan = parsePlanJson(JSON.stringify(samplePlan));
    check("parsePlanJson returns steps array", Array.isArray(plan.steps) && plan.steps.length === 2);
    check("parsePlanJson preserves step tldr", plan.steps[0].tldr === samplePlan.steps[0].tldr);
}

// 5. parsePlanJson: missing steps array throws.
{
    const invalid = JSON.stringify({ tldr: "only a tldr" });
    check("parsePlanJson throws when steps array missing", throws(() => parsePlanJson(invalid)));
}

// 6. parsePlanJson: non-array steps throws.
{
    const invalid = JSON.stringify({ steps: { 0: { step_number: 1, tldr: "x" } } });
    check("parsePlanJson throws when steps is not an array", throws(() => parsePlanJson(invalid)));
}

// 7. parsePlanJson: step missing required fields throws.
{
    const invalid = JSON.stringify({ steps: [{ step_number: 1 }] }); // no tldr
    check("parsePlanJson throws when a step lacks tldr", throws(() => parsePlanJson(invalid)));
    const invalid2 = JSON.stringify({ steps: [{ tldr: "no number" }] }); // no step_number
    check("parsePlanJson throws when a step lacks step_number", throws(() => parsePlanJson(invalid2)));
}

// 8. planStepsFromObject converts parsed steps into step strings.
{
    const steps = planStepsFromObject(samplePlan);
    check("planStepsFromObject returns one string per step", steps.length === 2);
    check("planStepsFromObject includes tldr", steps[0].includes("Inspect how the planning step output is produced"));
    check("planStepsFromObject includes details", steps[0].includes("Open main.ts"));
}

// 9. extractPlanJson (non-throwing wrapper) remains compatible.
{
    const r = extractPlanJson(JSON.stringify(samplePlan));
    check("extractPlanJson valid on plain JSON", r.valid === true && Array.isArray(r.plan.steps));
    const bad = extractPlanJson("no json");
    check("extractPlanJson invalid on non-JSON", bad.valid === false && typeof bad.reason === "string");
}

// 10. Integration: the full extract -> parse -> steps flow matches the
//     prompt shape revealed by prompts/planning-suffix.txt.
{
    const response = `\`\`\`json\n${JSON.stringify(samplePlan)}\n\`\`\``;
    const plan = parsePlanJson(extractJsonFromResponse(response));
    const steps = planStepsFromObject(plan);
    check("integration flow yields 2 actionable steps", steps.length === 2);
    check("integration flow returns a plan object with expected_outcome", plan.expected_outcome === samplePlan.expected_outcome);
}

if (failures === 0) { console.log("\nAll plan-parser tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
