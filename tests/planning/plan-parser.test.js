// Unit tests for the plan JSON extraction + parsing helpers (src/ui/plan-printer.ts):
//   extractJsonFromResponse  - isolate the JSON object substring
//   parsePlanJson            - parse + validate into a typed plan object
//   planStepsFromObject      - bridge parsed plan steps into step strings
//   extractPlanJson          - non-throwing compatibility wrapper
//   parsePlanOrAbort         - non-throwing plan-vs-abort parse
// Compiled into test/.plan-parser-build by the test:plan-parser npm script.
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
    planModelStepIndexById,
    planModelStepIdByIndex,
    planModelStepById,
    planModelCriteriaById,
    planModelStepIds,
    replacePlanModelRemainingSteps,
    rebuildPlanModelSteps,
} = require("../../.test-build/src/ui/plan-printer.js");

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
            details: "Open src/main.ts and find the PLAN prompt, parsing, and usage.",
        },
        {
            step_number: 2,
            tldr: "Add a utility function that pretty-prints a plan",
            justification: "A dedicated printer keeps src/main.ts clean.",
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
    check("planStepsFromObject includes details", steps[0].includes("Open src/main.ts"));
}

// 9. extractPlanJson (non-throwing wrapper) remains compatible.
{
    const r = extractPlanJson(JSON.stringify(samplePlan));
    check("extractPlanJson valid on plain JSON", r.valid === true && Array.isArray(r.plan.steps));
    const bad = extractPlanJson("no json");
    check("extractPlanJson invalid on non-JSON", bad.valid === false && typeof bad.reason === "string");
}

// 10. Integration: the full extract -> parse -> steps flow matches the
//     prompt shape revealed by prompts/planning-prefix.txt.
{
    const response = `\`\`\`json\n${JSON.stringify(samplePlan)}\n\`\`\``;
    const plan = parsePlanJson(extractJsonFromResponse(response));
    const steps = planStepsFromObject(plan);
    check("integration flow yields 2 actionable steps", steps.length === 2);
    check("integration flow returns a plan object with expected_outcome", plan.expected_outcome === samplePlan.expected_outcome);
}

// 11. Top-level "phase": valid string phase is accepted and exposed on the plan.
{
    const plan = parsePlanJson(JSON.stringify({ ...samplePlan, phase: "design" }));
    check("parsePlanJson accepts a string phase", plan.phase === "design");
    const trimmed = parsePlanJson(JSON.stringify({ ...samplePlan, phase: "  design  " }));
    check("parsePlanJson trims a string phase", trimmed.phase === "design");
}

// 12. Top-level "phase": valid integer phase is accepted and exposed on the plan.
{
    const plan = parsePlanJson(JSON.stringify({ ...samplePlan, phase: 1 }));
    check("parsePlanJson accepts an integer phase", plan.phase === 1);
}

// 13. Top-level "phase": absent phase is accepted for low/medium complexity.
{
    const plan = parsePlanJson(JSON.stringify(samplePlan));
    check("parsePlanJson allows absent phase for low/medium complexity", plan.phase === undefined);
}

// 14. Top-level "phase": requirePhase (very-high complexity) rejects a missing phase.
{
    check(
        "parsePlanJson throws when requirePhase and phase is absent",
        throws(() => parsePlanJson(JSON.stringify(samplePlan), { requirePhase: true })),
    );
}

// 15. Top-level "phase": invalid types are rejected whether or not phase is required.
{
    const invalidTypes = [
        { ...samplePlan, phase: "   " },        // whitespace-only string
        { ...samplePlan, phase: 1.5 },          // non-integer number
        { ...samplePlan, phase: {} },           // object
        { ...samplePlan, phase: [] },           // array
        { ...samplePlan, phase: true },         // boolean
        { ...samplePlan, phase: null },         // null
    ];
    for (const bad of invalidTypes) {
        check(
            `parsePlanJson rejects invalid phase ${JSON.stringify(bad.phase)}`,
            throws(() => parsePlanJson(JSON.stringify(bad))),
        );
    }
}

