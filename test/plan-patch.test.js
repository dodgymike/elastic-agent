// Unit tests for the validated plan-patch representation (plan-patch.ts):
//   normalizePlanPatch   - structural parse/validation of a patch object
//   parsePlanPatch       - JSON extraction + parse + normalize
//   validatePlanPatch    - non-throwing model-relative validation
//   applyPlanPatch       - apply add/modify/supersede/cancel to a PlanModel
//   tryApplyPlanPatch    - non-throwing application wrapper
// Compiled into test/.plan-patch-build by the test:plan-patch npm script.
const {
    normalizePlanPatch,
    parsePlanPatch,
    validatePlanPatch,
    applyPlanPatch,
    tryApplyPlanPatch,
} = require("./.plan-patch-build/plan-patch.js");
const {
    parsePlanModel,
    planModelStepIds,
} = require("./.plan-patch-build/plan-model.js");

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}
function throws(fn) {
    try { fn(); return false; } catch { return true; }
}

function baseModel() {
    return parsePlanModel(JSON.stringify({
        planId: "PLAN-PATCH-1",
        version: 4,
        goal: "patch demo",
        scope: "",
        steps: [
            { id: 1, objective: "completed one", expectedArtifact: "", completionCriteria: ["c1"], dependencies: [] },
            { id: 2, objective: "completed two", expectedArtifact: "", completionCriteria: ["c2"], dependencies: [1] },
            { id: 3, objective: "pending three", expectedArtifact: "art3", completionCriteria: ["c3"], dependencies: [2] },
            { id: 4, objective: "pending four", expectedArtifact: "", completionCriteria: ["c4"], dependencies: [3] },
        ],
        acceptanceCriteria: ["done"],
    }));
}

const COMPLETED = [1, 2];

function patchFor(operations, extra = {}) {
    return normalizePlanPatch({
        planId: "PLAN-PATCH-1",
        baseVersion: 4,
        reason: "focused replan",
        operations,
        ...extra,
    });
}

// 1. normalizePlanPatch parses all four operation kinds with reason + evidence.
{
    const patch = patchFor([
        { op: "add", step: { id: 5, objective: "added", expectedArtifact: "", completionCriteria: ["a"], dependencies: [] }, reason: "add reason", evidence: ["ev-add"] },
        { op: "modify", stepId: 3, updates: { objective: "modified" }, reason: "modify reason", evidence: ["ev-mod"] },
        { op: "supersede", stepId: 4, replacement: { id: 40, objective: "replaced", expectedArtifact: "", completionCriteria: ["r"], dependencies: [3] }, reason: "supersede reason", evidence: ["ev-sup"] },
        { op: "cancel", stepId: 5, reason: "cancel reason", evidence: ["ev-cancel"] },
    ]);
    check("normalizePlanPatch accepts all four operation kinds", patch.operations.length === 4);
    check("normalizePlanPatch preserves op kinds in order", patch.operations.map((o) => o.op).join(",") === "add,modify,supersede,cancel");
    check("normalizePlanPatch preserves per-operation reason", patch.operations[0].reason === "add reason");
    check("normalizePlanPatch preserves per-operation evidence", patch.operations[0].evidence[0] === "ev-add");
    check("normalizePlanPatch preserves baseVersion", patch.baseVersion === 4);
}

// 2. parsePlanPatch extracts fenced JSON with surrounding prose.
{
    const patch = parsePlanPatch(`Here is the patch:\n\`\`\`json\n${JSON.stringify({
        planId: "PLAN-PATCH-1",
        reason: "focused replan",
        operations: [{ op: "cancel", stepId: 4, reason: "no longer needed" }],
    })}\n\`\`\`\nDone.`);
    check("parsePlanPatch extracts fenced JSON", patch.planId === "PLAN-PATCH-1" && patch.operations.length === 1 && patch.operations[0].op === "cancel");
}

// 3. add appends a new pending step and preserves the completed prefix.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "add", step: { id: 5, objective: "added step", expectedArtifact: "", completionCriteria: ["a"], dependencies: [2] }, reason: "need an extra step" },
    ]);
    const { model: next, applied } = applyPlanPatch(model, patch, COMPLETED);
    check("add appends a new pending step", JSON.stringify(planModelStepIds(next)) === JSON.stringify([1, 2, 3, 4, 5]));
    check("add preserves completed prefix verbatim", next.steps[0] === model.steps[0] && next.steps[1] === model.steps[1]);
    check("add records the added id", JSON.stringify(applied.addedStepIds) === JSON.stringify([5]));
    check("add records preserved completed ids", JSON.stringify(applied.preservedCompletedStepIds) === JSON.stringify([1, 2]));
    check("add never mutates the input model", model.steps.length === 4);
}

