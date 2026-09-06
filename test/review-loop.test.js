// Control-flow test for the options.review branch of runPromptOnce() in main.ts.
// Mirrors the CURRENT stop-on-failure review behavior (there is no automatic
// execution restart):
//   - exactly ONE execution phase runs per runPromptOnce call;
//   - reviewAttempt starts at 1;
//   - a passing review commits/merges and returns { success: true };
//   - a failing review marks the Spec Keeper run task AND epic blocked, emits
//     the error, cleans up the execution worktree, and returns
//     { success: false } WITHOUT re-executing;
//   - malformed review JSON is retried by runReview() up to
//     maxReviewParseRetries and then aborts the whole run with RunAbortError;
//   - options.review === false skips the review loop entirely.
// This is a pure control-flow simulation (as the original test was), so it
// exercises the decision algorithm without a real git repository or LLM.

const maxReviewParseRetries = 2;

// Mirrors runReview() in main.ts: issue the review request and retry invalid
// JSON responses up to maxReviewParseRetries before throwing RunAbortError.
// `responses` is a queue of raw review attempts; each entry is either
//   { valid: true, review: { passed, reasons, learnings } }
// or
//   { valid: false, reason: "..." }
// to model a parse/validation failure.
function runReviewSimulation(responses) {
    let lastReason = null;
    let calls = 0;
    for (let retry = 0; retry <= maxReviewParseRetries; retry += 1) {
        const raw = responses.shift();
        calls += 1;
        if (raw === undefined) break;
        const parsed = raw.valid ? raw : { valid: false, reason: raw.reason ?? "malformed response" };
        if (parsed.valid) {
            parsed.review.calls = calls;
            return parsed.review;
        }
        lastReason = parsed.reason;
    }
    const reason = `Review response was not valid JSON after ${maxReviewParseRetries} retries: ${lastReason ?? "no response received"}`;
    const error = new Error(reason);
    error.name = "RunAbortError";
    error.reviewCalls = calls;
    throw error;
}

// Mirrors the options.review branch of runPromptOnce() in main.ts. A
// RunAbortError from the review parser propagates (exactly like the real
// runPromptOnce, which does not catch it); the thrown error carries
// executionPhases / reviewAttempt / events / reviewCalls so tests can assert
// on the abort path too.
function simulateRunPromptOnce(reviewResponses, options = { review: true }) {
    const events = [];
    const specKeeper = { runTaskStatus: null, epicStatus: null };
    let executionPhases = 0;
    let reviewAttempt = 0;

    if (!options.review) {
        // Review disabled: run the execution phase without a review worktree,
        // then record completion directly (no review prompt is issued).
        executionPhases += 1;
        events.push("execution-phase");
        specKeeper.runTaskStatus = "done";
        specKeeper.epicStatus = "done";
        return {
            success: true,
            reviewAttempt,
            executionPhases,
            reviewCalls: 0,
            specKeeper,
            events,
            reviewOutcome: null,
        };
    }

    // The review branch executes exactly once before the single review.
    executionPhases += 1;
    events.push("execution-phase");
    reviewAttempt += 1;

    let review;
    try {
        review = runReviewSimulation(reviewResponses);
    } catch (error) {
        error.executionPhases = executionPhases;
        error.reviewAttempt = reviewAttempt;
        error.events = events;
        throw error;
    }

    if (review.passed) {
        // Passing review: Spec Keeper run task and epic are marked done and the
        // run succeeds (the actual commit/merge is covered by review-commit tests).
        events.push("review-passed");
        specKeeper.runTaskStatus = "done";
        specKeeper.epicStatus = "done";
        return {
            success: true,
            reviewAttempt,
            executionPhases,
            reviewCalls: review.calls,
            specKeeper,
            events,
            reviewOutcome: "passed",
        };
    }

    // Failing review: NO re-execution. Mark Spec Keeper blocked, clean up the
    // worktree, and return { success: false }.
    events.push("review-failed");
    specKeeper.runTaskStatus = "blocked";
    specKeeper.epicStatus = "blocked";
    return {
        success: false,
        reviewAttempt,
        executionPhases,
        reviewCalls: review.calls,
        specKeeper,
        events,
        reviewOutcome: "failed",
        failureWorktreeCleanedUp: true,
        error: "Review did not pass; the work was left uncommitted and the task was marked blocked.",
    };
}

let failures = 0;
function check(name, cond) { if (cond) console.log(`PASS: ${name}`); else { console.error(`FAIL: ${name}`); failures += 1; } }

// 1. Pass on the first review -> 1 execution phase, attempt 1, success.
{
    const r = simulateRunPromptOnce([
        { valid: true, review: { passed: true, reasons: [], learnings: [] } },
    ]);
    check("pass uses exactly one execution phase", r.executionPhases === 1);
    check("pass review attempt starts at 1", r.reviewAttempt === 1);
    check("pass returns success true", r.success === true);
    check("pass marks run task done", r.specKeeper.runTaskStatus === "done");
    check("pass marks epic done", r.specKeeper.epicStatus === "done");
    check("pass does not take the failure cleanup path", r.failureWorktreeCleanedUp !== true);
}

// 2. Fail on the first review -> NO restart; blocked, error, cleanup, false.
{
    const r = simulateRunPromptOnce([
        { valid: true, review: { passed: false, reasons: ["missing docs", "no tests"], learnings: ["add docs"] } },
    ]);
    check("fail uses exactly one execution phase (no restart)", r.executionPhases === 1);
    check("fail review attempt starts at 1", r.reviewAttempt === 1);
    check("fail returns success false", r.success === false);
    check("fail marks run task blocked", r.specKeeper.runTaskStatus === "blocked");
    check("fail marks epic blocked", r.specKeeper.epicStatus === "blocked");
    check("fail cleans up the execution worktree", r.failureWorktreeCleanedUp === true);
    check("fail emits the stop-on-failure error", r.error === "Review did not pass; the work was left uncommitted and the task was marked blocked.");
    check("fail never re-enters the execution phase", r.events.filter((event) => event === "execution-phase").length === 1);
    check("fail outcome is failed", r.reviewOutcome === "failed");
}

// 3. Malformed review JSON -> parse retries then RunAbortError (no success return).
{
    let threw = null;
    try {
        simulateRunPromptOnce([
            { valid: false, reason: "Review response did not contain a JSON object." },
            { valid: false, reason: "Review JSON could not be parsed: bad token" },
            { valid: false, reason: "passed must be a boolean." },
        ]);
    } catch (error) { threw = error; }
    check("malformed review JSON aborts with RunAbortError", threw !== null && threw.name === "RunAbortError");
    check("abort error names the parse retry limit", threw !== null && threw.message.includes("after 2 retries"));
    check("parse retries consumed initial attempt plus 2 retries", threw !== null && threw.reviewCalls === 3);
    check("abort still ran exactly one execution phase", threw !== null && threw.executionPhases === 1);
    check("abort review attempt was 1", threw !== null && threw.reviewAttempt === 1);
}

// 4. Review disabled (options.review === false) -> no review loop.
{
    const r = simulateRunPromptOnce([], { review: false });
    check("review disabled issues no review calls", r.reviewCalls === 0);
    check("review disabled review attempt stays 0", r.reviewAttempt === 0);
    check("review disabled still runs one execution phase", r.executionPhases === 1);
    check("review disabled marks run task done", r.specKeeper.runTaskStatus === "done");
    check("review disabled marks epic done", r.specKeeper.epicStatus === "done");
    check("review disabled returns success true", r.success === true);
}

if (failures === 0) { console.log("\nAll review-loop tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
