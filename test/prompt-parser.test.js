// Unit tests for prompt-parser.ts — the plan JSON parsing surface owned by the
// new prompt-parser module (re-exported by plan-printer.ts for old consumers):
//   extractJsonFromResponse  - isolate the JSON object substring
//   parsePlanJson            - parse + validate into a typed plan object
//   planStepsFromObject      - bridge parsed plan steps into step strings
//   extractPlanJson          - non-throwing compatibility wrapper
//   parsePlanOrAbort         - non-throwing plan-vs-abort parse
// Compiled into test/.prompt-parser-build by the test:prompt-parser npm script.
const {
    extractJsonFromResponse,
    parsePlanJson,
    planStepsFromObject,
    extractPlanJson,
    parsePlanOrAbort,
    parsePlanModel,
    extractPlanModel,
    parsePlanModelOrAbort,
    planStepsFromModel,
    planModelFromPlan,
    legacyPlanToModel,
    isPlanModel,
} = require("./.prompt-parser-build/prompt-parser.js");

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}
function throws(fn) {
    try { fn(); return false; } catch { return true; }
}

const samplePlan = {
    tldr: "Refactor the plan parsing into a focused module",
    steps: [
        {
            step_number: 1,
            tldr: "Locate the current parsing helpers",
            justification: "We need to find where parsing currently lives.",
            details: "Search main.ts for the JSON extraction and parsing helpers.",
        },
        {
            step_number: 2,
            tldr: "Extract parsing into prompt-parser.ts",
            justification: "A dedicated module keeps main.ts focused on orchestration.",
            details: "Move the parse helpers and re-export them from plan-printer.",
        },
    ],
    expected_outcome: "The parsing logic is unit-testable in isolation.",
};

// 1. Valid plan: a well-formed plan object parses into steps.
{
    const plan = parsePlanJson(JSON.stringify(samplePlan));
    check("parsePlanJson accepts a valid plan", Array.isArray(plan.steps) && plan.steps.length === 2);
    check("parsePlanJson preserves the tldr", plan.tldr === samplePlan.tldr);
}

// 2. Invalid plans: structurally malformed responses are rejected.
{
    check("parsePlanJson rejects a non-object value", throws(() => parsePlanJson("[1,2]")));
    check("parsePlanJson rejects a missing steps array", throws(() => parsePlanJson('{"tldr":"oops"}')));

    const invalidStep = JSON.stringify({ steps: [{ tldr: "no step_number" }] });
    check("parsePlanJson rejects a step without step_number", throws(() => parsePlanJson(invalidStep)));

    const invalidTldr = JSON.stringify({ steps: [{ step_number: 1 }] });
    check("parsePlanJson rejects a step without tldr", throws(() => parsePlanJson(invalidTldr)));

    const emptySteps = JSON.stringify({ steps: [] });
    check("parsePlanJson rejects an empty steps array", throws(() => parsePlanJson(emptySteps)));
}

// 3. Robust extraction: plain JSON, fenced ```json``` with prose, and invalid text.
{
    const extracted = extractJsonFromResponse(`Here:\n\`\`\`json\n${JSON.stringify(samplePlan)}\n\`\`\`\nDone.`);
    check("extractJsonFromResponse parses a fenced block with prose", JSON.parse(extracted).tldr === samplePlan.tldr);
    check("extractJsonFromResponse throws on non-JSON", throws(() => extractJsonFromResponse("no json")));
    check("extractJsonFromResponse throws on empty", throws(() => extractJsonFromResponse("   ")));
}

// 4. Phase extraction: a top-level phase is validated and exposed on the plan.
{
    const plan = parsePlanJson(JSON.stringify({ ...samplePlan, phase: "design" }));
    check("parsePlanJson extracts a string phase", plan.phase === "design");

    const trimmed = parsePlanJson(JSON.stringify({ ...samplePlan, phase: "  design  " }));
    check("parsePlanJson trims a string phase", trimmed.phase === "design");

    const integerPhase = parsePlanJson(JSON.stringify({ ...samplePlan, phase: 3 }));
    check("parsePlanJson extracts an integer phase", integerPhase.phase === 3);

    const noPhase = parsePlanJson(JSON.stringify(samplePlan));
    check("parsePlanJson allows an absent phase", noPhase.phase === undefined);
}

