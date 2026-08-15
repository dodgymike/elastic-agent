"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const source = readFileSync("main.ts", "utf8");

// Tool-call rendering is dispatched through the tool-renderer module while the
// agent loop keeps the existing wrapper names at its call sites.
assert.ok(
  source.includes('import { renderToolPhase, terminalColorEnabled, truncate, stringify } from "./tool-renderer.js";'),
  "main.ts must import the tool-renderer dispatcher",
);
assert.ok(source.includes("function renderToolCallPending(toolCall)"), "main.ts must retain the pending wrapper");
assert.ok(source.includes("function renderToolCallSucceeded(toolCall, result)"), "main.ts must retain the succeeded wrapper");
assert.ok(source.includes("function renderToolCallFailed(toolCall, error)"), "main.ts must retain the failed wrapper");
assert.ok(
  source.includes("renderToolPhase(phase, toolCall, payload, { color: terminalColor });"),
  "wrappers must dispatch through renderToolPhase",
);

// The execution loop must emit pending before parsing/execution, then a single
// terminal state, while retaining function_call_output and TLDR history on both paths.
const executionStart = source.indexOf("async function executePlanStep(");
const executionEnd = source.indexOf("\nasync function runExecutionPhase(", executionStart);
const mainStart = source.indexOf("\nasync function main(", executionStart);
assert.notEqual(executionStart, -1, "main.ts must define executePlanStep");
assert.notEqual(executionEnd, -1, "main.ts must retain a boundary after executePlanStep");
assert.notEqual(mainStart, -1, "main.ts must retain the main boundary");
const execution = source.slice(executionStart, executionEnd);
const pendingAt = execution.indexOf("renderToolCallPending(output);");
const parseAt = execution.indexOf("toolArguments = JSON.parse(output.arguments);");
const executeAt = execution.indexOf("await tool.exec_handler(toolArguments);");
const successAt = execution.indexOf("renderToolCallSucceeded(output, toolResponse);");
const failureAt = execution.indexOf("renderToolCallFailed(output, toolResponse.error);");
assert.ok(pendingAt >= 0 && pendingAt < parseAt && parseAt < executeAt, "pending rendering must precede parsing and execution");
assert.ok(successAt > executeAt, "successful calls must render terminal success after execution");
assert.ok(failureAt > executeAt, "failed calls must render terminal failure from the execution catch path");
assert.equal(
  (execution.match(/toolOutputs\.push\(functionCallOutput\(output, toolResponse\)\);/g) ?? []).length,
  2,
  "success and failure paths must preserve function_call_output",
);
assert.equal(
  (execution.match(/appendHistory\(configData\.toolCallTldrs,/g) ?? []).length,
  2,
  "success and failure paths must preserve tool-call TLDR history",
);

console.log("main2 tool-call rendering structure passed");
