// Focused tests for src/runtime/run-state-reconcile.ts (PI-06): the pure resume-decision
// layer built on top of the versioned durable run-state module. These tests
// exercise the reconcileRecovery classifications (absent/fresh, replay-safe,
// terminal succeeded/failed/blocked/invalid, uncertain pending effects, and
// untrusted/incompatible artifacts), the pending-effect resolution via
// injected integration inspectors, and the deterministic idempotency keys used
// by idempotent Git commits and Spec Keeper tasks.
//
// Compiled into test/.run-state-reconcile-build by the
// test:run-state-reconcile npm script.
import assert from "node:assert/strict";
import {
    buildToolEffectRecord,
    deriveAttemptPhase,
    GIT_COMMIT_TRAILER_NAME,
    gitCommitTrailer,
    isToolEffectEvidence,
    reconcileRecovery,
    resolvePendingEffects,
    runIdempotencyKey,
    sanitizeIdempotencyToken,
    specKeeperStepTaskKey,
    terminalRecordForStep,
    TOOL_EFFECT_EVIDENCE_KIND,
    toolEffectReference,
    toolEffectsForAttempt,
    toolEffectsFromState,
} from "../../src/runtime/run-state-reconcile.js";
import {
    createRunState,
    type LoadRunStateResult,
    type RunState,
} from "../../src/runtime/run-state.js";

const identity: RunState["workspaceIdentity"] = {
    workspacePath: "/srv/workspace",
    branch: "main",
    worktreePath: null,
};

function baseState(overrides: {
    activeStepId?: number | null;
    attemptId?: string | null;
    workspaceIdentity?: RunState["workspaceIdentity"];
    evidenceReferences?: RunState["evidenceReferences"];
    completedSteps?: RunState["completedSteps"];
} = {}): RunState {
    return createRunState({
        planId: "PLAN-RECONCILE",
        planVersion: 2,
        activeStepId: overrides.activeStepId === undefined ? 2 : overrides.activeStepId,
        attemptId: overrides.attemptId === undefined ? "attempt-1" : overrides.attemptId,
        workspaceIdentity: overrides.workspaceIdentity ?? identity,
        evidenceReferences: overrides.evidenceReferences ?? [],
        completedSteps: overrides.completedSteps ?? [],
        updatedAt: "2026-01-01T00:00:00.000Z",
    });
}

function loaded(state: RunState): LoadRunStateResult {
    return { status: "loaded", path: "/srv/run-state.json", state };
}

function absent(): LoadRunStateResult {
    return { status: "absent", path: "/srv/run-state.json" };
}

function failure(reason = "EACCES: permission denied"): LoadRunStateResult {
    return { status: "failure", path: "/srv/run-state.json", reason };
}

function invalid(reason = "Run-state digest mismatch; the saved artifact is untrusted or corrupted."): LoadRunStateResult {
    return { status: "invalid", path: "/srv/run-state.json", reason };
}

function effect(overrides: Partial<{
    stepId: number;
    attemptId: string;
    toolCallId: string;
    integration: "git" | "spec-keeper";
    idempotencyKey: string;
    recordedAt: string;
}> = {}): ReturnType<typeof buildToolEffectRecord> {
    return buildToolEffectRecord({
        stepId: 2,
        attemptId: "attempt-1",
        toolCallId: "call-1",
        integration: "spec-keeper",
        idempotencyKey: "sk-task-1",
        recordedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    });
}

async function testAbsentAndFresh(): Promise<void> {
    const decision = reconcileRecovery(absent(), identity);
    assert.deepEqual(decision, { status: "fresh" });
    console.log("  ok: absent run-state classifies as fresh");
}

