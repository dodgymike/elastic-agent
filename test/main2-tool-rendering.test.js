"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync("main2.js", "utf8");
const helperStart = source.indexOf("function truncate(");
const helperEnd = source.indexOf("function appendHistory(", helperStart);
assert.notEqual(helperStart, -1, "main2.js must define tool-call rendering helpers");
assert.notEqual(helperEnd, -1, "main2.js must retain a boundary after tool-call rendering helpers");

const events = [];
const context = {
  status: {
    tool: (message) => events.push(["pending", message]),
    success: (message) => events.push(["succeeded", message]),
    error: (message) => events.push(["failed", message]),
  },
};
vm.createContext(context);
vm.runInContext(source.slice(helperStart, helperEnd), context, { filename: "main2-tool-rendering-helpers.js" });

// Pending output is concise and safely summarizes parseable arguments.
context.renderToolCallPending({ name: "Read", arguments: '{"path":"/tmp/example.txt"}' });
assert.deepEqual(events.pop(), ["pending", 'Pending: Read {"path":"/tmp/example.txt"}']);

// A completed call retains its tool name and emits a bounded result summary.
context.renderToolCallSucceeded({ name: "Read" }, { content: "hello" });
assert.deepEqual(events.pop(), ["succeeded", 'Succeeded: Read → {"content":"hello"}']);

// A failed call retains the tool name and the actionable error text.
context.renderToolCallFailed({ name: "Read" }, "permission denied");
assert.deepEqual(events.pop(), ["failed", "Failed: Read: permission denied"]);

// The execution loop must emit pending before parsing/execution, then a single
// terminal state, while retaining function_call_output and TLDR history on both paths.
const executionStart = source.indexOf("async function executePlanStep(");
const executionEnd = source.indexOf("\nasync function main()", executionStart);
assert.notEqual(executionStart, -1, "main2.js must define executePlanStep");
assert.notEqual(executionEnd, -1, "main2.js must retain the main boundary");
const execution = source.slice(executionStart, executionEnd);
const pendingAt = execution.indexOf("renderToolCallPending(output);");
const parseAt = execution.indexOf("toolArguments = JSON.parse(output.arguments);");
const executeAt = execution.indexOf("await tool.exec_handler(toolArguments);");
const successAt = execution.indexOf("renderToolCallSucceeded(output, toolResponse);");
const failureAt = execution.indexOf("renderToolCallFailed(output, toolResponse.error);");
assert.ok(pendingAt >= 0 && pendingAt < parseAt && parseAt < executeAt, "pending rendering must precede parsing and execution");
assert.ok(successAt > executeAt, "successful calls must render terminal success after execution");
assert.ok(failureAt > executeAt, "failed calls must render terminal failure from the execution catch path");
assert.equal((execution.match(/toolOutputs\.push\(functionCallOutput\(output, toolResponse\)\);/g) ?? []).length, 2, "success and failure paths must preserve function_call_output");
assert.equal((execution.match(/appendHistory\(configData\.toolCallTldrs,/g) ?? []).length, 2, "success and failure paths must preserve tool-call TLDR history");

console.log("main2 tool-call rendering fixtures passed");