// 5. Phase validation: invalid phase values are rejected even when optional.
{
    const invalidPhases = [
        { ...samplePlan, phase: "   " },  // whitespace-only
        { ...samplePlan, phase: 1.5 },    // non-integer number
        { ...samplePlan, phase: {} },     // object
        { ...samplePlan, phase: true },   // boolean
        { ...samplePlan, phase: null },   // null (supplied, malformed)
    ];
    for (const bad of invalidPhases) {
        check(
            `parsePlanJson rejects invalid phase ${JSON.stringify(bad.phase)}`,
            throws(() => parsePlanJson(JSON.stringify(bad))),
        );
    }
}

// 6. Restart/phase-scope semantics: very-high-complexity plans must carry a
//    phase; a phase-less high-complexity plan is rejected (the restart-tracking
//    that compares phases is driven by this validated phase distinction).
{
    check(
        "parsePlanJson requires a phase for high complexity",
        throws(() => parsePlanJson(JSON.stringify(samplePlan), { requirePhase: true })),
    );
    const high = parsePlanJson(JSON.stringify({ ...samplePlan, phase: "verify" }), { requirePhase: true });
    check("parsePlanJson accepts a high-complexity plan with a valid phase", high.phase === "verify");
}

// 7. Abort object (ABORT_SEMANTICS.md 4.1): explicit abort is honored over steps.
{
    const abort = parsePlanOrAbort(JSON.stringify({ abort: true, reason: "Goal is out of scope." }));
    check("parsePlanOrAbort detects an explicit abort", abort.valid && abort.result.kind === "abort" && abort.result.reason === "Goal is out of scope.");

    const abortWins = parsePlanOrAbort(JSON.stringify({ ...samplePlan, abort: true, reason: "Cannot proceed." }));
    check("abort wins even when plan steps are present", abortWins.valid && abortWins.result.kind === "abort");

    const missingReason = parsePlanOrAbort(JSON.stringify({ abort: true }));
    check("parsePlanOrAbort rejects an abort without a reason", missingReason.valid === false);

    const nonBoolean = parsePlanOrAbort(JSON.stringify({ abort: "yes", reason: "x" }));
    check("parsePlanOrAbort rejects a non-boolean abort", nonBoolean.valid === false);
}

// 8. parsePlanOrAbort plan branch preserves phase extraction.
{
    const ok = parsePlanOrAbort(JSON.stringify({ ...samplePlan, phase: 2 }));
    check("parsePlanOrAbort exposes the phase on a plan", ok.valid && ok.result.kind === "plan" && ok.result.plan.phase === 2);

    const highMissing = parsePlanOrAbort(JSON.stringify(samplePlan), { requirePhase: true });
    check("parsePlanOrAbort rejects a missing phase for high complexity", highMissing.valid === false && /phase/.test(highMissing.reason));
}

// 9. planStepsFromObject bridges parsed steps into step strings.
{
    const steps = planStepsFromObject(samplePlan);
    check("planStepsFromObject returns one string per step", steps.length === 2);
    check("planStepsFromObject includes the tldr", steps[0].includes("Locate the current parsing helpers"));
    check("planStepsFromObject includes details", steps[0].includes("Search main.ts"));
}

// 10. extractPlanJson non-throwing wrapper threads options.
{
    const ok = extractPlanJson(JSON.stringify({ ...samplePlan, phase: "build" }), { requirePhase: true });
    check("extractPlanJson accepts a high-complexity plan with a phase", ok.valid === true && ok.plan.phase === "build");

    const bad = extractPlanJson(JSON.stringify(samplePlan), { requirePhase: true });
    check("extractPlanJson rejects a missing phase when required", bad.valid === false && /phase/.test(bad.reason));
}

