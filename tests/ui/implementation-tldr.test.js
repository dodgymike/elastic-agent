"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const source = readFileSync("src/main.ts", "utf8");

// The end-of-run implementation tldr must recap the original prompt and a
// short summary of the final plan before summarizing what was executed.
const tldrStart = source.indexOf("function reportImplementationTldr(");
assert.notEqual(tldrStart, -1, "src/main.ts must define reportImplementationTldr");

const tldrBody = source.slice(tldrStart);
const recordUsageAt = tldrBody.indexOf("function recordUsage(");
assert.notEqual(recordUsageAt, -1, "reportImplementationTldr must be followed by a function boundary");
const tldrFn = tldrBody.slice(0, recordUsageAt);

// 1. The prompt must be surfaced (not intentionally discarded).
assert.ok(tldrFn.includes("Prompt: ${promptSummary}"), "tldr must print the original prompt");
assert.ok(tldrFn.includes("String(originalPrompt ?? \"\")"), "tldr must derive the prompt summary from originalPrompt");
assert.ok(!tldrFn.includes("void originalPrompt"), "tldr must no longer discard the originalPrompt argument");

// 2. A concise summary of the final plan must be printed, drawn from the
//    persisted plan tldr and the final active plan steps.
assert.ok(tldrFn.includes("Final plan:"), "tldr must print a short summary of the final plan");
assert.ok(tldrFn.includes("configData?.activePlanSteps"), "tldr must use activePlanSteps for the final plan length");
assert.ok(tldrFn.includes("configData?.planTldr"), "tldr must use the persisted plan tldr");

// 3. The plan's top-level tldr is persisted at planning time so the end-of-run
//    tldr can recap it. The helper normalizes object-valued tldrs so they never
//    render as "[object Object]".
assert.ok(source.includes("function planTldrSummary(value: unknown): string"), "src/main.ts must define planTldrSummary");
assert.ok(source.includes("configData.planTldr = planTldrSummary("), "planning must persist the plan tldr via planTldrSummary");
assert.ok(source.includes("never render as \"[object Object]\""), "planTldrSummary must guard against object-stringification");

// 4. The run still reaches reportImplementationTldr only through the shared
//    status.tldr helper so the full recap prints under the plan hierarchy.
assert.ok(tldrFn.includes("status.tldr(summaryLines.join(\"\\n\"), prefix);"), "tldr must print through the shared status.tldr helper");

// 5. Each completed ledger entry carries a normalized `outcome` plus the
//    `evidence` that produced it (stepStatus/summary/findings, or a validation
//    diagnostic for invalid feedback); the tldr must surface those per-step
//    results/comments under a dedicated heading rather than fabricating
//    feedback.
assert.ok(tldrFn.includes("summaryLines.push(\"Step results/comments:\")"), "tldr must print a 'Step results/comments:' heading when per-step feedback exists");
assert.ok(tldrFn.includes("`Step ${entry.step}: ${truncate(String(entry.text ?? \"\")"), "tldr must label each result line with its step number and text");
assert.ok(tldrFn.includes("\"  Result: no per-step feedback recorded.\""), "tldr must fall back to a no-feedback note when a step has no recorded result");
assert.ok(tldrFn.includes("\`  Summary: ${truncate(String(result.summary)"), "tldr must render each step's result summary");
assert.ok(tldrFn.includes("\`  Findings: ${findings.join(\" | \")}"), "tldr must render each step's result findings");
assert.ok(tldrFn.includes("never includes file contents, data.json, or"), "tldr must not surface secrets in step results");

// 6. The execution loop keeps two distinct records: an append-only attempt
//    history (configData.executionAttempts) with a normalized outcome per
//    executePlanStep result, and a completion ledger (configData.completedSteps)
//    that records only terminal outcomes plus their evidence. Both are derived
//    only from the model's feedback summary/findings or a validation error —
//    never from file contents, data.json, or secrets.
assert.ok(source.includes("snapshotStepFeedback({ feedbackEntry"), "execution must normalize feedback through the shared snapshot");
assert.ok(source.includes("configData.executionAttempts.push(snapshot.attempt)"), "every attempt must be retained");
assert.ok(source.includes("if (snapshot.ledgerEntry)"), "completion ledger uses the snapshot's terminal gate");
assert.ok(source.includes("configData.completedSteps.push(snapshot.ledgerEntry)"), "completion ledger preserves normalized evidence");
const { snapshotStepFeedback } = require("../../.test-build/src/planning/step-outcome.js");
const failed = snapshotStepFeedback({ feedbackEntry: { valid: false, validationError: "bad JSON" }, step: 1 });
assert.equal(failed.attempt.outcome, "invalid");
assert.equal(failed.reduced.terminalSuccess, false);
assert.equal(failed.ledgerEntry.feedbackResponseId, null);
assert.ok(failed.attempt.timestamp);
assert.ok(source.includes("function stepDisplayResult"), "the tldr must derive its display result from the ledger outcome/evidence");

console.log("implementation-tldr structure passed");