// 16. Top-level "phase": a very-high-complexity plan WITH a valid phase is accepted.
{
    const plan = parsePlanJson(JSON.stringify({ ...samplePlan, phase: "verify" }), { requirePhase: true });
    check("parsePlanJson accepts a high-complexity plan with a valid phase", plan.phase === "verify");
}

// 17. Top-level "phase": parsePlanOrAbort exposes and validates phase the same way.
{
    const ok = parsePlanOrAbort(JSON.stringify({ ...samplePlan, phase: 2 }));
    check("parsePlanOrAbort exposes phase on a valid plan", ok.valid && ok.result.kind === "plan" && ok.result.plan.phase === 2);

    const missingHigh = parsePlanOrAbort(JSON.stringify(samplePlan), { requirePhase: true });
    check(
        "parsePlanOrAbort rejects missing phase for high complexity",
        missingHigh.valid === false && /phase/.test(missingHigh.reason),
    );

    const badType = parsePlanOrAbort(JSON.stringify({ ...samplePlan, phase: false }));
    check("parsePlanOrAbort rejects invalid phase type", badType.valid === false && /phase/.test(badType.reason));
}

// 18. Top-level "phase": extractPlanJson (compatibility wrapper) threads options.
{
    const r = extractPlanJson(JSON.stringify(samplePlan), { requirePhase: true });
    check("extractPlanJson rejects missing phase when required", r.valid === false && /phase/.test(r.reason));
    const ok = extractPlanJson(JSON.stringify({ ...samplePlan, phase: "build" }), { requirePhase: true });
    check("extractPlanJson accepts present phase when required", ok.valid === true && ok.plan.phase === "build");
}

// 19. PI-03 structured plan model: round-trip a structured plan through
//     parsePlanModel, planStepsFromModel, and planModelFromPlan without losing
//     IDs, criteria, dependencies, or acceptance criteria.
{
    const structuredPlan = {
        planId: "PLAN-1",
        version: 2,
        goal: "Add structured plan support",
        scope: "plan parsing and rendering only",
        steps: [
            {
                id: 1,
                objective: "Create src/planning/plan-model.ts",
                expectedArtifact: "src/planning/plan-model.ts",
                completionCriteria: ["compiles", "exports PlanModel"],
                dependencies: [],
            },
            {
                id: 2,
                objective: "Wire the parser",
                expectedArtifact: "updated src/planning/prompt-parser.ts",
                completionCriteria: ["parses structured plans", "keeps legacy plans readable"],
                dependencies: [1],
            },
        ],
        acceptanceCriteria: ["Structured plans round-trip", "Legacy plans remain readable"],
    };
    const model = parsePlanModel(JSON.stringify(structuredPlan));
    check("structured model parses", isPlanModel(model));
    check("structured model preserves schemaVersion", model.schemaVersion === 1);
    check("structured model preserves planId and version", model.planId === "PLAN-1" && model.version === 2);
    check("structured model preserves step ids", model.steps[0].id === 1 && model.steps[1].id === 2);
    check("structured model preserves dependencies", model.steps[1].dependencies.includes(1));
    check("structured model preserves completion criteria", model.steps[0].completionCriteria.length === 2);
    check("structured model preserves acceptance criteria", model.acceptanceCriteria.length === 2);
    const rendered = planStepsFromModel(model);
    check("planStepsFromModel renders every step", rendered.length === 2 && rendered[0].includes("Create src/planning/plan-model.ts"));
    check("planStepsFromModel renders completion criteria", rendered[1].includes("Completion criteria"));
    const coerced = planModelFromPlan(model);
    check("planModelFromPlan returns the same structured object", coerced === model);
    const reparsed = parsePlanModel(JSON.stringify(model));
    check("structured model serializes and reparses losslessly", JSON.stringify(reparsed) === JSON.stringify(model));
}

// 20. PI-03 duplicate IDs are rejected.
{
    const duplicate = {
        planId: "PLAN-DUP",
        version: 1,
        goal: "duplicate ids",
        scope: "",
        steps: [
            { id: 1, objective: "one", expectedArtifact: "", completionCriteria: ["done"], dependencies: [] },
            { id: 1, objective: "two", expectedArtifact: "", completionCriteria: ["done"], dependencies: [] },
        ],
        acceptanceCriteria: ["done"],
    };
    check("duplicate step ids are rejected", throws(() => parsePlanModel(JSON.stringify(duplicate))));
}

