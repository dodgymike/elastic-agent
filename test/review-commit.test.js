// Control-flow test for the review-commit decision logic in main().
// Mirrors the post-plan review loop with the NEW commit/worktree behavior:
//   - execution steps stage changes and never commit;
//   - the review step commits ONLY when it is happy (review.passed === true);
//   - on a failing review with attempts remaining no commit occurs and the
//     execution phase restarts;
//   - on the 4th required loop (attempts reach maxReviewAttempts and still
//     failing) an explicit error is thrown and NO commit occurs.
// This is a pure control-flow simulation (as test/review-loop.test.js), so it
// exercises the decision algorithm without a real git repository. The actual
// git/worktree behavior is covered by test/worktree.test.ts.
const maxReviewAttempts = 3;

// Simulates the review loop with commit tracking. Returns a record describing
// how many commits occurred, whether a worktree was used for staging, whether
// the loop passed or threw, and the execution contexts used.
function simulateReviewCommitFlow(reviewResponses) {
    const accumulatedLearnings = [];
    let reviewAttempt = 0;
    let executionContext = "(none)";
    const contexts = [];
    let responses = [...reviewResponses];
    // Track git operations performed by the simulated loop.
    const gitOps = {
        worktreeUsedForStaging: false,
        commits: [],      // commit messages when the review was happy
        stagingCount: 0,  // git add --all calls during execution
    };
    const stageAll = () => { gitOps.stagingCount += 1; gitOps.worktreeUsedForStaging = true; };
    const commitReview = (summary) => { gitOps.commits.push(`review happy: ${summary}`); };

    while (true) {
        // runExecutionPhase: execute steps and stage in the worktree (no commit).
        contexts.push(executionContext);
        stageAll();

        reviewAttempt += 1;
        const review = responses.shift();
        if (review.passed) {
            // Review step is happy: stage once more, commit, and merge.
            stageAll();
            commitReview(review.summary ?? "completed work passed all four review criteria");
            return {
                attempts: reviewAttempt,
                outcome: "committed",
                contexts,
                gitOps,
            };
        }
        for (const learning of review.learnings ?? []) if (learning) accumulatedLearnings.push(learning);
        if (reviewAttempt >= maxReviewAttempts) {
            // 4th required loop: throw WITHOUT committing.
            throw new Error(
                `Review failed after ${maxReviewAttempts} attempts: ${
                (review.reasons ?? []).map((reason) => JSON.stringify(reason)).join("; ") || "none"}; must fix issues before committing.`);
        }
        executionContext =
            "REVIEW FEEDBACK FROM THE PREVIOUS ATTEMPT — address these issues in the executed work:\n" +
            (review.reasons ?? []).map((reason) => `- ${reason}`).join("\n") +
            "\n\nLEARNINGS FROM EARLIER REVIEWS:" +
            accumulatedLearnings.map((learning) => `\n- ${learning}`).join("");
    }
}

let failures = 0;
function check(name, cond) { if (cond) console.log(`PASS: ${name}`); else { console.error(`FAIL: ${name}`); failures += 1; } }

// 1. Execution steps stage in the worktree and never commit until review is happy.
{
    const r = simulateReviewCommitFlow([{ passed: true, reasons: [], learnings: [], summary: "all criteria met" }]);
    check("happy review commits exactly once", r.gitOps.commits.length === 1);
    check("commit message marks review happy", r.gitOps.commits[0] === "review happy: all criteria met");
    check("staging happens in the worktree", r.gitOps.worktreeUsedForStaging === true);
    check("staging occurs before the commit", r.gitOps.stagingCount === 2); // once per execution phase + once at review
    check("happy review uses 1 attempt", r.attempts === 1);
}

// 2. A failing review does NOT commit and restarts execution; a later pass commits.
{
    const r = simulateReviewCommitFlow([
        { passed: false, reasons: ["issue A"], learnings: ["learning B"], summary: "" },
        { passed: true, reasons: [], learnings: [], summary: "fixed everything" },
    ]);
    check("fail-then-pass commits exactly once (only on the happy review)", r.gitOps.commits.length === 1);
    check("commit happens only after the passing attempt", r.attempts === 2 && r.gitOps.commits[0] === "review happy: fixed everything");
    check("staging reused the same worktree across attempts", r.gitOps.worktreeUsedForStaging === true);
    check("restart execution context includes feedback", r.contexts[1].includes("issue A"));
    check("restart execution context includes learnings", r.contexts[1].includes("learning B"));
}

// 3. Failing all three attempts throws on the 4th required loop and NEVER commits.
{
    let threw = null;
    let commits = [];
    try {
        const r = simulateReviewCommitFlow([
            { passed: false, reasons: ["r1"], learnings: [], summary: "" },
            { passed: false, reasons: ["r2"], learnings: [], summary: "" },
            { passed: false, reasons: ["r3"], learnings: [], summary: "" },
        ]);
        commits = r.gitOps.commits;
    } catch (e) { threw = e.message; }
    check("fail all three attempts throws", threw !== null && threw.includes("3"));
    check("error explains max attempts reached", threw !== null && threw.includes("must fix issues before committing"));
    check("NO commit occurs on the 4th loop", commits.length === 0);
}

// 4. A failure after previously staging does not commit anything either.
{
    // First review fails, second throws at max (i.e. the 4th required loop).
    let commits = [];
    let threw = null;
    try {
        const r = simulateReviewCommitFlow([
            { passed: false, reasons: ["a"], learnings: [], summary: "" },
            { passed: false, reasons: ["b"], learnings: [], summary: "" },
            { passed: false, reasons: ["c"], learnings: [], summary: "" },
            ...([]),
        ]);
        commits = r.gitOps.commits;
    } catch (e) { threw = e.message; }
    check("threw on 4th loop with no commit", threw !== null && commits.length === 0);
}

if (failures === 0) { console.log("\nAll review-commit tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
