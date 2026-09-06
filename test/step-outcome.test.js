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
    memoryOutcomeFromOutcome,
    specKeeperStepStatusFromOutcome,
    specKeeperStepNoteFromOutcome,
    taskLifecycleNoteFromOutcome,
    reduceStepOutcome,
    feedbackEvidence,
    feedbackEvidenceSatisfied,
    snapshotStepFeedback,
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

// 13. memoryOutcomeFromOutcome: only succeeded is ever remembered as completed.
{
    check("memoryOutcomeFromOutcome: succeeded -> completed", memoryOutcomeFromOutcome("succeeded") === "completed");
    check("memoryOutcomeFromOutcome: failed -> failed", memoryOutcomeFromOutcome("failed") === "failed");
    check("memoryOutcomeFromOutcome: blocked -> aborted", memoryOutcomeFromOutcome("blocked") === "aborted");
    check("memoryOutcomeFromOutcome: needs-verification -> unknown", memoryOutcomeFromOutcome("needs-verification") === "unknown");
    check("memoryOutcomeFromOutcome: invalid -> unknown (never completed)", memoryOutcomeFromOutcome("invalid") === "unknown");
    check("memoryOutcomeFromOutcome: pending -> unknown", memoryOutcomeFromOutcome("pending") === "unknown");
    check("memoryOutcomeFromOutcome: running -> unknown", memoryOutcomeFromOutcome("running") === "unknown");
}

// 14. specKeeperStepStatusFromOutcome: only succeeded becomes done.
{
    check("specKeeperStepStatusFromOutcome: succeeded -> done", specKeeperStepStatusFromOutcome("succeeded") === "done");
    check("specKeeperStepStatusFromOutcome: blocked -> blocked", specKeeperStepStatusFromOutcome("blocked") === "blocked");
    check("specKeeperStepStatusFromOutcome: failed -> failed", specKeeperStepStatusFromOutcome("failed") === "failed");
    check("specKeeperStepStatusFromOutcome: needs-verification -> in_progress", specKeeperStepStatusFromOutcome("needs-verification") === "in_progress");
    check("specKeeperStepStatusFromOutcome: invalid -> not done", specKeeperStepStatusFromOutcome("invalid") !== "done");
    check("specKeeperStepStatusFromOutcome: invalid -> failed (diagnostic)", specKeeperStepStatusFromOutcome("invalid") === "failed");
    check("specKeeperStepStatusFromOutcome: pending -> in_progress", specKeeperStepStatusFromOutcome("pending") === "in_progress");
    check("specKeeperStepStatusFromOutcome: running -> in_progress", specKeeperStepStatusFromOutcome("running") === "in_progress");
}

// 15. Note builders carry the step number and a diagnostic for invalid feedback.
{
    check(
        "specKeeperStepNoteFromOutcome: succeeded carries summary",
        specKeeperStepNoteFromOutcome("succeeded", { stepNumber: 2, summary: "all green" }) === "Step 2 completed. all green",
    );
    check(
        "specKeeperStepNoteFromOutcome: blocked carries summary",
        specKeeperStepNoteFromOutcome("blocked", { stepNumber: 2, summary: "tool unavailable" }) === "Step 2 blocked. tool unavailable",
    );
    check(
        "specKeeperStepNoteFromOutcome: needs-verification carries diagnostic",
        specKeeperStepNoteFromOutcome("needs-verification", { stepNumber: 3 }).includes("needs verification"),
    );
    check(
        "specKeeperStepNoteFromOutcome: invalid carries validation diagnostic",
        specKeeperStepNoteFromOutcome("invalid", { stepNumber: 4, validationError: "Feedback JSON could not be parsed" })
            === "Step 4 outcome invalid: Feedback JSON could not be parsed.",
    );
    check(
        "taskLifecycleNoteFromOutcome: invalid never claims completion",
        taskLifecycleNoteFromOutcome("invalid", { stepNumber: 1, validationError: "boom" }).includes("outcome invalid"),
    );
    check(
        "taskLifecycleNoteFromOutcome: succeeded claims success",
        taskLifecycleNoteFromOutcome("succeeded", { stepNumber: 1, summary: "done" }) === "Plan step 1 succeeded. done",
    );
}

// 16. reduceStepOutcome fans one normalized outcome out to every consumer.
{
    const reduced = reduceStepOutcome("invalid", { stepNumber: 7, validationError: "malformed" });
    check("reduceStepOutcome: invalid outcome is invalid", reduced.outcome === "invalid");
    check("reduceStepOutcome: invalid terminalSuccess is false", reduced.terminalSuccess === false);
    check("reduceStepOutcome: invalid memoryOutcome is never completed", reduced.memoryOutcome !== "completed");
    check("reduceStepOutcome: invalid specKeeperStatus is never done", reduced.specKeeperStatus !== "done");
    check("reduceStepOutcome: invalid specKeeperNote is diagnostic", reduced.specKeeperNote.includes("Step 7 outcome invalid"));
    check("reduceStepOutcome: invalid taskLifecycleNote is diagnostic", reduced.taskLifecycleNote.includes("outcome invalid"));
}

