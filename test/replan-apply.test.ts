// Unit tests for llm/replan-apply.ts: the pure replan decision/parse and
// plan-patch synthesis/progress helpers used by main.ts attemptReplan.
// Compiled into test/.replan-apply-build by the test:replan-apply npm script.
import assert from "node:assert/strict";
import {
    computeReplanProgress,
    parseReplanDecision,
    patchFromRevisedSteps,
    succeededStepIdsFromLedger,
} from "../llm/replan-apply.js";
import { normalizePlanPatch, tryApplyPlanPatch } from "../plan-patch.js";
import { parsePlanModel, planModelStepIds } from "../plan-model.js";

function baseModel() {
    return parsePlanModel(JSON.stringify({
        planId: "PLAN-RP",
        version: 4,
        goal: "replan demo",
        scope: "",
        steps: [
            { id: 1, objective: "completed one", expectedArtifact: "", completionCriteria: ["c1"], dependencies: [] },
            { id: 2, objective: "completed two", expectedArtifact: "", completionCriteria: ["c2"], dependencies: [1] },
            { id: 3, objective: "pending three", expectedArtifact: "", completionCriteria: ["c3"], dependencies: [2] },
            { id: 4, objective: "pending four", expectedArtifact: "", completionCriteria: ["c4"], dependencies: [3] },
        ],
        acceptanceCriteria: ["done"],
    }));
}

const COMPLETED = new Set<number>([1, 2]);

async function testParseReplanDecision(): Promise<void> {
    const abort = parseReplanDecision('{"abort":true,"reason":"cannot replan"}');
    assert.equal(abort.valid, true);
    if (abort.valid) {
        assert.equal(abort.kind, "abort");
        assert.equal(abort.reason, "cannot replan");
    }

    const steps = parseReplanDecision('{"steps":["a","b"]}');
    assert.equal(steps.valid, true);
    if (steps.valid) {
        assert.equal(steps.kind, "steps");
        assert.deepEqual(steps.steps, ["a", "b"]);
        assert.equal(steps.phase, undefined);
    }

    const withPhase = parseReplanDecision('{"steps":["a"],"phase":"verify"}');
    assert.equal(withPhase.valid, true);
    if (withPhase.valid) {
        assert.equal(withPhase.kind, "steps");
        assert.equal(withPhase.phase, "verify");
    }

    const patch = parseReplanDecision('{"planId":"PLAN-RP","reason":"focused","operations":[{"op":"cancel","stepId":4,"reason":"done elsewhere"}]}');
    assert.equal(patch.valid, true);
    if (patch.valid) {
        assert.equal(patch.kind, "patch");
        assert.equal(patch.patch.planId, "PLAN-RP");
        assert.equal(patch.patch.operations.length, 1);
        assert.equal(patch.patch.operations[0].op, "cancel");
    }

    assert.equal(parseReplanDecision('{"abort":"yes"}').valid, false);
    assert.equal(parseReplanDecision('{"operations":[{"op":"cancel","stepId":1,"reason":"x"}]}').valid, false);
    console.log("  ok: parseReplanDecision handles abort, steps, and patch responses");
}

async function testSucceededStepIdsFromLedger(): Promise<void> {
    const model = baseModel();
    const prefix = succeededStepIdsFromLedger(model, [
        { stepId: 1, outcome: "succeeded" },
        { stepId: 2, outcome: "succeeded" },
        { stepId: 3, outcome: "failed" },
    ]);
    assert.deepEqual([...prefix].sort(), [1, 2], "failed step stops the preserved prefix");

    const stepFallback = succeededStepIdsFromLedger(model, [
        { step: 1, outcome: "succeeded" },
    ]);
    assert.deepEqual([...stepFallback], [1], "legacy step-number entries fall back to model step ids");

    const nonContiguous = succeededStepIdsFromLedger(model, [
        { stepId: 1, outcome: "succeeded" },
        { stepId: 3, outcome: "succeeded" },
    ]);
    assert.deepEqual([...nonContiguous], [1], "non-contiguous completions stop at the first gap");
    console.log("  ok: succeededStepIdsFromLedger derives the contiguous verified prefix");
}