async function testUntrustedAndIncompatible(): Promise<void> {
    const untrustedInvalid = reconcileRecovery(
        invalid("Run-state digest mismatch; the saved artifact is untrusted or corrupted."),
        identity,
    );
    assert.ok(untrustedInvalid.status === "untrusted", "invalid artifact must be untrusted");
    assert.match(untrustedInvalid.reason, /digest mismatch/);

    const untrustedFailure = reconcileRecovery(failure("EACCES: permission denied"), identity);
    assert.ok(untrustedFailure.status === "untrusted", "read failure must be untrusted");
    assert.match(untrustedFailure.reason, /could not be read/);

    const incompatiblePath = reconcileRecovery(
        loaded(baseState({ workspaceIdentity: { workspacePath: "/other", branch: "main", worktreePath: null } })),
        identity,
    );
    assert.ok(incompatiblePath.status === "incompatible", "workspace mismatch must be incompatible");
    assert.match(incompatiblePath.reason, /does not match the current workspace/);

    const incompatibleBranch = reconcileRecovery(
        loaded(baseState({ workspaceIdentity: { workspacePath: "/srv/workspace", branch: "feature", worktreePath: null } })),
        identity,
    );
    assert.ok(incompatibleBranch.status === "incompatible", "branch mismatch must be incompatible");
    assert.match(incompatibleBranch.reason, /does not match the current branch/);

    // A saved null branch never conflicts with the current branch.
    const savedNullBranch = reconcileRecovery(
        loaded(baseState({ workspaceIdentity: { workspacePath: "/srv/workspace", branch: null, worktreePath: null } })),
        identity,
    );
    assert.ok(savedNullBranch.status !== "incompatible", "a saved null branch must not conflict with the current branch");
    console.log("  ok: untrusted and incompatible artifacts are rejected");
}

async function testReplaySafe(): Promise<void> {
    const idle = reconcileRecovery(loaded(baseState({ activeStepId: null, attemptId: null })), identity);
    assert.ok(idle.status === "replay-safe", "empty valid state must be replay-safe");
    if (idle.status === "replay-safe") {
        assert.equal(idle.planId, "PLAN-RECONCILE");
        assert.equal(idle.planVersion, 2);
        assert.equal(idle.activeStepId, null);
        assert.equal(idle.attemptId, null);
    }

    const started = reconcileRecovery(loaded(baseState({ activeStepId: 3, attemptId: "attempt-2" })), identity);
    assert.ok(started.status === "replay-safe", "attempt-started state must be replay-safe");
    if (started.status === "replay-safe") {
        assert.equal(started.activeStepId, 3);
        assert.equal(started.attemptId, "attempt-2");
    }
    console.log("  ok: replay-safe states carry plan identity and active pointers");
}

async function testTerminalOutcomes(): Promise<void> {
    const succeeded = reconcileRecovery(
        loaded(baseState({
            completedSteps: [
                { stepId: 2, outcome: "succeeded", completionCriteria: ["build exits 0"], recordedAt: "2026-01-01T00:00:00.000Z" },
            ],
        })),
        identity,
    );
    assert.ok(succeeded.status === "succeeded", "terminal success must be reported");
    if (succeeded.status === "succeeded") {
        assert.equal(succeeded.planId, "PLAN-RECONCILE");
        assert.equal(succeeded.planVersion, 2);
        assert.equal(succeeded.stepId, 2);
        assert.equal(succeeded.recordedAt, "2026-01-01T00:00:00.000Z");
    }

    for (const outcome of ["failed", "blocked", "invalid"] as const) {
        const decision = reconcileRecovery(
            loaded(baseState({
                completedSteps: [{ stepId: 2, outcome, completionCriteria: ["criterion"] }],
            })),
            identity,
        );
        assert.ok(decision.status === "failed", `terminal ${outcome} must be reported as failed`);
        if (decision.status === "failed") {
            assert.equal(decision.stepId, 2);
            assert.equal(decision.outcome, outcome);
        }
    }
    console.log("  ok: terminal succeeded/failed/blocked/invalid outcomes are classified");
}

async function testUncertainPendingEffects(): Promise<void> {
    const recorded = effect();
    const decision = reconcileRecovery(
        loaded(baseState({
            activeStepId: 2,
            attemptId: "attempt-1",
            evidenceReferences: [toolEffectReference(recorded)],
        })),
        identity,
    );
    assert.ok(decision.status === "uncertain", "a recorded tool effect must be uncertain");
    if (decision.status === "uncertain") {
        assert.equal(decision.planId, "PLAN-RECONCILE");
        assert.equal(decision.planVersion, 2);
        assert.equal(decision.stepId, 2);
        assert.equal(decision.attemptId, "attempt-1");
        assert.equal(decision.pendingEffects.length, 1);
        assert.equal(decision.pendingEffects[0].toolCallId, "call-1");
        assert.match(decision.reason, /must be reconciled/);
    }

    // A state with recorded effects/completions but no active step pointer is
    // also uncertain: it must be inspected before resuming.
    const orphaned = reconcileRecovery(
        loaded(baseState({
            activeStepId: null,
            attemptId: null,
            evidenceReferences: [toolEffectReference(recorded)],
        })),
        identity,
    );
    assert.ok(orphaned.status === "uncertain", "orphaned effects must be uncertain");
    if (orphaned.status === "uncertain") {
        assert.equal(orphaned.stepId, 0);
        assert.equal(orphaned.pendingEffects.length, 1);
    }
    console.log("  ok: uncertain pending effects are reported for inspection");
}

