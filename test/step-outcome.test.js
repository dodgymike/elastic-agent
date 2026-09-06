// Unit tests for the pure normalized step-outcome module (step-outcome.ts).
//
// Compiled into test/.step-outcome-build by the test:step-outcome npm script;
// this file requires the compiled output, mirroring the existing
// test:plan-parser / test:plan-print compile-and-run pattern.
const {
    STEP_OUTCOMES,
    isStepOutcome,
    hasEvidence,
    outcomeFromFeedback,
    isTerminalSuccess,
    isTerminalOutcome,
    attemptFromFeedback,
} = require("./.step-outcome-build/step-outcome.js");

let failures = 0;
function check(name, cond) {
    if (cond) { console.log(`PASS: ${name}`); }
    else { console.error(`FAIL: ${name}`); failures += 1; }
}

// 1. The exported outcome set is the exact closed vocabulary.
{
    check(
        "STEP_OUTCOMES is the exact seven-state vocabulary in order",
        JSON.stringify(STEP_OUTCOMES) === JSON.stringify([
            "pending",
            "running",
            "needs-verification",
            "succeeded",
            "failed",
            "blocked",
            "invalid",
        ]),
    );
    check("isStepOutcome accepts every declared state", STEP_OUTCOMES.every((s) => isStepOutcome(s)));
    check("isStepOutcome rejects an unknown string", isStepOutcome("done") === false);
    check("isStepOutcome rejects non-strings", isStepOutcome(1) === false && isStepOutcome(null) === false);
}

// 2. hasEvidence: presence only, never a claim about whether evidence proves success.
{
    check("hasEvidence: null/undefined are not evidence", hasEvidence(null) === false && hasEvidence(undefined) === false);
    check("hasEvidence: non-empty string is evidence", hasEvidence("check:lint passed") === true);
    check("hasEvidence: empty/whitespace string is not evidence", hasEvidence("") === false && hasEvidence("   ") === false);
    check("hasEvidence: non-empty array is evidence", hasEvidence(["a"]) === true);
    check("hasEvidence: empty array is not evidence", hasEvidence([]) === false);
    check("hasEvidence: non-empty object is evidence", hasEvidence({ checkId: "x" }) === true);
    check("hasEvidence: empty object is not evidence", hasEvidence({}) === false);
    check("hasEvidence: boolean true is evidence", hasEvidence(true) === true);
    check("hasEvidence: boolean false is not evidence", hasEvidence(false) === false);
    check("hasEvidence: non-zero number is evidence", hasEvidence(3) === true);
}

// 3. outcomeFromFeedback: completed -> succeeded only when evidence criteria are met.
{
    const evidence = { checkIds: ["lint", "test"], allPassed: true };
    check("completed with evidence -> succeeded", outcomeFromFeedback("completed", { evidence }) === "succeeded");
    check(
        "completed without evidence -> needs-verification (never infer success)",
        outcomeFromFeedback("completed", {}) === "needs-verification",
    );
    check(
        "completed with null evidence -> needs-verification",
        outcomeFromFeedback("completed", { evidence: null }) === "needs-verification",
    );
    check(
        "completed with requireEvidence:false -> succeeded",
        outcomeFromFeedback("completed", { requireEvidence: false }) === "succeeded",
    );
    check(
        "completed with satisfied evidence predicate -> succeeded",
        outcomeFromFeedback("completed", { evidence, evidenceSatisfied: (e) => e.allPassed === true }) === "succeeded",
    );
    check(
        "completed with failing evidence predicate -> needs-verification",
        outcomeFromFeedback("completed", { evidence, evidenceSatisfied: () => false }) === "needs-verification",
    );
    check(
        "completed with throwing evidence predicate -> needs-verification",
        outcomeFromFeedback("completed", { evidence, evidenceSatisfied: () => { throw new Error("boom"); } }) === "needs-verification",
    );
    check(
        "completed is trimmed before mapping",
        outcomeFromFeedback("  completed  ", { evidence }) === "succeeded",
    );
}

// 4. outcomeFromFeedback: other statuses map to the fixed normalized outcomes.
{
    check("partial -> needs-verification", outcomeFromFeedback("partial", {}) === "needs-verification");
    check("failed -> failed", outcomeFromFeedback("failed", {}) === "failed");
    check("blocked -> blocked", outcomeFromFeedback("blocked", {}) === "blocked");
}