// 11. PI-03 structured schema: round-trip through parsePlanModel preserves
//     stable IDs, completion criteria, dependencies, and acceptance criteria.
{
    const structured = {
        planId: "PLAN-STRUCTURED",
        version: 3,
        goal: "Refactor plan parsing",
        scope: "parser and printer",
        steps: [
            { id: 10, objective: "Add plan-model.ts", expectedArtifact: "plan-model.ts", completionCriteria: ["compiles"], dependencies: [] },
            { id: 20, objective: "Re-export the model", expectedArtifact: "plan-printer.ts", completionCriteria: ["exports resolve"], dependencies: [10] },
        ],
        acceptanceCriteria: ["Structured plans parse", "Legacy plans parse"],
    };
    const model = parsePlanModel(JSON.stringify(structured));
    check("structured parse returns a PlanModel", isPlanModel(model));
    check("structured parse preserves non-sequential positive ids", model.steps[0].id === 10 && model.steps[1].id === 20);
    check("structured parse preserves dependency references", model.steps[1].dependencies[0] === 10);
    check("structured parse preserves acceptance criteria", model.acceptanceCriteria.length === 2);
    const steps = planStepsFromModel(model);
    check("structured steps render for prompts/display", steps.length === 2 && steps[0].includes("Add plan-model.ts"));
    check("planModelFromPlan is identity for structured models", planModelFromPlan(model) === model);
}

// 12. PI-03 duplicate IDs, cycles, invalid references, and oversize plans are rejected.
{
    const baseStep = (id, dependencies = []) => ({ id, objective: `step ${id}`, expectedArtifact: "", completionCriteria: [`check ${id}`], dependencies });
    const duplicate = { planId: "P", version: 1, goal: "g", scope: "", steps: [baseStep(1), baseStep(1)], acceptanceCriteria: ["done"] };
    check("prompt-parser rejects duplicate step IDs", throws(() => parsePlanModel(JSON.stringify(duplicate))));

    const cycle = { planId: "P", version: 1, goal: "g", scope: "", steps: [baseStep(1, [2]), baseStep(2, [1])], acceptanceCriteria: ["done"] };
    check("prompt-parser rejects dependency cycles", throws(() => parsePlanModel(JSON.stringify(cycle))));

    const missing = { planId: "P", version: 1, goal: "g", scope: "", steps: [baseStep(1, [99])], acceptanceCriteria: ["done"] };
    check("prompt-parser rejects missing dependency references", throws(() => parsePlanModel(JSON.stringify(missing))));

    const threeSteps = [baseStep(1), baseStep(2), baseStep(3)];
    const oversized = { planId: "P", version: 1, goal: "g", scope: "", steps: threeSteps, acceptanceCriteria: ["done"] };
    check("prompt-parser rejects oversize structured plans", throws(() => parsePlanModel(JSON.stringify(oversized), { maxSteps: 2 })));
}

// 13. PI-03 legacy readability: the compatibility adapter migrates legacy
//     step_number plans while legacy rendering continues to work.
{
    const legacyModel = legacyPlanToModel(samplePlan);
    check("legacy adapter produces unique positive IDs", legacyModel.steps[0].id === 1 && legacyModel.steps[1].id === 2);
    check("legacy adapter keeps the tldr as the objective", legacyModel.steps[0].objective.includes("Locate the current parsing helpers"));
    check("legacy adapter derives acceptance criteria from expected_outcome", legacyModel.acceptanceCriteria[0] === samplePlan.expected_outcome);
    const autoLegacy = parsePlanModel(JSON.stringify(samplePlan));
    check("parsePlanModel auto-migrates legacy plans", isPlanModel(autoLegacy) && autoLegacy.legacy === true);
    check("legacy planStepsFromObject remains readable", planStepsFromObject(samplePlan).length === 2);
}

// 14. PI-03 plan-or-abort boundary accepts structured models and preserves abort semantics.
{
    const structured = {
        planId: "PLAN-ABORT",
        version: 1,
        goal: "g",
        scope: "",
        steps: [{ id: 1, objective: "one", expectedArtifact: "", completionCriteria: ["done"], dependencies: [] }],
        acceptanceCriteria: ["done"],
    };
    const parsed = parsePlanModelOrAbort(JSON.stringify(structured));
    check("parsePlanModelOrAbort accepts structured models", parsed.valid && parsed.result.kind === "plan" && parsed.result.plan.planId === "PLAN-ABORT");
    const abort = parsePlanModelOrAbort('{"abort":true,"reason":"No plan"}');
    check("parsePlanModelOrAbort preserves abort", abort.valid && abort.result.kind === "abort" && abort.result.reason === "No plan");
    const extracted = extractPlanModel(`\`\`\`json\n${JSON.stringify(structured)}\n\`\`\``);
    check("extractPlanModel extracts structured JSON", extracted.valid && extracted.model.planId === "PLAN-ABORT");
}

if (failures === 0) { console.log("\nAll prompt-parser tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
