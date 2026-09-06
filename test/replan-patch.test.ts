// Behavioral tests for the replan patch loop (PI-05). These drive the same
// pure replan decision/application pipeline that main.ts's attemptReplan uses,
// through fake LLM clients that return canned replan responses, so the
// control-flow invariants can be asserted without booting the CLI:
//
//   - A phase/label change preserves completed work verbatim and execution
//     resumes from the first pending step, so completed side effects are never
//     repeated and the ledgers are never cleared.
//   - Cosmetic (display-only) rewordings do not re-execute completed steps.
//   - Repeated equivalent paraphrases that do not change pending objective/
//     criterion coverage exhaust the bounded no-progress retry budget and
//     abort as stuck, while genuine progress resets the budget.
//
// Compiled into test/.replan-patch-build by the test:replan-patch npm script.
import assert from "node:assert/strict";
import {
    computeReplanProgress,
    parseReplanDecision,
    patchFromRevisedSteps,
    succeededStepIdsFromLedger,
    type ReplanProgress,
} from "../llm/replan-apply.js";
import {
    normalizePlanPatch,
    tryApplyPlanPatch,
    type PlanPatch,
} from "../plan-patch.js";
import {
    parsePlanModel,
    planModelStepIdByIndex,
    planModelStepIds,
    planModelStepIndexById,
    planStepsFromModel,
    type PlanModel,
} from "../plan-model.js";
import {
    nextConsecutiveNoProgressReplans,
    throwIfConsecutiveNoProgressReplansReached,
} from "../llm/replan-abort.js";
import { RunAbortError } from "../llm/run-abort.js";

interface ReplanRunState {
    planModel: PlanModel;
    activeSteps: string[];
    completedSteps: unknown[];
    executionAttempts: unknown[];
    replanAttemptCount: number;
    consecutiveNoProgressReplans: number;
    planPhase: string | number | undefined;
    executedStepIds: number[];
    replanHistory: Array<Record<string, unknown>>;
}

interface AppliedReplan {
    resumeIndex: number;
    phaseChange: boolean;
    progress: ReplanProgress;
    model: PlanModel;
}

interface FakeClientResponse {
    readonly text: string;
}

/** A fake LLM client that returns canned replan responses in call order. */
class FakeReplanClient {
    readonly calls: string[] = [];

    constructor(readonly responses: readonly string[]) {
        if (responses.length === 0) throw new Error("FakeReplanClient needs at least one response");
    }

    create(): FakeClientResponse {
        const index = Math.min(this.calls.length, this.responses.length - 1);
        const text = this.responses[index];
        this.calls.push(text);
        return { text };
    }
}

