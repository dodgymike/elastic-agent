import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmAdapterError, type GenerateRequest, type GenerateResponse, type LlmAdapter } from "../llm/adapter-contract.js";
import { MultiTurnLlmRuntime } from "../llm/multi-turn-runtime.js";
import { RunAbortError, runAbortErrorFromSignal, throwIfAborted } from "../llm/run-abort.js";
import { parsePlanOrAbort } from "../plan-printer.js";
import { abortBlockText, boundedAbortReason } from "../llm/abort-report.js";
import {
    nextConsecutiveNoProgressReplans,
    parseReplanResponse,
    recordReplanElapsedAndAssertBudget,
    replanRemainingKey,
    throwIfConsecutiveNoProgressReplansReached,
    throwIfReplanAttemptLimitReached,
    throwIfReplanTimeBudgetExceeded,
} from "../llm/replan-abort.js";
import { cleanupWorktree, createWorktree } from "../worktree.js";

/** Fixture adapter that queues text responses and records every generate request. */
function queueAdapter(responses: string[]): { adapter: LlmAdapter; requests: GenerateRequest[] } {
    const requests: GenerateRequest[] = [];
    const adapter: LlmAdapter = {
        provider: "fixture",
        capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
        async generate(request) {
            requests.push(request);
            const text = responses.shift() ?? "";
            const response: GenerateResponse = {
                model: request.model,
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
                message: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
            };
            return response;
        },
    };
    return { adapter, requests };
}

async function testRunAbortErrorExitCodes(): Promise<void> {
    assert.equal(new RunAbortError("user", "planning", "SIGINT").exitCode, 130);
    assert.equal(new RunAbortError("user", "planning", "SIGTERM").exitCode, 143);
    assert.equal(new RunAbortError("unable-to-complete", "planning", "no plan").exitCode, 2);
    assert.equal(new RunAbortError("stuck", "replan", "stuck", { step: 2 }).exitCode, 3);
    assert.equal(new RunAbortError("user", "planning", "SIGINT").name, "RunAbortError");
    console.log("  ok: RunAbortError exit codes follow ABORT_SEMANTICS.md");
}

async function testUserAbortSignalHelpers(): Promise<void> {
    const controller = new AbortController();
    throwIfAborted(controller.signal, "planning"); // not aborted yet: no throw

    controller.abort("SIGINT");
    const error = runAbortErrorFromSignal(controller.signal, "execution", 3);
    assert.ok(error instanceof RunAbortError);
    assert.equal(error.kind, "user");
    assert.equal(error.phase, "execution");
    assert.equal(error.step, 3);
    assert.equal(error.exitCode, 130);
    assert.equal(error.message, "SIGINT");

    assert.throws(
        () => throwIfAborted(controller.signal, "planning"),
        (thrown: unknown) => thrown instanceof RunAbortError && thrown.kind === "user" && thrown.exitCode === 130,
    );

    const termController = new AbortController();
    termController.abort("SIGTERM");
    assert.equal(runAbortErrorFromSignal(termController.signal, "planning").exitCode, 143);
    console.log("  ok: user abort signal helpers produce user RunAbortError");
}