// 17. Fake memory/Spec Keeper/task-lifecycle clients: invalid feedback never
//     emits `done` or a `completed` memory outcome (no real external updates).
{
    const makeFakeClients = () => ({
        memory: { remembered: [] },
        specKeeper: { stepTaskUpdates: [] },
        taskLifecycle: { notes: [] },
    });

    // Mirror the runExecutionPhase consumer dispatch using the same reducer
    // outputs, then assert nothing about invalid feedback looks like success.
    const dispatchForFeedback = (feedbackEntry, stepNumber) => {
        const attemptRecord = attemptFromFeedback({
            responseId: feedbackEntry?.response_id ?? null,
            rawStatus: feedbackEntry?.valid ? feedbackEntry.feedback.stepStatus : undefined,
            evidence: feedbackEntry?.valid
                ? { stepStatus: feedbackEntry.feedback.stepStatus, summary: feedbackEntry.feedback.summary, findings: feedbackEntry.feedback.findings ?? [] }
                : { validationError: feedbackEntry?.validationError ?? "execution feedback was missing or malformed" },
            evidenceSatisfied: (evidence) =>
                Array.isArray(evidence?.findings) && evidence.findings.length > 0
                    ? true
                    : Boolean(evidence?.summary && String(evidence.summary).trim().length > 0),
        });
        const reduction = reduceStepOutcome(attemptRecord.outcome, {
            stepNumber,
            summary: feedbackEntry?.valid ? feedbackEntry.feedback.summary : undefined,
            validationError: feedbackEntry?.valid ? undefined : (feedbackEntry?.validationError ?? "execution feedback was missing or malformed"),
        });
        const clients = makeFakeClients();
        clients.memory.remembered.push({ outcome: reduction.memoryOutcome, detail: { normalizedOutcome: reduction.outcome } });
        clients.specKeeper.stepTaskUpdates.push({ status: reduction.specKeeperStatus, note: reduction.specKeeperNote });
        clients.taskLifecycle.notes.push({ action: `step ${stepNumber} ${reduction.specKeeperStatus}`, note: reduction.taskLifecycleNote });
        return { reduction, clients };
    };

    const invalidJson = { valid: false, response_id: "resp-invalid", validationError: "Feedback JSON could not be parsed" };
    const invalid = dispatchForFeedback(invalidJson, 1);
    check("fake clients: invalid JSON normalizes to invalid", invalid.reduction.outcome === "invalid");
    check("fake clients: invalid JSON never remembers completed", invalid.clients.memory.remembered.every((m) => m.outcome !== "completed"));
    check("fake clients: invalid JSON never marks Spec Keeper done", invalid.clients.specKeeper.stepTaskUpdates.every((u) => u.status !== "done"));
    check("fake clients: invalid JSON task note is diagnostic", invalid.clients.taskLifecycle.notes[0].note.includes("outcome invalid"));

    const bareCompleted = { valid: true, response_id: "resp-bare", feedback: { stepStatus: "completed", summary: "", findings: [] } };
    const bare = dispatchForFeedback(bareCompleted, 2);
    check("fake clients: bare completed normalizes to needs-verification", bare.reduction.outcome === "needs-verification");
    check("fake clients: bare completed never marks Spec Keeper done", bare.clients.specKeeper.stepTaskUpdates.every((u) => u.status !== "done"));
    check("fake clients: bare completed memory is not completed", bare.clients.memory.remembered.every((m) => m.outcome !== "completed"));

    const successful = { valid: true, response_id: "resp-ok", feedback: { stepStatus: "completed", summary: "checks passed", findings: ["lint ok"] } };
    const success = dispatchForFeedback(successful, 3);
    check("fake clients: evidenced completed normalizes to succeeded", success.reduction.outcome === "succeeded");
    check("fake clients: evidenced completed marks Spec Keeper done", success.clients.specKeeper.stepTaskUpdates[0].status === "done");
    check("fake clients: evidenced completed remembers completed", success.clients.memory.remembered[0].outcome === "completed");

    const blocked = { valid: true, response_id: "resp-block", feedback: { stepStatus: "blocked", summary: "tool unavailable", findings: [] } };
    const blockedDispatch = dispatchForFeedback(blocked, 4);
    check("fake clients: blocked maps to blocked (not done)", blockedDispatch.reduction.outcome === "blocked" && blockedDispatch.clients.specKeeper.stepTaskUpdates[0].status === "blocked");
}

