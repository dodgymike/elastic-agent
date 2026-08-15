import assert from "node:assert/strict";
import {
  buildTaskWorkOrderBrief,
  buildTaskWorkOrderPrompt,
  formatAcceptanceCriteria,
  formatTaskEpic,
} from "../specKeeperTaskPrompt.js";
import type { TaskWorkOrder } from "../specKeeperTaskFetch.js";

const makeWorkOrder = (overrides: Partial<TaskWorkOrder> = {}): TaskWorkOrder => ({
  id: "TASK-1",
  title: "Add task mode",
  description: "Wire task mode into the CLI",
  acceptanceCriteria: ["Fetch tasks by id", "Claim fetched tasks"],
  status: "in_progress",
  epic: { key: "EPIC-A", title: "Task mode epic" },
  raw: { key: "TASK-1", title: "Add task mode", status: "in_progress" },
  ...overrides,
});

(async () => {
  // The full prompt carries the task id, work details, and Spec Keeper
  // lifecycle instructions for notes, status changes, and proofs.
  const prompt = buildTaskWorkOrderPrompt(makeWorkOrder(), {
    commitInstruction: "commit all of your work",
    toolsAvailable: "Write - usage prompt: tools/write-usage.md",
  });
  assert.match(prompt, /TASK-1/);
  assert.match(prompt, /Add task mode/);
  assert.match(prompt, /Wire task mode into the CLI/);
  assert.match(prompt, /Fetch tasks by id/);
  assert.match(prompt, /Claim fetched tasks/);
  assert.match(prompt, /EPIC-A/);
  assert.match(prompt, /Status: in_progress/);
  assert.match(prompt, /POST \/tasks\/TASK-1\/notes/);
  assert.match(prompt, /PATCH \/tasks\/TASK-1/);
  assert.match(prompt, /proof artifacts/);
  assert.match(prompt, /commit all of your work/);
  assert.match(prompt, /Tools available/);
  assert.match(prompt, /already claimed; do not claim it again/);

  // Missing description, criteria, and epic degrade to explicit placeholders.
  const minimal = buildTaskWorkOrderPrompt({
    id: "TASK-2",
    title: "Minimal task",
    description: "",
    acceptanceCriteria: [],
    status: "todo",
    epic: null,
    raw: {},
  });
  assert.match(minimal, /TASK-2/);
  assert.match(minimal, /Minimal task/);
  assert.match(minimal, /\(no description\)/);
  assert.match(minimal, /\(no acceptance criteria\)/);
  assert.match(minimal, /\(no epic\)/);

  // The brief form is concise and classifier-friendly: it excludes the full
  // lifecycle instructions but keeps the task id, title, and criteria.
  const brief = buildTaskWorkOrderBrief(makeWorkOrder());
  assert.match(brief, /Spec Keeper task TASK-1: Add task mode/);
  assert.match(brief, /Wire task mode into the CLI/);
  assert.match(brief, /Acceptance criteria:/);
  assert.doesNotMatch(brief, /SPEC KEEPER TASK MODE/);

  // Formatting helpers stay deterministic and secret-safe.
  assert.equal(formatAcceptanceCriteria(["one"]), "1. one");
  assert.equal(formatAcceptanceCriteria(["one", "two"]), "1. one\n2. two");
  assert.equal(formatAcceptanceCriteria([]), "(no acceptance criteria)");
  assert.equal(formatTaskEpic({ key: "EPIC-A" }), "EPIC-A");
  assert.equal(formatTaskEpic({ publicId: "p-1", title: "Epic title" }), "p-1 — Epic title");
  assert.equal(formatTaskEpic(null), "(no epic)");

  console.log("Spec Keeper task prompt fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