// 4. add after/before positions the new step relative to a pending step.
{
    const model = baseModel();
    const after = applyPlanPatch(model, patchFor([
        { op: "add", after: 3, step: { id: 5, objective: "after three", expectedArtifact: "", completionCriteria: ["a"], dependencies: [] }, reason: "insert" },
    ]), COMPLETED).model;
    check("add 'after' inserts after the anchor", JSON.stringify(planModelStepIds(after)) === JSON.stringify([1, 2, 3, 5, 4]));
    const before = applyPlanPatch(model, patchFor([
        { op: "add", before: 4, step: { id: 5, objective: "before four", expectedArtifact: "", completionCriteria: ["a"], dependencies: [] }, reason: "insert" },
    ]), COMPLETED).model;
    check("add 'before' inserts before the anchor", JSON.stringify(planModelStepIds(before)) === JSON.stringify([1, 2, 3, 5, 4]));
}

// 5. modify updates pending step fields while keeping its stable ID.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "modify", stepId: 4, updates: { objective: "pending four revised", completionCriteria: ["c4a", "c4b"], dependencies: [3] }, reason: "tighten criteria" },
    ]);
    const { model: next, applied } = applyPlanPatch(model, patch, COMPLETED);
    check("modify keeps the step id", planModelStepIds(next).join(",") === "1,2,3,4");
    check("modify updates the objective", next.steps[3].objective === "pending four revised");
    check("modify updates completion criteria", JSON.stringify(next.steps[3].completionCriteria) === JSON.stringify(["c4a", "c4b"]));
    check("modify records the modified id", JSON.stringify(applied.modifiedStepIds) === JSON.stringify([4]));
    check("modify preserves completed prefix verbatim", next.steps[0] === model.steps[0] && next.steps[1] === model.steps[1]);
    check("modify never mutates the input model", model.steps[3].objective === "pending four");
}

// 6. supersede retires a pending step and inserts a fresh id at its position.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "supersede", stepId: 4, replacement: { id: 40, objective: "replacement four", expectedArtifact: "", completionCriteria: ["r4"], dependencies: [3] }, reason: "scope changed" },
    ]);
    const { model: next, applied } = applyPlanPatch(model, patch, COMPLETED);
    check("supersede replaces at the same position", JSON.stringify(planModelStepIds(next)) === JSON.stringify([1, 2, 3, 40]));
    check("supersede records the retired id", JSON.stringify(applied.supersededStepIds) === JSON.stringify([4]));
    check("supersede records the introduced id", JSON.stringify(applied.addedStepIds) === JSON.stringify([40]));
    check("supersede preserves completed prefix verbatim", next.steps[0] === model.steps[0] && next.steps[1] === model.steps[1]);
}

// 7. cancel removes a pending step that nothing else depends on.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "cancel", stepId: 4, reason: "no longer needed" },
    ]);
    const { model: next, applied } = applyPlanPatch(model, patch, COMPLETED);
    check("cancel removes the pending step", JSON.stringify(planModelStepIds(next)) === JSON.stringify([1, 2, 3]));
    check("cancel records the cancelled id", JSON.stringify(applied.cancelledStepIds) === JSON.stringify([4]));
    check("cancel preserves completed prefix verbatim", next.steps[0] === model.steps[0] && next.steps[1] === model.steps[1]);
}

// 8. a patch can carry a new top-level phase; completed steps are still preserved.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "cancel", stepId: 4, reason: "phase transition" },
    ], { phase: "verify" });
    const next = applyPlanPatch(model, patch, COMPLETED).model;
    check("phase patch moves the model into the new phase", next.phase === "verify");
    check("phase patch preserves plan identity", next.planId === "PLAN-PATCH-1" && next.version === 4);
    check("phase patch preserves completed steps", next.steps[0] === model.steps[0] && next.steps[1] === model.steps[1]);
}

// 9. duplicate IDs are rejected: add collides with an existing id.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "add", step: { id: 1, objective: "dup", expectedArtifact: "", completionCriteria: ["d"], dependencies: [] }, reason: "duplicate" },
    ]);
    const validation = validatePlanPatch(patch, model, COMPLETED);
    check("add with existing id is rejected", validation.valid === false && /duplicate/.test(validation.reason));
    check("add with existing id does not apply", throws(() => applyPlanPatch(model, patch, COMPLETED)));
}

