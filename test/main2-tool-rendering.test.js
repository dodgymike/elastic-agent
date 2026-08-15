"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const source = readFileSync("main.ts", "utf8");

// Tool-call rendering is dispatched through the shared render helper and the
// tool-renderer map, with pending labels emitted inside dispatchToolCall before
// argument parsing or execution.
assert.ok(
  source.includes(
    'import { renderToolPhase, terminalColorEnabled, truncate, stringify } from "./tool-renderer.js";',
  ),
  "main.ts must import the tool-renderer dispatcher and display helpers",
);
assert.ok(source.includes("function renderToolCallPending(toolCall)"), "main.ts must retain the pending wrapper");
assert.ok(source.includes("function renderToolCallSucceeded(toolCall, result)"), "main.ts must retain the succeeded wrapper");
assert.ok(source.includes("function renderToolCallFailed(toolCall, error)"), "main.ts must retain the failed wrapper");

// The central dispatcher owns pending rendering before parsing/execution, then
// routes success and failure output through the wrappers.
const dispatchStart = source.indexOf("async function dispatchToolCall(");
const dispatchEnd = source.indexOf("\nasync function executePlanStep(", dispatchStart);
assert.notEqual(dispatchStart, -1, "main.ts must define dispatchToolCall");
assert.notEqual(dispatchEnd, -1, "main.ts must retain a boundary after dispatchToolCall");
const dispatch = source.slice(dispatchStart, dispatchEnd);
const pendingAt = dispatch.indexOf("renderToolCallPending(output);");
const parseAt = dispatch.indexOf("toolArguments = JSON.parse(output.arguments);");
const executeAt = dispatch.indexOf("await tool.exec_handler(toolArguments);");
const successAt = dispatch.indexOf("renderToolCallSucceeded(output, toolResponse);");
const failureAt = dispatch.indexOf("renderToolCallFailed(output, toolResponse);");
assert.ok(pendingAt >= 0 && pendingAt < parseAt && parseAt < executeAt, "pending rendering must precede parsing and execution");
assert.equal(
  (dispatch.match(/renderToolCallPending\(output\);/g) ?? []).length,
  1,
  "pending rendering must be emitted exactly once inside dispatchToolCall",
);
assert.ok(!dispatch.includes("[TOOL] Pending"), "dispatchToolCall must not emit a legacy pending prefix");
assert.ok(!dispatch.includes("[SUCCESS]"), "dispatchToolCall must not emit [SUCCESS]");
assert.ok(!dispatch.includes("[ERROR]"), "dispatchToolCall must not emit [ERROR]");
assert.ok(successAt > executeAt, "successful calls must render terminal success after execution");
assert.ok(failureAt > executeAt, "failed calls must render terminal failure from the execution catch path");

// The wrappers route every phase through the per-tool renderer map first so
// specialized views (the Git structured status, Edit diff, and redacted
// secret-carrying tools) are used when intended. Command-shaped tools delegate
// to the shared helper inside their own renderers, so no legacy prefix is used.
const pendingStart = source.indexOf("function renderToolCallPending(toolCall) {");
const succeededStart = source.indexOf("function renderToolCallSucceeded(toolCall, result) {", pendingStart);
const failedStart = source.indexOf("function renderToolCallFailed(toolCall, error) {", succeededStart);
const appendHistoryAt = source.indexOf("function appendHistory(history, value) {", failedStart);
assert.ok(pendingStart >= 0 && succeededStart > pendingStart && failedStart > succeededStart, "tool rendering wrappers must be defined in order");
assert.ok(appendHistoryAt > failedStart, "failed wrapper must have a following function boundary");

const pendingWrapper = source.slice(pendingStart, succeededStart);
const succeededWrapper = source.slice(succeededStart, failedStart);
const failedWrapper = source.slice(failedStart, appendHistoryAt);
assert.ok(pendingWrapper.includes('renderToolPhase("pending"'), "pending wrapper must dispatch through the per-tool renderer map");
assert.ok(!pendingWrapper.includes("Pending:"), "pending wrapper must not emit a legacy Pending: prefix");
assert.ok(succeededWrapper.includes('renderToolPhase("succeeded"'), "succeeded wrapper must dispatch through the per-tool renderer map");
assert.ok(!succeededWrapper.includes("renderToolCommand(toolCall, result"), "succeeded wrapper must not preempt per-tool renderers with the shared helper");
assert.ok(failedWrapper.includes('renderToolPhase("failed"'), "failed wrapper must dispatch through the per-tool renderer map");
assert.ok(!failedWrapper.includes("renderToolCommand(toolCall, error"), "failed wrapper must not preempt per-tool renderers with the shared helper");

// The in-place timer starts after the safety check and before execution, and
// stops once execution completes or throws. The timer's elapsed line is the
// tool output that appears immediately after the pending tool-call line and
// before any success/failure result line, so both the executing and completed
// states render as: tool-call line, timer, result.
const classifyAt = dispatch.indexOf("classification = await classifyToolCall(");
const timerAt = dispatch.indexOf("const timer = startToolTimer(");
const timerStartAt = dispatch.indexOf("timer.start();");
const timerStopAt = dispatch.indexOf("timer.stop();");
assert.ok(classifyAt >= 0 && classifyAt < executeAt, "safety classifier must remain visible before execution");
assert.ok(timerAt >= 0 && timerAt < timerStartAt && timerStartAt < executeAt, "timer must be created and started before tool execution");
assert.ok(timerStopAt > executeAt, "timer must be stopped after tool execution");
// The timer must be anchored immediately after the pending tool-call line (the
// timer is created/started after the pending label is emitted) and must finish
// before any success/failure result line so the elapsed time renders between
// the tool call and its result in the completed state.
assert.ok(pendingAt >= 0 && pendingAt < timerAt, "the pending tool-call line must be emitted before the timer is created");
assert.ok(timerStopAt < successAt, "the timer must stop (and render its elapsed line) before the success result line");
assert.ok(timerStopAt < failureAt, "the timer must stop (and render its elapsed line) before the failure result line");

// The execution loop delegates to the dispatcher and no longer renders success
// or failure directly from executePlanStep.
const executionStart = source.indexOf("async function executePlanStep(");
const executionEnd = source.indexOf("\nasync function runExecutionPhase(", executionStart);
assert.notEqual(executionStart, -1, "main.ts must define executePlanStep");
assert.notEqual(executionEnd, -1, "main.ts must retain a boundary after executePlanStep");
const execution = source.slice(executionStart, executionEnd);
assert.ok(
  /const dispatched = await dispatchToolCall\(output, configData, `plan-\$\{index \+ 1\}`\);/u.test(execution),
  "executePlanStep must delegate to dispatchToolCall with the plan-step goal key",
);
assert.ok(!execution.includes("renderToolCallSucceeded(dispatched.output"), "executePlanStep must not render success directly");
assert.ok(!execution.includes("renderToolCallFailed(dispatched.output"), "executePlanStep must not render failure directly");
assert.equal(
  (execution.match(/toolOutputs\.push\(functionCallOutput\(dispatched\.output, dispatched\.toolResponse\)\);/g) ?? []).length,
  1,
  "executePlanStep must preserve function_call_output from the dispatcher",
);
assert.equal(
  (execution.match(/appendHistory\(configData\.toolCallTldrs,/g) ?? []).length,
  1,
  "executePlanStep must preserve tool-call TLDR history",
);

console.log("main2 tool-call rendering structure passed");