function baseModel(): PlanModel {
    return parsePlanModel(JSON.stringify({
        planId: "PLAN-BEHAVE-1",
        version: 4,
        goal: "behavioral replan demo",
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

function makeState(model: PlanModel): ReplanRunState {
    return {
        planModel: model,
        activeSteps: planStepsFromModel(model),
        completedSteps: [],
        executionAttempts: [],
        replanAttemptCount: 0,
        consecutiveNoProgressReplans: 0,
        planPhase: model.phase,
        executedStepIds: [],
        replanHistory: [],
    };
}

/**
 * Apply one replan decision exactly the way main.ts's attemptReplan does for a
 * stored PlanModel: derive the verified prefix, parse the decision, apply the
 * validated plan patch, compute progress, advance the no-progress counter, and
 * abort as stuck when the bounded budget is exhausted. The fake client is the
 * only source of replan responses, so no real LLM call is involved.
 */
function applyReplanDecision(
    state: ReplanRunState,
    client: FakeReplanClient,
    maxConsecutiveNoProgress = 2,
): AppliedReplan {
    const planModel = state.planModel;
    const preservedStepIds = succeededStepIdsFromLedger(planModel, state.completedSteps);
    const step = preservedStepIds.size + 1;

    const response = client.create();
    const decision = parseReplanDecision(response.text);
    if (!decision.valid) throw new Error(`Replan response was invalid: ${decision.reason}`);
    if (decision.kind === "abort") {
        throw new RunAbortError("unable-to-complete", "replan", decision.reason, { step });
    }

    const patch: PlanPatch = decision.kind === "patch"
        ? decision.patch
        : patchFromRevisedSteps(planModel, preservedStepIds, decision.steps, decision.phase);

    const application = tryApplyPlanPatch(planModel, patch, preservedStepIds);
    if (!application.valid) throw new Error(`Replan patch was invalid: ${application.reason}`);

    const nextModel = application.model;
    const progress = computeReplanProgress(planModel, nextModel, preservedStepIds, patch);
    const phaseChange = nextModel.phase !== state.planPhase;

    // Rebuild the rendered projection from the model and resume from the first
    // pending step; completed steps and attempt history are deliberately left
    // untouched by the replan.
    state.activeSteps = planStepsFromModel(nextModel);
    state.planModel = nextModel;
    state.planPhase = nextModel.phase;
    const resumeIndex = preservedStepIds.size;

    state.consecutiveNoProgressReplans = nextConsecutiveNoProgressReplans(
        progress.progressed,
        state.consecutiveNoProgressReplans,
    );
    state.replanAttemptCount += 1;
    state.replanHistory.push({
        attempt: state.replanAttemptCount,
        resumeIndex,
        phaseChange,
        noProgress: !progress.progressed,
        progressReason: progress.reason,
    });

    throwIfConsecutiveNoProgressReplansReached(
        state.consecutiveNoProgressReplans,
        maxConsecutiveNoProgress,
        step,
    );

    return { resumeIndex, phaseChange, progress, model: nextModel };
}

/** Record a terminal succeeded execution side effect and its ledger entries. */
function recordSucceededExecution(state: ReplanRunState, stepId: number): void {
    const index = planModelStepIndexById(state.planModel, stepId);
    if (index < 0) throw new Error(`unknown step id ${stepId}`);
    state.executedStepIds.push(stepId);
    state.completedSteps.push({
        stepId,
        step: index + 1,
        text: state.activeSteps[index],
        outcome: "succeeded",
    });
    state.executionAttempts.push({ stepId, step: index + 1, outcome: "succeeded" });
}

/** Execute every step from `resumeIndex` onward, recording side effects. */
function executePendingFrom(state: ReplanRunState, resumeIndex: number): void {
    for (let index = resumeIndex; index < state.activeSteps.length; index += 1) {
        const stepId = planModelStepIdByIndex(state.planModel, index) ?? index + 1;
        recordSucceededExecution(state, stepId);
    }
}

function ledgersSnapshot(state: ReplanRunState): { completedSteps: unknown[]; executionAttempts: unknown[] } {
    return {
        completedSteps: state.completedSteps.map((entry) => ({ ...(entry as Record<string, unknown>) })),
        executionAttempts: state.executionAttempts.map((entry) => ({ ...(entry as Record<string, unknown>) })),
    };
}

async function testPhaseChangePreservesCompletedSideEffects(): Promise<void> {
    const model = baseModel();
    const state = makeState(model);
    recordSucceededExecution(state, 1);
    recordSucceededExecution(state, 2);
    const before = ledgersSnapshot(state);

    const patch = normalizePlanPatch({
        planId: "PLAN-BEHAVE-1",
        baseVersion: 4,
        reason: "move into the verify phase",
        phase: "verify",
        operations: [
            { op: "cancel", stepId: 3, reason: "replace pending three", evidence: [] },
            { op: "cancel", stepId: 4, reason: "replace pending four", evidence: [] },
            {
                op: "add",
                step: { id: 5, objective: "revised three", expectedArtifact: "", completionCriteria: ["c5"], dependencies: [2] },
                reason: "revised three",
                evidence: [],
            },
            {
                op: "add",
                step: { id: 6, objective: "revised four", expectedArtifact: "", completionCriteria: ["c6"], dependencies: [5] },
                reason: "revised four",
                evidence: [],
            },
        ],
    });
    const applied = applyReplanDecision(state, new FakeReplanClient([JSON.stringify(patch)]));

    assert.equal(applied.phaseChange, true, "moving into 'verify' is a phase change");
    assert.equal(applied.resumeIndex, 2, "resume index is the preserved completed prefix");
    assert.equal(state.planPhase, "verify");
    assert.deepEqual(planModelStepIds(state.planModel), [1, 2, 5, 6]);
    assert.equal(state.planModel.steps[0], model.steps[0], "completed step 1 is preserved verbatim");
    assert.equal(state.planModel.steps[1], model.steps[1], "completed step 2 is preserved verbatim");
    assert.deepEqual(state.completedSteps, before.completedSteps, "completedSteps ledger survives a phase change");
    assert.deepEqual(state.executionAttempts, before.executionAttempts, "executionAttempts history survives a phase change");

    // Resume like runExecutionPhase does after an applied replan.
    executePendingFrom(state, applied.resumeIndex);
    assert.deepEqual(state.executedStepIds, [1, 2, 5, 6], "completed side effects are never repeated");
    assert.deepEqual(
        (state.completedSteps as Array<{ stepId?: number }>).map((entry) => entry.stepId),
        [1, 2, 5, 6],
        "completion ledger contains each executed step exactly once",
    );
    console.log("  ok: phase/label change preserves completed work and never repeats side effects");
}

async function testLegacyRevisedStepsPhaseChangePreservesCompletedWork(): Promise<void> {
    const model = baseModel();
    const state = makeState(model);
    recordSucceededExecution(state, 1);
    const before = ledgersSnapshot(state);

    // Legacy revised-steps response proposing a new phase. patchFromRevisedSteps
    // must cancel every pending step and add fresh IDs, preserving step 1.
    const client = new FakeReplanClient([
        JSON.stringify({ steps: ["legacy revised two", "legacy revised three"], phase: "verify" }),
    ]);
    const applied = applyReplanDecision(state, client);

    assert.equal(applied.phaseChange, true);
    assert.equal(applied.resumeIndex, 1);
    assert.deepEqual(planModelStepIds(state.planModel), [1, 5, 6]);
    assert.equal(state.planModel.steps[0], model.steps[0], "completed step 1 is preserved verbatim");
    assert.deepEqual(state.completedSteps, before.completedSteps, "completedSteps ledger survives a legacy phase change");
    assert.deepEqual(state.executionAttempts, before.executionAttempts, "executionAttempts history survives a legacy phase change");

    executePendingFrom(state, applied.resumeIndex);
    assert.deepEqual(state.executedStepIds, [1, 5, 6], "legacy phase change never repeats completed side effects");
    console.log("  ok: legacy revised-steps phase change preserves completed work");
}

async function testCosmeticRewordingDoesNotRepeatCompletedSideEffects(): Promise<void> {
    const model = baseModel();
    const state = makeState(model);
    recordSucceededExecution(state, 1);
    const before = ledgersSnapshot(state);

    // A display-only `summary` rewrite changes only rendered strings, not the
    // pending objective/criterion coverage, so it must not move the resume
    // index or replay completed work.
    const patch = normalizePlanPatch({
        planId: "PLAN-BEHAVE-1",
        baseVersion: 4,
        reason: "display-only reword",
        operations: [
            { op: "modify", stepId: 2, updates: { summary: "cosmetic reword" }, reason: "display", evidence: [] },
        ],
    });
    const applied = applyReplanDecision(state, new FakeReplanClient([JSON.stringify(patch)]));

    assert.equal(applied.progress.progressed, false, "cosmetic reword is not replan progress");
    assert.equal(applied.resumeIndex, 1, "resume index is unchanged for a cosmetic reword");
    assert.deepEqual(state.completedSteps, before.completedSteps, "completedSteps ledger is not cleared");
    assert.deepEqual(state.executionAttempts, before.executionAttempts, "executionAttempts history is not cleared");

    executePendingFrom(state, applied.resumeIndex);
    assert.deepEqual(state.executedStepIds, [1, 2, 3, 4], "cosmetic reword never repeats completed side effects");
    console.log("  ok: cosmetic display-only rewording does not repeat completed side effects");
}

function equivalentParaphrase(text: string): string {
    // Same canonical objective (case/whitespace-insensitive), different bytes.
    return `  ${text.toUpperCase().replace(/\s+/g, "   ")}  `;
}

function paraphrasePatchText(state: ReplanRunState, stepId: number): string {
    const step = state.planModel.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`missing step ${stepId}`);
    return JSON.stringify({
        planId: state.planModel.planId,
        baseVersion: state.planModel.version,
        reason: "equivalent paraphrase of a pending step",
        operations: [
            {
                op: "modify",
                stepId,
                updates: { objective: equivalentParaphrase(step.objective) },
                reason: "paraphrase",
                evidence: [],
            },
        ],
    });
}

async function testRepeatedEquivalentParaphrasesExhaustNoProgressBudget(): Promise<void> {
    const model = baseModel();
    const state = makeState(model);
    recordSucceededExecution(state, 1);

    // First equivalent paraphrase: no coverage change, so it is no-progress.
    const first = applyReplanDecision(state, new FakeReplanClient([paraphrasePatchText(state, 2)]));
    assert.equal(first.progress.progressed, false);
    assert.equal(state.consecutiveNoProgressReplans, 1);

    // A genuinely different objective resets the no-progress budget.
    const progressPatch = normalizePlanPatch({
        planId: "PLAN-BEHAVE-1",
        baseVersion: 4,
        reason: "real revision",
        operations: [
            { op: "modify", stepId: 2, updates: { objective: "step two objective revised" }, reason: "revise", evidence: ["new observation"] },
        ],
    });
    const progress = applyReplanDecision(state, new FakeReplanClient([JSON.stringify(progressPatch)]));
    assert.equal(progress.progress.progressed, true);
    assert.equal(state.consecutiveNoProgressReplans, 0, "real progress resets the budget");

    // Two more equivalent paraphrases: the second one must exhaust the budget
    // and abort as stuck, exactly like main.ts's bounded no-progress retry.
    applyReplanDecision(state, new FakeReplanClient([paraphrasePatchText(state, 2)]));
    assert.equal(state.consecutiveNoProgressReplans, 1);

    let stuck: RunAbortError | null = null;
    try {
        applyReplanDecision(state, new FakeReplanClient([paraphrasePatchText(state, 2)]));
    } catch (error) {
        if (error instanceof RunAbortError) stuck = error;
        else throw error;
    }

    assert.ok(stuck, "repeated equivalent paraphrases must abort as stuck");
    assert.equal(stuck!.kind, "stuck");
    assert.equal(stuck!.phase, "replan");
    assert.equal(stuck!.step, 2, "the stuck abort names the step being replanned");
    assert.equal(state.consecutiveNoProgressReplans, 2);
    assert.equal(state.replanAttemptCount, 4, "every replan attempt is recorded, including the aborting one");
    assert.equal(state.replanHistory.length, 4);
    assert.equal(state.replanHistory[3].noProgress, true, "the aborting attempt is recorded as no-progress");
    console.log("  ok: repeated equivalent paraphrases exhaust the bounded no-progress budget and abort as stuck");
}

async function main(): Promise<void> {
    await testPhaseChangePreservesCompletedSideEffects();
    await testLegacyRevisedStepsPhaseChangePreservesCompletedWork();
    await testCosmeticRewordingDoesNotRepeatCompletedSideEffects();
    await testRepeatedEquivalentParaphrasesExhaustNoProgressBudget();
    console.log("Replan behavioral tests passed");
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