// 5. outcomeFromFeedback: malformed/missing status -> invalid.
{
    check("missing status -> invalid", outcomeFromFeedback(undefined) === "invalid");
    check("null status -> invalid", outcomeFromFeedback(null) === "invalid");
    check("non-string status -> invalid", outcomeFromFeedback(42) === "invalid");
    check("object status -> invalid", outcomeFromFeedback({ stepStatus: "completed" }) === "invalid");
    check("empty string status -> invalid", outcomeFromFeedback("") === "invalid");
    check("whitespace-only status -> invalid", outcomeFromFeedback("   ") === "invalid");
    check("unknown status -> invalid", outcomeFromFeedback("done") === "invalid");
}

// 6. isTerminalSuccess: exactly one state is terminal success.
{
    check("isTerminalSuccess: succeeded is terminal success", isTerminalSuccess("succeeded") === true);
    for (const s of STEP_OUTCOMES.filter((x) => x !== "succeeded")) {
        check(`isTerminalSuccess: ${s} is not terminal success`, isTerminalSuccess(s) === false);
    }
}

// 7. isTerminalOutcome: needs-verification/pending/running are non-terminal.
{
    const terminal = ["succeeded", "failed", "blocked", "invalid"];
    const nonTerminal = ["pending", "running", "needs-verification"];
    for (const s of terminal) check(`isTerminalOutcome: ${s} is terminal`, isTerminalOutcome(s) === true);
    for (const s of nonTerminal) check(`isTerminalOutcome: ${s} is non-terminal`, isTerminalOutcome(s) === false);
}

// 8. attemptFromFeedback builds an append-only record with normalized outcome.
{
    const evidence = { checkIds: ["lint"] };
    const record = attemptFromFeedback({ responseId: "resp-1", rawStatus: "completed", evidence });
    check("attemptFromFeedback preserves response id", record.responseId === "resp-1");
    check("attemptFromFeedback preserves raw status", record.rawStatus === "completed");
    check("attemptFromFeedback normalizes completed+evidence to succeeded", record.outcome === "succeeded");
    check("attemptFromFeedback preserves evidence", record.evidence === evidence);
    check("attemptFromFeedback records an ISO timestamp", typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp)));
}

// 9. attemptFromFeedback: success is never inferred from a bare completed claim.
{
    const record = attemptFromFeedback({ responseId: "resp-2", rawStatus: "completed" });
    check("attemptFromFeedback: bare completed -> needs-verification", record.outcome === "needs-verification");
    check("attemptFromFeedback: bare completed is not terminal success", isTerminalSuccess(record.outcome) === false);
    check("attemptFromFeedback: missing evidence recorded as null", record.evidence === null);
}

// 10. attemptFromFeedback: missing/malformed raw status -> invalid, raw preserved.
{
    const missing = attemptFromFeedback({ responseId: "resp-3" });
    check("attemptFromFeedback: missing status -> invalid", missing.outcome === "invalid");
    check("attemptFromFeedback: missing raw status recorded as null", missing.rawStatus === null);

    const missingResponse = attemptFromFeedback({ rawStatus: "completed" });
    check("attemptFromFeedback: missing response id recorded as null", missingResponse.responseId === null);

    const malformed = attemptFromFeedback({ responseId: "resp-4", rawStatus: { status: "completed" } });
    check("attemptFromFeedback: malformed status -> invalid", malformed.outcome === "invalid");
    check("attemptFromFeedback: malformed raw status preserved", malformed.rawStatus.status === "completed");
}

// 11. attemptFromFeedback: explicit timestamp handling.
{
    const iso = attemptFromFeedback({ rawStatus: "failed", timestamp: "2024-01-02T03:04:05.000Z" });
    check("attemptFromFeedback: ISO string timestamp kept", iso.timestamp === "2024-01-02T03:04:05.000Z");

    const epoch = attemptFromFeedback({ rawStatus: "blocked", timestamp: 1700000000000 });
    check("attemptFromFeedback: epoch millis timestamp converted", epoch.timestamp === new Date(1700000000000).toISOString());

    const date = attemptFromFeedback({ rawStatus: "failed", timestamp: new Date("2024-06-07T08:09:10.000Z") });
    check("attemptFromFeedback: Date timestamp converted", date.timestamp === "2024-06-07T08:09:10.000Z");
}

// 12. attemptFromFeedback: failed/blocked normalize independently of evidence.
{
    const failed = attemptFromFeedback({ rawStatus: "failed", evidence: null });
    check("attemptFromFeedback: failed stays failed", failed.outcome === "failed");
    const blocked = attemptFromFeedback({ rawStatus: "blocked", evidence: null });
    check("attemptFromFeedback: blocked stays blocked", blocked.outcome === "blocked");
    const partial = attemptFromFeedback({ rawStatus: "partial", evidence: { a: 1 } });
    check("attemptFromFeedback: partial stays needs-verification", partial.outcome === "needs-verification");
}

if (failures === 0) { console.log("\nAll step-outcome tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