// 18. PI-01 behavioral coverage: the five requested fake feedback entries
//     (invalid JSON, failed checks, blocked tools, successful checks, and
//     successful non-code deliverables) reduce through snapshotStepFeedback
//     into one normalized outcome that the local ledgers, memory, external
//     Spec Keeper status, and review input all agree on. The review line is the
//     exact formatExecutedSteps contract: "N. text [outcome]".
{
    const reviewLine = (entry) => `${entry.step}. ${entry.text}${entry.outcome ? ` [${entry.outcome}]` : ""}`;
    const fixtures = [
        {
            name: "invalid JSON",
            entry: { valid: false, response_id: "resp-invalid-json", validationError: "Feedback JSON could not be parsed" },
            stepText: "Run the checks",
            outcome: "invalid",
            memory: "unknown",
            specKeeper: "failed",
        },
        {
            name: "failed checks",
            entry: { valid: true, response_id: "resp-failed-checks", feedback: { stepStatus: "failed", summary: "checks failed", findings: ["lint failed"] } },
            stepText: "Run the checks",
            outcome: "failed",
            memory: "failed",
            specKeeper: "failed",
        },
        {
            name: "blocked tools",
            entry: { valid: true, response_id: "resp-blocked-tool", feedback: { stepStatus: "blocked", summary: "tool unavailable", findings: [] } },
            stepText: "Use the sandbox tool",
            outcome: "blocked",
            memory: "aborted",
            specKeeper: "blocked",
        },
        {
            name: "successful checks",
            entry: { valid: true, response_id: "resp-success-checks", feedback: { stepStatus: "completed", summary: "checks passed", findings: ["lint ok", "test ok"] } },
            stepText: "Run the checks",
            outcome: "succeeded",
            memory: "completed",
            specKeeper: "done",
        },
        {
            name: "successful non-code deliverables",
            entry: { valid: true, response_id: "resp-success-report", feedback: { stepStatus: "completed", summary: "wrote report", findings: ["deliverable: docs/REPORT.md created"] } },
            stepText: "Write the summary report",
            outcome: "succeeded",
            memory: "completed",
            specKeeper: "done",
        },
    ];

    for (const fixture of fixtures) {
        const snapshot = snapshotStepFeedback({ feedbackEntry: fixture.entry, step: 1, stepText: fixture.stepText });
        check(`${fixture.name}: attempt outcome is ${fixture.outcome}`, snapshot.attempt.outcome === fixture.outcome);
        check(`${fixture.name}: completion ledger records ${fixture.outcome}`, snapshot.ledgerEntry !== null && snapshot.ledgerEntry.outcome === fixture.outcome);
        check(`${fixture.name}: ledger carries executed step text`, snapshot.ledgerEntry !== null && snapshot.ledgerEntry.text === fixture.stepText);
        check(`${fixture.name}: reduced outcome matches ledger outcome`, snapshot.reduced.outcome === snapshot.ledgerEntry.outcome);
        check(`${fixture.name}: memory outcome agrees (${fixture.memory})`, snapshot.reduced.memoryOutcome === fixture.memory);
        check(`${fixture.name}: external Spec Keeper status agrees (${fixture.specKeeper})`, snapshot.reduced.specKeeperStatus === fixture.specKeeper);
        check(
            `${fixture.name}: review input renders the normalized outcome`,
            reviewLine(snapshot.ledgerEntry) === `1. ${fixture.stepText} [${fixture.outcome}]`,
        );
        check(
            `${fixture.name}: done/completed only when the outcome is succeeded`,
            (snapshot.reduced.specKeeperStatus === "done") === (fixture.outcome === "succeeded") &&
                (snapshot.reduced.memoryOutcome === "completed") === (fixture.outcome === "succeeded"),
        );
    }

    // Evidence builders stay secret-free and honor the documented criteria.
    {
        const validEvidence = feedbackEvidence({ valid: true, feedback: { stepStatus: "completed", summary: "ok", findings: ["f"] } });
        check("feedbackEvidence: valid entry contributes summary/findings only", validEvidence.summary === "ok" && validEvidence.findings[0] === "f");
        const invalidEvidence = feedbackEvidence({ valid: false, validationError: "bad shape" });
        check("feedbackEvidence: invalid entry contributes only the diagnostic", invalidEvidence.validationError === "bad shape" && !("findings" in invalidEvidence));
        check("feedbackEvidenceSatisfied: non-empty findings satisfy", feedbackEvidenceSatisfied({ findings: ["f"], summary: "" }) === true);
        check("feedbackEvidenceSatisfied: non-empty summary satisfies", feedbackEvidenceSatisfied({ findings: [], summary: "done" }) === true);
        check("feedbackEvidenceSatisfied: empty findings+summary do not satisfy", feedbackEvidenceSatisfied({ findings: [], summary: "" }) === false);
    }
}

if (failures === 0) { console.log("\nAll step-outcome tests passed."); process.exit(0); }
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