// 10. duplicate IDs are rejected: two adds introduce the same id.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "add", step: { id: 50, objective: "one", expectedArtifact: "", completionCriteria: ["d"], dependencies: [] }, reason: "one" },
        { op: "add", step: { id: 50, objective: "two", expectedArtifact: "", completionCriteria: ["d"], dependencies: [] }, reason: "two" },
    ]);
    check("two adds with the same id are rejected", validatePlanPatch(patch, model, COMPLETED).valid === false);
}

// 11. duplicate targets are rejected: two modifies target the same step.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "modify", stepId: 3, updates: { objective: "a" }, reason: "a" },
        { op: "modify", stepId: 3, updates: { objective: "b" }, reason: "b" },
    ]);
    check("two modifies targeting one step are rejected", validatePlanPatch(patch, model, COMPLETED).valid === false);
}

// 12. supersede replacement id must be fresh: equal to target is rejected.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "supersede", stepId: 3, replacement: { id: 3, objective: "same id", expectedArtifact: "", completionCriteria: ["r"], dependencies: [] }, reason: "bad" },
    ]);
    check("supersede with the target's own id is rejected", validatePlanPatch(patch, model, COMPLETED).valid === false);
}

// 13. supersede replacement id colliding with a surviving step is rejected.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "supersede", stepId: 3, replacement: { id: 4, objective: "collision", expectedArtifact: "", completionCriteria: ["r"], dependencies: [] }, reason: "bad" },
    ]);
    check("supersede replacement colliding with a surviving id is rejected", validatePlanPatch(patch, model, COMPLETED).valid === false);
}

// 14. cycles introduced by a patch are rejected.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "modify", stepId: 3, updates: { dependencies: [4] }, reason: "creates 3<->4 cycle" },
    ]);
    const validation = validatePlanPatch(patch, model, COMPLETED);
    check("cycle introduced by a patch is rejected", validation.valid === false && /cycle/.test(validation.reason));
}

// 15. invalid dependency references introduced by a patch are rejected.
{
    const model = baseModel();
    const dangling = patchFor([
        { op: "modify", stepId: 4, updates: { dependencies: [999] }, reason: "dangling" },
    ]);
    check("dangling dependency reference is rejected", validatePlanPatch(dangling, model, COMPLETED).valid === false);

    const cancelledReferent = patchFor([
        { op: "cancel", stepId: 3, reason: "remove referent" },
    ]);
    const cancelled = validatePlanPatch(cancelledReferent, model, COMPLETED);
    check("cancelling a step still referenced is rejected", cancelled.valid === false && /missing step 3/.test(cancelled.reason));
}

// 16. self-dependency introduced by a patch is rejected.
{
    const model = baseModel();
    const patch = patchFor([
        { op: "modify", stepId: 3, updates: { dependencies: [3] }, reason: "self dependency" },
    ]);
    check("self-dependency is rejected", validatePlanPatch(patch, model, COMPLETED).valid === false);
}

// 17. patches targeting completed steps are rejected for every operation kind.
{
    const model = baseModel();
    const modify = patchFor([{ op: "modify", stepId: 1, updates: { objective: "changed" }, reason: "bad" }]);
    check("modify targeting a completed step is rejected", validatePlanPatch(modify, model, COMPLETED).valid === false);
    const supersede = patchFor([{ op: "supersede", stepId: 2, replacement: { id: 20, objective: "new", expectedArtifact: "", completionCriteria: ["r"], dependencies: [] }, reason: "bad" }]);
    check("supersede targeting a completed step is rejected", validatePlanPatch(supersede, model, COMPLETED).valid === false);
    const cancel = patchFor([{ op: "cancel", stepId: 2, reason: "bad" }]);
    check("cancel targeting a completed step is rejected", validatePlanPatch(cancel, model, COMPLETED).valid === false);
}

// 18. a mismatched planId or baseVersion is rejected.
{
    const model = baseModel();
    const wrongPlan = normalizePlanPatch({ planId: "OTHER", reason: "bad", operations: [{ op: "cancel", stepId: 4, reason: "x" }] });
    check("mismatched planId is rejected", validatePlanPatch(wrongPlan, model, COMPLETED).valid === false);

    const wrongVersion = patchFor([{ op: "cancel", stepId: 4, reason: "x" }], { baseVersion: 3 });
    check("mismatched baseVersion is rejected", validatePlanPatch(wrongVersion, model, COMPLETED).valid === false);
}

