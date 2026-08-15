import assert from "node:assert/strict";
import {
  normalizeTaskId,
  resolveCliRunMode,
  TASK_ID_PATTERN,
} from "../cli-task-mode.js";

// Valid task mode: a task ID with no prompt selects task mode.
const taskMode = resolveCliRunMode("TASK-1", undefined);
assert.equal(taskMode.mode, "task");
assert.equal(taskMode.taskId, "TASK-1");
assert.equal(taskMode.prompt, undefined);

// Task IDs are trimmed and URL-safe forms are accepted.
assert.equal(resolveCliRunMode("  TASK-2  ", undefined).taskId, "TASK-2");
assert.equal(
  resolveCliRunMode("11111111-1111-1111-1111-111111111111", undefined).taskId,
  "11111111-1111-1111-1111-111111111111",
);
assert.equal(
  resolveCliRunMode("EA-brand.new_task", undefined).taskId,
  "EA-brand.new_task",
);

// Missing task ID with no prompt is a usage error.
assert.throws(
  () => resolveCliRunMode(undefined, undefined),
  /provide <prompt> for prompt mode or --task-id <task-id>/,
);

// Missing task ID with a blank prompt is still a usage error.
assert.throws(
  () => resolveCliRunMode(undefined, "   "),
  /provide <prompt> for prompt mode or --task-id <task-id>/,
);

// Malformed task IDs are rejected with an actionable diagnostic.
assert.throws(
  () => resolveCliRunMode("", undefined),
  /--task-id requires a non-empty Spec Keeper task ID/,
);
assert.throws(
  () => resolveCliRunMode("   ", undefined),
  /--task-id requires a non-empty Spec Keeper task ID/,
);
assert.throws(
  () => resolveCliRunMode("has space", undefined),
  /--task-id 'has space' is malformed/,
);
assert.throws(
  () => resolveCliRunMode("task/id", undefined),
  /--task-id 'task\/id' is malformed/,
);
assert.throws(() => normalizeTaskId("bad/id"), /malformed/);

// Prompt + task-id conflict is rejected.
assert.throws(
  () => resolveCliRunMode("TASK-1", "summarize this"),
  /<prompt> and --task-id cannot be used together/,
);

// Prompt mode is preserved unchanged for the original flow.
const promptMode = resolveCliRunMode(undefined, "summarize this");
assert.equal(promptMode.mode, "prompt");
assert.equal(promptMode.prompt, "summarize this");
assert.equal(promptMode.taskId, undefined);

// TASK_ID_PATTERN stays aligned with the normalization rule.
assert.ok(TASK_ID_PATTERN.test("TASK-1"));
assert.ok(!TASK_ID_PATTERN.test("bad id"));

console.log("CLI task-mode argument tests passed.");
