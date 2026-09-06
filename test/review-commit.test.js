// Control-flow test for the review-commit decision logic in main.ts.
// Mirrors the CURRENT stop-on-failure review/worktree behavior:
//   - the execution phase stages changes in the execution worktree and NEVER
//     commits;
//   - the review step commits/merges ONLY when it is happy (review.passed ===
//     true);
//   - a failing review does NOT commit, marks the Spec Keeper run task/epic
//     blocked, cleans up the worktree, and returns { success: false } without
//     re-executing;
//   - a passing review followed by a failed commit/merge must surface the
//     commit error (review success is distinct from commit success);
//   - missing diff evidence is surfaced in the review request as an explicit
//     notice rather than failing the review phase.
// This is a pure control-flow simulation (as test/review-loop.test.js), so it
// exercises the decision algorithm without a real git repository. The actual
// git/worktree behavior is covered by test/worktree.test.ts.

const maxReviewParseRetries = 2;

function summarizeReview(review) {
    const learnings = Array.isArray(review?.learnings) ? review.learnings.filter(Boolean) : [];
    if (learnings.length > 0) return learnings.join("; ");
    return "completed work passed all four review criteria";
}

// Mirrors runReview() in main.ts: retry invalid review JSON up to
// maxReviewParseRetries before throwing RunAbortError.
function runReviewSimulation(responses) {
    let lastReason = null;
    let calls = 0;
    for (let retry = 0; retry <= maxReviewParseRetries; retry += 1) {
        const raw = responses.shift();
        calls += 1;
        if (raw === undefined) break;
        const parsed = raw.valid ? raw : { valid: false, reason: raw.reason ?? "malformed response" };
        if (parsed.valid) return parsed.review;
        lastReason = parsed.reason;
    }
    const reason = `Review response was not valid JSON after ${maxReviewParseRetries} retries: ${lastReason ?? "no response received"}`;
    const error = new Error(reason);
    error.name = "RunAbortError";
    error.reviewCalls = calls;
    throw error;
}

// Mirrors the changes/diff assembly in runReviewPhase() in main.ts:
// best-effort reading of the staged diff, falling back to committed work when
// the staged diff is empty, and to an explicit UNKNOWN EVIDENCE section when
// no evidence is available. The review phase must NOT fail because the diff is
// missing; the reviewer must resolve unknown evidence or report
// inconclusive/failing.
function unknownChangesEvidence() {
    return [
        "UNKNOWN EVIDENCE",
        "",
        "No staged or committed change summary could be produced for this review. The reviewer MUST resolve this explicitly: inspect the repository state directly when tools permit, or report the review inconclusive/failing with a reason explaining why the change evidence could not be obtained. Do NOT infer success from missing evidence.",
    ].join("\n");
}

function buildChangesForReview(executionWorktreePath, readStagedChanges, readCommittedChanges) {
    let changes = unknownChangesEvidence();
    if (!executionWorktreePath) return changes;
    try {
        changes = readStagedChanges(executionWorktreePath);
    } catch (error) {
        return changes; // explicit unknown-evidence section is retained; review still proceeds
    }
    if (changes.includes("(no staged changes against HEAD)")) {
        try {
            changes = `${changes}\n\n${readCommittedChanges(executionWorktreePath)}`;
        } catch (error) {
            // Neither staged nor committed evidence is available: replace the
            // empty staged block with the explicit unknown-evidence section.
            changes = unknownChangesEvidence();
        }
    }
    return changes;
}

// Mirrors the options.review branch of runPromptOnce() in main.ts with commit
// tracking. A thrown commit error carries gitOps/events so tests can assert on
// the failed-commit path.
function simulateReviewCommitFlow(reviewResponses, options = {}) {
    const gitOps = {
        worktreeUsedForStaging: false,
        commits: [],
        merges: [],
        stagingCount: 0,
    };
    const events = [];
    const specKeeper = { runTaskStatus: null, epicStatus: null };
    let reviewAttempt = 0;
    let executionPhases = 0;
    let failureWorktreeCleanedUp = false;

    const stageAll = () => { gitOps.stagingCount += 1; gitOps.worktreeUsedForStaging = true; };
    const commitInWorktree = (summary) => {
        if (options.failCommit) throw new Error(`git commit failed: ${options.failCommit}`);
        gitOps.commits.push(`review happy: ${summary}`);
    };
    const mergeIntoMain = () => {
        if (options.failMerge) throw new Error(`git merge failed: ${options.failMerge}`);
        gitOps.merges.push("worktree -> main");
    };

    // ONE execution phase per run: execute steps and stage in the worktree
    // without committing.
    executionPhases += 1;
    events.push("execution-phase");
    stageAll();

    reviewAttempt += 1;
    const review = runReviewSimulation(reviewResponses);

    if (review.passed) {
        events.push("review-passed");
        // Review is happy: stage once more, commit in the worktree, merge.
        stageAll();
        let commitError = null;
        try {
            commitInWorktree(summarizeReview(review));
            mergeIntoMain();
        } catch (error) {
            commitError = error;
        }
        if (commitError) {
            // Review success is NOT commit success: surface the commit error,
            // clean up the worktree, and stop the run.
            failureWorktreeCleanedUp = true;
            const error = new Error(`Review passed but the review commit failed: ${commitError.message}`);
            error.gitOps = gitOps;
            error.events = events;
            error.executionPhases = executionPhases;
            error.reviewAttempt = reviewAttempt;
            error.failureWorktreeCleanedUp = failureWorktreeCleanedUp;
            throw error;
        }
        specKeeper.runTaskStatus = "done";
        specKeeper.epicStatus = "done";
        return {
            success: true,
            attempts: reviewAttempt,
            executionPhases,
            gitOps,
            specKeeper,
            failureWorktreeCleanedUp,
            events,
            reviewOutcome: "passed",
        };
    }

    // Failing review: NO commit, mark Spec Keeper blocked, clean up the
    // worktree, return { success: false } without re-executing.
    events.push("review-failed");
    specKeeper.runTaskStatus = "blocked";
    specKeeper.epicStatus = "blocked";
    failureWorktreeCleanedUp = true;
    return {
        success: false,
        attempts: reviewAttempt,
        executionPhases,
        gitOps,
        specKeeper,
        failureWorktreeCleanedUp,
        events,
        reviewOutcome: "failed",
        error: "Review did not pass; the work was left uncommitted and the task was marked blocked.",
    };
}

