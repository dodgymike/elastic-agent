// Control-flow test for the post-plan review loop logic in main().
// Mirrors the review-loop control flow (review pass stops, fail restarts
// execution, fail at max attempts throws) to verify the algorithm.
const maxReviewAttempts = 3;

// Simulates the review loop: returns { attempts, outcome, contexts }
function simulateReviewLoop(reviewResponses) {
    const accumulatedLearnings = [];
    let reviewAttempt = 0;
    let executionContext = "(none)";
    const contexts = [];
    let responses = [...reviewResponses];
    while (true) {
        // runExecutionPhase would execute steps -- record the context used
        contexts.push(executionContext);
        reviewAttempt += 1;
        const review = responses.shift();
        if (review.passed) {
            return { attempts: reviewAttempt, outcome: "passed", contexts };
        }
        for (const learning of review.learnings ?? []) if (learning) accumulatedLearnings.push(learning);
        if (reviewAttempt >= maxReviewAttempts) {
            throw new Error(
                `The review phase did not finish: after ${maxReviewAttempts} review attempt(s) the completed work ` +
                `still did not pass the review. Maximum review attempts (${maxReviewAttempts}) have been reached.`);
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

// 1. Pass on first attempt -> 1 attempt, no restart
{
    const r = simulateReviewLoop([{ passed: true, reasons: [], learnings: [] }]);
    check("pass on first attempt uses 1 attempt", r.attempts === 1);
    check("pass does not restart execution", r.contexts.length === 1);
    check("first execution context is (none)", r.contexts[0] === "(none)");
}

// 2. Fail once then pass -> 2 attempts, second execution carries feedback
{
    const r = simulateReviewLoop([
        { passed: false, reasons: ["issue A"], learnings: ["learning B"] },
        { passed: true, reasons: [], learnings: [] },
    ]);
    check("fail-then-pass uses 2 attempts", r.attempts === 2);
    check("fail-then-pass restarts execution once", r.contexts.length === 2);
    check("restart execution context includes feedback", r.contexts[1].includes("issue A"));
    check("restart execution context includes learnings", r.contexts[1].includes("learning B"));
}

// 3. Fail all 3 attempts -> throws at max
{
    let threw = null;
    try {
        simulateReviewLoop([
            { passed: false, reasons: ["r1"], learnings: [] },
            { passed: false, reasons: ["r2"], learnings: [] },
            { passed: false, reasons: ["r3"], learnings: [] },
        ]);
    } catch (e) { threw = e.message; }
    check("fail all three attempts throws", threw !== null && threw.includes("3"));
    check("error explains max attempts reached", threw !== null && threw.includes("Maximum review attempts"));
}

if (failures === 0) { console.log("\nAll review-loop tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