async function testResolvePendingEffects(): Promise<void> {
    const specKeeperDecision = reconcileRecovery(
        loaded(baseState({ evidenceReferences: [toolEffectReference(effect())] })),
        identity,
    );
    assert.ok(specKeeperDecision.status === "uncertain");
    if (specKeeperDecision.status !== "uncertain") return;

    const confirmed = resolvePendingEffects(specKeeperDecision, { hasSpecKeeperTask: () => true });
    assert.equal(confirmed.requiresInspection, false);
    assert.equal(confirmed.confirmed.length, 1);
    assert.equal(confirmed.confirmed[0].idempotencyKey, "sk-task-1");
    assert.equal(confirmed.absent.length, 0);
    assert.equal(confirmed.ambiguous.length, 0);

    const absentEffect = resolvePendingEffects(specKeeperDecision, { hasSpecKeeperTask: () => false });
    assert.equal(absentEffect.requiresInspection, false);
    assert.equal(absentEffect.confirmed.length, 0);
    assert.equal(absentEffect.absent.length, 1);
    assert.equal(absentEffect.ambiguous.length, 0);

    const unknown = resolvePendingEffects(specKeeperDecision, { hasSpecKeeperTask: () => null });
    assert.equal(unknown.requiresInspection, true);
    assert.equal(unknown.ambiguous.length, 1);

    const throwing = resolvePendingEffects(specKeeperDecision, {
        hasSpecKeeperTask: () => {
            throw new Error("inspection failed");
        },
    });
    assert.equal(throwing.requiresInspection, true);
    assert.equal(throwing.ambiguous.length, 1);

    // No checker for the integration, or no key at all, must stay ambiguous.
    const noChecker = resolvePendingEffects(specKeeperDecision, {});
    assert.equal(noChecker.requiresInspection, true);

    const noKeyDecision = reconcileRecovery(
        loaded(baseState({
            evidenceReferences: [toolEffectReference(buildToolEffectRecord({
                stepId: 2,
                attemptId: "attempt-1",
                toolCallId: "call-2",
            }))],
        })),
        identity,
    );
    assert.ok(noKeyDecision.status === "uncertain");
    if (noKeyDecision.status === "uncertain") {
        const noKey = resolvePendingEffects(noKeyDecision, { hasSpecKeeperTask: () => true });
        assert.equal(noKey.requiresInspection, true);
        assert.equal(noKey.ambiguous.length, 1);
    }

    // Git integration routes through the trailer inspector.
    const gitDecision = reconcileRecovery(
        loaded(baseState({
            evidenceReferences: [toolEffectReference(effect({ integration: "git", idempotencyKey: "trailer-key" }))],
        })),
        identity,
    );
    assert.ok(gitDecision.status === "uncertain");
    if (gitDecision.status === "uncertain") {
        const gitConfirmed = resolvePendingEffects(gitDecision, { hasGitCommitWithTrailer: () => true });
        assert.equal(gitConfirmed.requiresInspection, false);
        assert.equal(gitConfirmed.confirmed.length, 1);
        assert.equal(gitConfirmed.confirmed[0].idempotencyKey, "trailer-key");

        const gitMismatchedInspector = resolvePendingEffects(gitDecision, { hasSpecKeeperTask: () => true });
        assert.equal(gitMismatchedInspector.requiresInspection, true);
    }

    // A non-uncertain decision resolves to an empty, no-inspection result.
    const freshResolution = resolvePendingEffects(reconcileRecovery(absent(), identity), { hasSpecKeeperTask: () => true });
    assert.deepEqual(freshResolution, { requiresInspection: false, confirmed: [], absent: [], ambiguous: [] });
    console.log("  ok: pending effects resolve to confirmed/absent/ambiguous by inspector");
}

async function testDeriveAttemptPhase(): Promise<void> {
    assert.equal(deriveAttemptPhase(baseState({ activeStepId: null, attemptId: null })), "idle");
    assert.equal(deriveAttemptPhase(baseState({ activeStepId: 2, attemptId: "attempt-1" })), "attempt-started");
    assert.equal(
        deriveAttemptPhase(baseState({
            activeStepId: 2,
            attemptId: "attempt-1",
            evidenceReferences: [toolEffectReference(effect())],
        })),
        "tool-effect-recorded",
    );
    assert.equal(
        deriveAttemptPhase(baseState({
            activeStepId: 2,
            attemptId: "attempt-1",
            completedSteps: [{ stepId: 2, outcome: "succeeded", completionCriteria: ["x"] }],
        })),
        "terminal-recorded",
    );
    console.log("  ok: attempt lifecycle phase is derived from run-state");
}