let failures = 0;
function check(name, cond) { if (cond) console.log(`PASS: ${name}`); else { console.error(`FAIL: ${name}`); failures += 1; } }

// 1. Happy review: commit exactly once, stage before commit, merge once.
{
    const r = simulateReviewCommitFlow([
        { valid: true, review: { passed: true, reasons: [], learnings: ["all criteria met"] } },
    ]);
    check("happy review commits exactly once", r.gitOps.commits.length === 1);
    check("commit message marks review happy", r.gitOps.commits[0] === "review happy: all criteria met");
    check("staging happens in the worktree", r.gitOps.worktreeUsedForStaging === true);
    check("staging occurs before the commit", r.gitOps.stagingCount === 2); // once per execution phase + once at review
    check("happy review merges exactly once", r.gitOps.merges.length === 1);
    check("happy review uses attempt 1", r.attempts === 1);
    check("happy review runs one execution phase", r.executionPhases === 1);
    check("happy review returns success true", r.success === true);
}

// 2. A failing review does NOT commit, does NOT merge, does NOT restart, and
//    leaves the run as failed.
{
    const r = simulateReviewCommitFlow([
        { valid: true, review: { passed: false, reasons: ["missing docs"], learnings: ["write docs"] } },
    ]);
    check("failing review never commits", r.gitOps.commits.length === 0);
    check("failing review never merges", r.gitOps.merges.length === 0);
    check("failing review runs exactly one execution phase (no restart)", r.executionPhases === 1);
    check("failing review marks run task blocked", r.specKeeper.runTaskStatus === "blocked");
    check("failing review marks epic blocked", r.specKeeper.epicStatus === "blocked");
    check("failing review cleans up the worktree", r.failureWorktreeCleanedUp === true);
    check("failing review returns success false", r.success === false);
    check("failing review emits the stop error", r.error === "Review did not pass; the work was left uncommitted and the task was marked blocked.");
}

// 3. Missing diff evidence: the review request carries the explicit UNKNOWN
//    EVIDENCE section instead of failing the review phase.
{
    const missingWorktree = buildChangesForReview(null, () => "diff --git a/x b/x", () => "committed patch");
    check("missing worktree path produces the explicit UNKNOWN EVIDENCE section", missingWorktree === unknownChangesEvidence());

    const unreadableDiff = buildChangesForReview(
        "/worktrees/review-worktree",
        () => { throw new Error("git diff failed"); },
        () => "committed patch",
    );
    check("unreadable staged diff keeps the explicit UNKNOWN EVIDENCE section", unreadableDiff === unknownChangesEvidence());

    const emptyStagedFallsBackToCommitted = buildChangesForReview(
        "/worktrees/review-worktree",
        () => "(no staged changes against HEAD)",
        () => "committed patch: 1 file changed",
    );
    check("empty staged diff surfaces committed work as evidence", emptyStagedFallsBackToCommitted.includes("(no staged changes against HEAD)") && emptyStagedFallsBackToCommitted.includes("committed patch"));

    const emptyStagedWithUnreadableCommitted = buildChangesForReview(
        "/worktrees/review-worktree",
        () => "(no staged changes against HEAD)",
        () => { throw new Error("git show failed"); },
    );
    check("empty staged diff with unreadable committed work becomes UNKNOWN EVIDENCE", emptyStagedWithUnreadableCommitted === unknownChangesEvidence());
}

// 4. Review success is distinct from commit success: a passing review followed
//    by a failed commit must surface the commit error, not return success.
{
    let threw = null;
    try {
        simulateReviewCommitFlow(
            [{ valid: true, review: { passed: true, reasons: [], learnings: [] } }],
            { failCommit: "disk full" },
        );
    } catch (error) { threw = error; }
    check("passing review with failed commit surfaces the commit error", threw !== null && threw.message.includes("Review passed but the review commit failed"));
    check("commit error keeps the commit message detail", threw !== null && threw.message.includes("git commit failed: disk full"));
    check("failed commit records no successful commit", threw !== null && threw.gitOps.commits.length === 0);
    check("failed commit does not merge", threw !== null && threw.gitOps.merges.length === 0);
    check("failed commit cleans up the worktree", threw !== null && threw.failureWorktreeCleanedUp === true);
}

if (failures === 0) { console.log("\nAll review-commit tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