// 21. PI-03 dependency cycles are rejected.
{
    const cycle = {
        planId: "PLAN-CYCLE",
        version: 1,
        goal: "cycle",
        scope: "",
        steps: [
            { id: 1, objective: "one", expectedArtifact: "", completionCriteria: ["done"], dependencies: [2] },
            { id: 2, objective: "two", expectedArtifact: "", completionCriteria: ["done"], dependencies: [1] },
        ],
        acceptanceCriteria: ["done"],
    };
    check("dependency cycles are rejected", throws(() => parsePlanModel(JSON.stringify(cycle))));
}

// 22. PI-03 invalid dependency references are rejected.
{
    const missing = {
        planId: "PLAN-MISSING",
        version: 1,
        goal: "missing dependency",
        scope: "",
        steps: [
            { id: 1, objective: "one", expectedArtifact: "", completionCriteria: ["done"], dependencies: [99] },
        ],
        acceptanceCriteria: ["done"],
    };
    check("missing dependency references are rejected", throws(() => parsePlanModel(JSON.stringify(missing))));
}

// 23. PI-03 oversize plans are rejected against the configured bound.
{
    const steps = Array.from({ length: 3 }, (_, i) => ({
        id: i + 1,
        objective: `step ${i + 1}`,
        expectedArtifact: "",
        completionCriteria: [`check ${i + 1}`],
        dependencies: [],
    }));
    const oversized = { planId: "PLAN-OVERSIZE", version: 1, goal: "too many", scope: "", steps, acceptanceCriteria: ["done"] };
    check("oversize structured plans are rejected", throws(() => parsePlanModel(JSON.stringify(oversized), { maxSteps: 2 })));
}

// 24. PI-03 legacy plans remain readable through the compatibility adapter.
{
    const legacyModel = legacyPlanToModel(samplePlan);
    check("legacy adapter emits a PlanModel", isPlanModel(legacyModel));
    check("legacy adapter migrates step_number to positive ids", legacyModel.steps[0].id === 1 && legacyModel.steps[1].id === 2);
    check("legacy adapter preserves objective from tldr", legacyModel.steps[0].objective.includes("Inspect how the planning step output is produced"));
    check("legacy adapter derives acceptance criteria from expected_outcome", legacyModel.acceptanceCriteria[0] === samplePlan.expected_outcome);
    const autoLegacy = parsePlanModel(JSON.stringify(samplePlan));
    check("parsePlanModel auto-migrates legacy plans", isPlanModel(autoLegacy) && autoLegacy.legacy === true);
    check("legacy plan steps remain readable via planStepsFromObject", planStepsFromObject(samplePlan).length === 2);
}

// 25. PI-03 structured plans parse through the plan-or-abort boundary.
{
    const structuredPlan = {
        planId: "PLAN-OR-ABORT",
        version: 1,
        goal: "or abort",
        scope: "",
        steps: [{ id: 1, objective: "one", expectedArtifact: "", completionCriteria: ["done"], dependencies: [] }],
        acceptanceCriteria: ["done"],
    };
    const parsed = parsePlanModelOrAbort(JSON.stringify(structuredPlan));
    check("parsePlanModelOrAbort accepts a structured plan", parsed.valid && parsed.result.kind === "plan" && parsed.result.plan.planId === "PLAN-OR-ABORT");
    const abort = parsePlanModelOrAbort('{"abort":true,"reason":"Cannot plan"}');
    check("parsePlanModelOrAbort preserves abort semantics", abort.valid && abort.result.kind === "abort" && abort.result.reason === "Cannot plan");
    const extracted = extractPlanModel(`\`\`\`json\n${JSON.stringify(structuredPlan)}\n\`\`\``);
    check("extractPlanModel extracts fenced structured JSON", extracted.valid && extracted.model.planId === "PLAN-OR-ABORT");
}