async function testEffectHelpers(): Promise<void> {
    const record = effect();
    assert.equal(record.kind, TOOL_EFFECT_EVIDENCE_KIND);
    assert.equal(record.stepId, 2);
    assert.equal(record.attemptId, "attempt-1");
    assert.equal(record.toolCallId, "call-1");

    const ref = toolEffectReference(record);
    assert.equal(isToolEffectEvidence(ref.evidence), true);
    assert.equal(isToolEffectEvidence({ summary: "ordinary evidence" }), false);

    const state = baseState({
        evidenceReferences: [
            toolEffectReference(effect()),
            toolEffectReference(buildToolEffectRecord({ stepId: 5, attemptId: "attempt-9", toolCallId: "call-5" })),
        ],
    });
    assert.equal(toolEffectsFromState(state).length, 2);
    assert.equal(toolEffectsForAttempt(state, 5, "attempt-9").length, 1);
    assert.equal(toolEffectsForAttempt(state, 2, "attempt-1").length, 1);
    assert.equal(toolEffectsForAttempt(state, 5, "attempt-1").length, 0);
    assert.deepEqual(terminalRecordForStep(state, 2), null);
    console.log("  ok: tool-effect evidence helpers extract effects by step/attempt");
}

async function testBuildToolEffectRecordValidation(): Promise<void> {
    assert.throws(
        () => buildToolEffectRecord({ stepId: 0, attemptId: "a", toolCallId: "c" }),
        /'stepId' must be a positive integer/,
    );
    assert.throws(
        () => buildToolEffectRecord({ stepId: 1, attemptId: " ", toolCallId: "c" }),
        /'attemptId' must be a non-empty string/,
    );
    assert.throws(
        () => buildToolEffectRecord({ stepId: 1, attemptId: "a", toolCallId: "" }),
        /'toolCallId' must be a non-empty string/,
    );
    assert.throws(
        () => buildToolEffectRecord({ stepId: 1, attemptId: "a", toolCallId: "c", integration: "other" as never }),
        /'integration' must be 'git' or 'spec-keeper'/,
    );
    assert.throws(
        () => buildToolEffectRecord({ stepId: 1, attemptId: "a", toolCallId: "c", recordedAt: "yesterday" }),
        /'recordedAt' must be an ISO-8601 timestamp/,
    );
    assert.throws(
        () => buildToolEffectRecord({ stepId: 1, attemptId: "a", toolCallId: "c", idempotencyKey: " " }),
        /'idempotencyKey' must be a non-empty string/,
    );
    console.log("  ok: tool-effect records validate step/attempt/tool/effect fields");
}

async function testIdempotencyKeys(): Promise<void> {
    assert.equal(sanitizeIdempotencyToken("Plan: Fix / Bug! (v2)"), "plan-fix-bug-v2");
    assert.equal(sanitizeIdempotencyToken("   "), "run");
    assert.equal(runIdempotencyKey("PLAN-X", 3, "attempt-4"), "elagent-plan-x-step-3-attempt-4");
    assert.equal(specKeeperStepTaskKey("PLAN-X", 3), "elagent-plan-x-step-3");
    assert.equal(
        gitCommitTrailer("PLAN-X", 3, "attempt-4"),
        `${GIT_COMMIT_TRAILER_NAME}: elagent-plan-x-step-3-attempt-4`,
    );
    assert.throws(() => runIdempotencyKey("P", 0, "a"), /'stepId' must be a positive integer/);
    assert.throws(() => specKeeperStepTaskKey("P", 0), /'stepId' must be a positive integer/);
    console.log("  ok: idempotency keys and commit trailers are deterministic");
}

async function main(): Promise<void> {
    await testAbsentAndFresh();
    await testUntrustedAndIncompatible();
    await testReplaySafe();
    await testTerminalOutcomes();
    await testUncertainPendingEffects();
    await testResolvePendingEffects();
    await testDeriveAttemptPhase();
    await testEffectHelpers();
    await testBuildToolEffectRecordValidation();
    await testIdempotencyKeys();
    console.log("Run-state reconciliation tests passed");
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