async function testRuntimeSignalPropagationAndPrecedence(): Promise<void> {
    // An already-aborted runtime signal must prevent the adapter from being called.
    const controller = new AbortController();
    controller.abort("SIGINT");
    const { adapter, requests } = queueAdapter(["should not be used"]);
    const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model", controller.signal);
    await assert.rejects(
        () => runtime.create({ input: "do work", abortPhase: "planning" }),
        (thrown: unknown) => thrown instanceof RunAbortError && thrown.kind === "user" && thrown.exitCode === 130,
    );
    assert.equal(requests.length, 0, "adapter must not be called when the signal is already aborted");

    // A request-level signal overrides the runtime signal for that request.
    const requestController = new AbortController();
    const runtime2 = new MultiTurnLlmRuntime(adapter, "fixture-model");
    requestController.abort("SIGTERM");
    await assert.rejects(
        () => runtime2.create({ input: "do work", signal: requestController.signal, abortPhase: "execution" }),
        (thrown: unknown) => thrown instanceof RunAbortError && thrown.kind === "user" && thrown.exitCode === 143,
    );
    assert.equal(requests.length, 0);

    // A successful request forwards the runtime signal into GenerateRequest.signal.
    const successController = new AbortController();
    const seenSignals: (AbortSignal | undefined)[] = [];
    const forwardingAdapter: LlmAdapter = {
        provider: "fixture",
        capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
        async generate(request) {
            seenSignals.push(request.signal);
            return { model: request.model, finishReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
        },
    };
    const runtime3 = new MultiTurnLlmRuntime(forwardingAdapter, "fixture-model", successController.signal);
    await runtime3.create({ input: "hi" });
    assert.equal(seenSignals[0], successController.signal, "runtime signal must be forwarded to the adapter");

    // When the provider throws after the user aborts, the user abort wins over
    // the adapter error so the top-level handler reports the correct phase and code.
    const precedenceController = new AbortController();
    const precedenceAdapter: LlmAdapter = {
        provider: "fixture",
        capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
        async generate() {
            precedenceController.abort("SIGINT");
            throw new LlmAdapterError("fixture", "unavailable", "provider failed after user abort", true);
        },
    };
    const runtime4 = new MultiTurnLlmRuntime(precedenceAdapter, "fixture-model", precedenceController.signal);
    await assert.rejects(
        () => runtime4.create({ input: "do work", abortPhase: "execution" }),
        (thrown: unknown) => thrown instanceof RunAbortError && thrown.kind === "user" && thrown.exitCode === 130,
    );
    console.log("  ok: runtime forwards abort signals and user abort takes precedence");
}

async function testPlanningAbortJson(): Promise<void> {
    const abort = parsePlanOrAbort('{"abort":true,"reason":"Cannot safely modify the release pipeline"}');
    assert.equal(abort.valid, true);
    assert.ok(abort.valid && abort.result.kind === "abort");
    if (abort.valid && abort.result.kind === "abort") {
        assert.equal(abort.result.reason, "Cannot safely modify the release pipeline");
    }

    // abort wins when plan steps are also present.
    const both = parsePlanOrAbort('{"abort":true,"reason":"blocked","steps":[{"step_number":1,"tldr":"do it"}]}');
    assert.ok(both.valid && both.result.kind === "abort");

    // abort: false (or absent) falls through to normal plan parsing.
    const plan = parsePlanOrAbort('{"steps":[{"step_number":1,"tldr":"do it"}]}');
    assert.ok(plan.valid && plan.result.kind === "plan");

    // Validation failures stay non-throwing and actionable.
    assert.equal(parsePlanOrAbort('{"abort":"yes"}').valid, false);
    assert.match((parsePlanOrAbort('{"abort":"yes"}') as { reason: string }).reason, /must be a boolean/);
    assert.equal(parsePlanOrAbort('{"abort":true}').valid, false);
    assert.match((parsePlanOrAbort('{"abort":true}') as { reason: string }).reason, /non-empty 'reason'/);

    // Fenced JSON is accepted, matching the planning suffix contract.
    const fenced = parsePlanOrAbort('```json\n{"abort":true,"reason":"blocked"}\n```');
    assert.ok(fenced.valid && fenced.result.kind === "abort");
    console.log("  ok: planning JSON abort result is parsed and validated");
}

async function testReplanAbortJson(): Promise<void> {
    assert.deepEqual(parseReplanResponse('{"abort":true,"reason":"cannot replan"}'), { valid: true, abort: true, reason: "cannot replan" });
    assert.deepEqual(parseReplanResponse('{"abort":true,"reason":"blocked","steps":["new step"]}'), { valid: true, abort: true, reason: "blocked" });
    assert.deepEqual(parseReplanResponse('{"steps":["new step"]}'), { valid: true, abort: false, steps: ["new step"] });

    assert.equal(parseReplanResponse('{"abort":"yes"}').valid, false);
    assert.match((parseReplanResponse('{"abort":"yes"}') as { reason: string }).reason, /must be a boolean/);
    assert.equal(parseReplanResponse('{"abort":true}').valid, false);
    assert.equal(parseReplanResponse('{"steps":[]}').valid, false);
    assert.equal(parseReplanResponse('{"steps":["none"]}').valid, false);
    assert.match((parseReplanResponse('{"steps":["none"]}') as { reason: string }).reason, /non-actionable step/);
    assert.equal(parseReplanResponse("", 50).valid, false);

    const tooManySteps = JSON.stringify({ steps: ["1", "2", "3"] });
    assert.equal(parseReplanResponse(tooManySteps, 2).valid, false);
    assert.match((parseReplanResponse(tooManySteps, 2) as { reason: string }).reason, /more than 2 steps/);

    const fenced = parseReplanResponse('```json\n{"abort":true,"reason":"blocked"}\n```');
    assert.deepEqual(fenced, { valid: true, abort: true, reason: "blocked" });
    console.log("  ok: replan JSON abort result is parsed and validated");
}

async function testReplanStuckDetection(): Promise<void> {
    assert.doesNotThrow(() => throwIfReplanAttemptLimitReached({ replanAttemptCount: 2 }, 2, 3));
    assert.throws(
        () => throwIfReplanAttemptLimitReached({ replanAttemptCount: 3 }, 2, 3),
        (thrown: unknown) => thrown instanceof RunAbortError
            && thrown.kind === "stuck"
            && thrown.exitCode === 3
            && /replan attempt limit reached \(3\/3\) while step 2/.test(thrown.message)
            && thrown.step === 2,
    );

    assert.doesNotThrow(() => throwIfReplanTimeBudgetExceeded({ replanElapsedMs: 119999 }, 1, 120000));
    assert.throws(
        () => throwIfReplanTimeBudgetExceeded({ replanElapsedMs: 120000 }, 1, 120000),
        (thrown: unknown) => thrown instanceof RunAbortError && /replan time budget exceeded \(120000 ms\)/.test(thrown.message),
    );

    const config: { replanElapsedMs?: number } = { replanElapsedMs: 1000 };
    assert.doesNotThrow(() => recordReplanElapsedAndAssertBudget(config, 1, Date.now() - 500, 120000));
    assert.ok((config.replanElapsedMs ?? 0) >= 1500, "elapsed time must accumulate");
    assert.throws(
        () => recordReplanElapsedAndAssertBudget({ replanElapsedMs: 0 }, 1, Date.now() - 120001, 120000),
        (thrown: unknown) => thrown instanceof RunAbortError && /replan time budget exceeded/.test(thrown.message),
    );

    assert.equal(replanRemainingKey(["step 1", "  step 2  ", "", "step 3"], 0), "step 2\nstep 3");
    assert.equal(replanRemainingKey(["a", "b", "c"], 2), "");

    assert.equal(nextConsecutiveNoProgressReplans(true, 3), 0);
    assert.equal(nextConsecutiveNoProgressReplans(false, 1), 2);
    assert.doesNotThrow(() => throwIfConsecutiveNoProgressReplansReached(1, 2, 1));
    assert.throws(
        () => throwIfConsecutiveNoProgressReplansReached(2, 2, 1),
        (thrown: unknown) => thrown instanceof RunAbortError && /no progress after 2 consecutive identical replans/.test(thrown.message),
    );
    console.log("  ok: replan retry-exhaustion and stuck detection thresholds abort");
}

async function testAbortReportShape(): Promise<void> {
    const error = new RunAbortError("stuck", "replan", "no progress after 2 consecutive identical replans", { step: 2 });
    assert.equal(abortBlockText(error), [
        "Plan is stuck",
        "  phase: replan",
        "  step: 2",
        "  reason: no progress after 2 consecutive identical replans",
        "  exit code: 3",
    ].join("\n"));

    const userBlock = abortBlockText(new RunAbortError("user", "planning", "SIGINT"));
    assert.equal(userBlock, [
        "Aborted by user",
        "  phase: planning",
        "  step: -",
        "  reason: SIGINT",
        "  exit code: 130",
    ].join("\n"));

    assert.equal(boundedAbortReason("  line1\nline2   ", 50), "line1 line2");
    assert.equal(boundedAbortReason("x".repeat(500)).length, 400);
    assert.ok(boundedAbortReason("x".repeat(500)).endsWith("…"));
    console.log("  ok: abort console block and bounded reason match the output contract");
}

function runGit(cwd: string, args: readonly string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
    assert.strictEqual(result.status, 0, `git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
    return (result.stdout ?? "").trim();
}

async function testAbortWorktreeCleanup(): Promise<void> {
    const repoRoot = mkdtempSync(join(tmpdir(), "abort-worktree-"));
    try {
        runGit(repoRoot, ["init", "-b", "main"]);
        runGit(repoRoot, ["config", "user.email", "test@example.com"]);
        runGit(repoRoot, ["config", "user.name", "Test Agent"]);
        writeFileSync(join(repoRoot, "keep.txt"), "main checkout user work\n");
        runGit(repoRoot, ["add", "keep.txt"]);
        runGit(repoRoot, ["commit", "-m", "initial"]);
        const mainHead = runGit(repoRoot, ["rev-parse", "HEAD"]);

        const branch = "review-worktree";
        const worktreePath = createWorktree(branch, repoRoot);
        writeFileSync(join(worktreePath, "staged.txt"), "staged execution work\n");
        runGit(worktreePath, ["add", "staged.txt"]);
        assert.ok(existsSync(join(worktreePath, "staged.txt")), "staged execution work must exist before cleanup");
        assert.ok(existsSync(join(repoRoot, "keep.txt")), "main checkout work must exist before cleanup");

        // This is the same cleanupWorktree call the abort path uses to discard
        // the dedicated execution worktree and its branch.
        cleanupWorktree(branch, repoRoot);

        assert.ok(!existsSync(worktreePath), "abort cleanup must remove the execution worktree");
        assert.equal(runGit(repoRoot, ["branch", "--list", branch]), "", "abort cleanup must delete the worktree branch");
        assert.equal(runGit(repoRoot, ["rev-parse", "HEAD"]), mainHead, "abort cleanup must not roll back main HEAD");
        assert.ok(existsSync(join(repoRoot, "keep.txt")), "abort cleanup must never destroy main checkout user work");

        const status = runGit(repoRoot, ["status", "--porcelain"]);
        assert.ok(!status.includes("staged.txt"), "staged execution work must be discarded with the worktree");
        console.log("  ok: abort cleanup removes the execution worktree and preserves main checkout");
    } finally {
        rmSync(repoRoot, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "elastic-agent-abort-paths-"));
    const originalLogPath = process.env.LLM_LOG_PATH;
    process.env.LLM_LOG_PATH = join(directory, "llm.log");
    try {
        await testRunAbortErrorExitCodes();
        await testUserAbortSignalHelpers();
        await testRuntimeSignalPropagationAndPrecedence();
        await testPlanningAbortJson();
        await testReplanAbortJson();
        await testReplanStuckDetection();
        await testAbortReportShape();
        await testAbortWorktreeCleanup();
        console.log("Abort path tests passed");
    } finally {
        if (originalLogPath === undefined) delete process.env.LLM_LOG_PATH;
        else process.env.LLM_LOG_PATH = originalLogPath;
        rmSync(directory, { recursive: true, force: true });
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