async function testPatchFromRevisedStepsPreservesCompletedWork(): Promise<void> {
    const model = baseModel();
    const patch = patchFromRevisedSteps(model, COMPLETED, ["revised three", "revised four"], "verify");

    assert.equal(patch.planId, "PLAN-RP");
    assert.equal(patch.baseVersion, 4);
    assert.equal(patch.phase, "verify");
    assert.deepEqual(patch.operations.map((operation) => operation.op), ["cancel", "cancel", "add", "add"]);

    const application = tryApplyPlanPatch(model, patch, COMPLETED);
    assert.equal(application.valid, true, `patch must apply: ${application.valid ? "" : application.reason}`);
    if (!application.valid) return;

    assert.deepEqual(planModelStepIds(application.model), [1, 2, 5, 6]);
    assert.equal(application.model.phase, "verify");
    assert.equal(application.model.steps[0], model.steps[0], "completed step 1 is preserved verbatim");
    assert.equal(application.model.steps[1], model.steps[1], "completed step 2 is preserved verbatim");
    assert.deepEqual([...application.applied.cancelledStepIds].sort(), [3, 4]);
    assert.deepEqual([...application.applied.addedStepIds].sort(), [5, 6]);
    assert.deepEqual([...application.applied.preservedCompletedStepIds].sort(), [1, 2]);
    console.log("  ok: patchFromRevisedSteps preserves verified work and replaces pending steps");
}

async function testComputeReplanProgress(): Promise<void> {
    const model = baseModel();

    // Identical models are no-progress.
    const same = computeReplanProgress(model, model, COMPLETED);
    assert.equal(same.progressed, false);
    assert.equal(same.coverageChanged, false);
    assert.equal(same.newEvidence, false);

    // A real objective change is progress.
    const changed = tryApplyPlanPatch(model, normalizePlanPatch({
        planId: "PLAN-RP",
        baseVersion: 4,
        reason: "revise",
        operations: [{ op: "modify", stepId: 3, updates: { objective: "changed objective" }, reason: "r", evidence: [] }],
    }), COMPLETED);
    assert.equal(changed.valid, true);
    if (changed.valid) {
        const progress = computeReplanProgress(model, changed.model, COMPLETED);
        assert.equal(progress.progressed, true);
        assert.equal(progress.coverageChanged, true);
    }

    // Cosmetic display-only rewording is no-progress.
    const cosmetic = tryApplyPlanPatch(model, normalizePlanPatch({
        planId: "PLAN-RP",
        baseVersion: 4,
        reason: "display only",
        operations: [{ op: "modify", stepId: 3, updates: { summary: "cosmetic reword" }, reason: "r", evidence: [] }],
    }), COMPLETED);
    assert.equal(cosmetic.valid, true);
    if (cosmetic.valid) {
        const progress = computeReplanProgress(model, cosmetic.model, COMPLETED);
        assert.equal(progress.progressed, false);
        assert.equal(progress.coverageChanged, false);
    }

    // New evidence on a patch counts as progress even without a coverage change.
    const evidence = tryApplyPlanPatch(model, normalizePlanPatch({
        planId: "PLAN-RP",
        baseVersion: 4,
        reason: "evidence",
        operations: [{ op: "modify", stepId: 3, updates: { summary: "updated" }, reason: "r", evidence: ["new observation"] }],
    }), COMPLETED);
    assert.equal(evidence.valid, true);
    if (evidence.valid) {
        const progress = computeReplanProgress(model, evidence.model, COMPLETED, evidence.applied.patch);
        assert.equal(progress.progressed, true);
        assert.equal(progress.newEvidence, true);
    }
    console.log("  ok: computeReplanProgress uses objective/criterion coverage plus new evidence");
}

async function main(): Promise<void> {
    await testParseReplanDecision();
    await testSucceededStepIdsFromLedger();
    await testPatchFromRevisedStepsPreservesCompletedWork();
    await testComputeReplanProgress();
    console.log("Replan-apply tests passed");
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
