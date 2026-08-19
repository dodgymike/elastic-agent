"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const source = readFileSync("main.ts", "utf8");

// The end-of-run implementation tldr must recap the original prompt and a
// short summary of the final plan before summarizing what was executed.
const tldrStart = source.indexOf("function reportImplementationTldr(");
assert.notEqual(tldrStart, -1, "main.ts must define reportImplementationTldr");

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
assert.ok(source.includes("function planTldrSummary(value: unknown): string"), "main.ts must define planTldrSummary");
assert.ok(source.includes("configData.planTldr = planTldrSummary("), "planning must persist the plan tldr via planTldrSummary");
assert.ok(source.includes("never render as \"[object Object]\""), "planTldrSummary must guard against object-stringification");

// 4. The run still reaches reportImplementationTldr only through the shared
//    status.tldr helper so the full recap prints under the plan hierarchy.
assert.ok(tldrFn.includes("status.tldr(summaryLines.join(\"\\n\"), prefix);"), "tldr must print through the shared status.tldr helper");

console.log("implementation-tldr structure passed");