// 19. add anchors must reference a pending step.
{
    const model = baseModel();
    const afterCompleted = patchFor([
        { op: "add", after: 1, step: { id: 5, objective: "x", expectedArtifact: "", completionCriteria: ["a"], dependencies: [] }, reason: "bad" },
    ]);
    check("add anchored after a completed step is rejected", validatePlanPatch(afterCompleted, model, COMPLETED).valid === false);
    const afterMissing = patchFor([
        { op: "add", after: 99, step: { id: 5, objective: "x", expectedArtifact: "", completionCriteria: ["a"], dependencies: [] }, reason: "bad" },
    ]);
    check("add anchored after a missing step is rejected", validatePlanPatch(afterMissing, model, COMPLETED).valid === false);
}

// 20. structural parse errors are rejected by normalizePlanPatch.
{
    check("empty operations array is rejected", throws(() => normalizePlanPatch({ planId: "P", reason: "x", operations: [] })));
    check("missing operations is rejected", throws(() => normalizePlanPatch({ planId: "P", reason: "x" })));
    check("unknown operation kind is rejected", throws(() => normalizePlanPatch({ planId: "P", reason: "x", operations: [{ op: "rename", stepId: 1, reason: "x" }] })));
    check("operation missing reason is rejected", throws(() => normalizePlanPatch({ planId: "P", reason: "x", operations: [{ op: "cancel", stepId: 1 }] })));
    check("unknown top-level field is rejected", throws(() => normalizePlanPatch({ planId: "P", reason: "x", operations: [{ op: "cancel", stepId: 1, reason: "x" }], status: "done" })));
    check("step spec with runtime field is rejected", throws(() => normalizePlanPatch({
        planId: "P", reason: "x",
        operations: [{ op: "add", reason: "x", step: { id: 5, objective: "x", expectedArtifact: "", completionCriteria: ["a"], dependencies: [], status: "done" } }],
    })));
    check("modify updates with id are rejected", throws(() => normalizePlanPatch({
        planId: "P", reason: "x",
        operations: [{ op: "modify", reason: "x", stepId: 3, updates: { id: 9, objective: "x" } }],
    })));
    check("add with both after and before is rejected", throws(() => normalizePlanPatch({
        planId: "P", reason: "x",
        operations: [{ op: "add", reason: "x", after: 3, before: 4, step: { id: 5, objective: "x", expectedArtifact: "", completionCriteria: ["a"], dependencies: [] } }],
    })));
    check("step spec missing completion criteria is rejected", throws(() => normalizePlanPatch({
        planId: "P", reason: "x",
        operations: [{ op: "add", reason: "x", step: { id: 5, objective: "x", expectedArtifact: "" } }],
    })));
    check("patch with non-object operation is rejected", throws(() => normalizePlanPatch({ planId: "P", reason: "x", operations: [null] })));
}

// 21. tryApplyPlanPatch returns a structured result for valid and invalid patches.
{
    const model = baseModel();
    const ok = tryApplyPlanPatch(model, patchFor([{ op: "cancel", stepId: 4, reason: "x" }]), COMPLETED);
    check("tryApplyPlanPatch returns valid result", ok.valid === true && JSON.stringify(planModelStepIds(ok.model)) === JSON.stringify([1, 2, 3]));
    check("tryApplyPlanPatch result carries applied summary", JSON.stringify(ok.applied.cancelledStepIds) === JSON.stringify([4]));

    const bad = tryApplyPlanPatch(model, patchFor([{ op: "cancel", stepId: 1, reason: "x" }]), COMPLETED);
    check("tryApplyPlanPatch returns invalid result", bad.valid === false && typeof bad.reason === "string");
}

// 22. the patched model keeps plan identity and acceptance criteria intact.
{
    const model = baseModel();
    const patch = patchFor([{ op: "modify", stepId: 4, updates: { objective: "revised" }, reason: "x" }]);
    const next = applyPlanPatch(model, patch, COMPLETED).model;
    check("patch preserves planId", next.planId === "PLAN-PATCH-1");
    check("patch preserves version", next.version === 4);
    check("patch preserves goal", next.goal === "patch demo");
    check("patch preserves acceptance criteria", JSON.stringify(next.acceptanceCriteria) === JSON.stringify(["done"]));
    check("patch preserves schemaVersion", next.schemaVersion === 1);
}

if (failures === 0) { console.log("\nAll plan-patch tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