// 26. PI-03 execution-source-of-truth helpers: stable step IDs map to execution
//     indices and round-trip completion criteria without mutating the model.
{
    const model = parsePlanModel(JSON.stringify({
        planId: "PLAN-MAP",
        version: 3,
        goal: "map ids to execution indices",
        scope: "",
        steps: [
            { id: 10, objective: "first", expectedArtifact: "", completionCriteria: ["a"], dependencies: [] },
            { id: 20, objective: "second", expectedArtifact: "", completionCriteria: ["b", "c"], dependencies: [10] },
        ],
        acceptanceCriteria: ["done"],
    }));
    check("planModelStepIds returns every id in order", JSON.stringify(planModelStepIds(model)) === JSON.stringify([10, 20]));
    check("planModelStepIdByIndex maps an execution index to a stable id", planModelStepIdByIndex(model, 1) === 20);
    check("planModelStepIdByIndex returns null for an out-of-range index", planModelStepIdByIndex(model, 5) === null);
    check("planModelStepIndexById maps a stable id back to its execution index", planModelStepIndexById(model, 20) === 1);
    check("planModelStepIndexById returns -1 for a missing id", planModelStepIndexById(model, 99) === -1);
    check("planModelStepById resolves a stable step record", planModelStepById(model, 10)?.objective === "first");
    check("planModelCriteriaById round-trips criteria", JSON.stringify(planModelCriteriaById(model, 20)) === JSON.stringify(["b", "c"]));
    check("planModelCriteriaById returns [] for a missing id", planModelCriteriaById(model, 99).length === 0);
}

// 27. PI-03 focused replan helper preserves the completed prefix (IDs + criteria)
//     and assigns fresh unique IDs to the replacement steps.
{
    const model = parsePlanModel(JSON.stringify({
        planId: "PLAN-FOCUS",
        version: 1,
        goal: "focused replan",
        scope: "",
        steps: [
            { id: 1, objective: "done one", expectedArtifact: "", completionCriteria: ["done-1"], dependencies: [] },
            { id: 2, objective: "old two", expectedArtifact: "", completionCriteria: ["old-2"], dependencies: [1] },
            { id: 3, objective: "old three", expectedArtifact: "", completionCriteria: ["old-3"], dependencies: [2] },
        ],
        acceptanceCriteria: ["done"],
    }));
    const updated = replacePlanModelRemainingSteps(model, 1, ["new two", "new three"]);
    check("focused replan keeps completed step ids and criteria",
        updated.steps[0].id === 1 && JSON.stringify(updated.steps[0].completionCriteria) === JSON.stringify(["done-1"]));
    check("focused replan replaces remaining steps", updated.steps.length === 3 && updated.steps[1].objective === "new two");
    check("focused replan assigns fresh unique ids", updated.steps[1].id !== 2 && updated.steps[2].id !== 3 && updated.steps[1].id !== updated.steps[2].id);
    check("focused replan never mutates the original model", model.steps.length === 3 && model.steps[1].objective === "old two");
}

// 28. PI-03 phase-restart helper rebuilds the whole step list with fresh IDs and
//     optionally moves into a new phase while preserving plan identity.
{
    const model = parsePlanModel(JSON.stringify({
        planId: "PLAN-PHASE",
        version: 1,
        goal: "phase restart",
        scope: "",
        phase: "design",
        steps: [{ id: 7, objective: "old", expectedArtifact: "", completionCriteria: ["old"], dependencies: [] }],
        acceptanceCriteria: ["done"],
    }));
    const updated = rebuildPlanModelSteps(model, ["fresh one", "fresh two"], "verify");
    check("phase restart preserves planId/version", updated.planId === "PLAN-PHASE" && updated.version === 1);
    check("phase restart replaces all steps with fresh ids", updated.steps.length === 2 && updated.steps[0].id !== 7 && updated.steps[1].id !== updated.steps[0].id);
    check("phase restart moves into the requested phase", updated.phase === "verify");
    check("phase restart keeps the original model intact", model.steps.length === 1 && model.steps[0].id === 7);
}

if (failures === 0) { console.log("\nAll plan-parser tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
