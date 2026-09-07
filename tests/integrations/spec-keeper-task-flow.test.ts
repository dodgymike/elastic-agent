import assert from "node:assert/strict";
import {
  syncSpecKeeperTask,
  updateSpecKeeperTask,
  updateTaskStatus,
  updateEpicStatus,
  syncPlanStepTasks,
  syncPlanStepTasksById,
  reconcilePlanStepTasks,
  taskIdentifier,
  generateTaskKey,
  selectMatchingTask,
} from "../../src/integrations/spec-keeper/specKeeperFlow.js";

const taskA = { key: "TASK-1", title: "do the thing", epic_key: "EPIC-A" };
const taskB = { key: "TASK-2", title: "unrelated other" };
const epicA = { key: "EPIC-A", title: "Epic A" };

assert.equal(taskIdentifier(taskA), "TASK-1");
assert.equal(taskIdentifier({ public_id: "11111111-1111-1111-1111-111111111111" }), "11111111-1111-1111-1111-111111111111");
assert.equal(taskIdentifier({}), undefined);
assert.equal(generateTaskKey("EA-", "Do the thing!"), "EA-do-the-thing");
assert.equal(generateTaskKey(undefined, "Do"), "TASK-do");
assert.equal(generateTaskKey("EA-", "!!! no words"), "EA-no-words");

assert.equal(selectMatchingTask([taskA, taskB], "TASK-2", "something else"), taskB);
assert.equal(selectMatchingTask([taskA, taskB], undefined, "do the thing"), taskA);
assert.equal(selectMatchingTask([taskA, taskB], undefined, "totally different"), undefined);

(async () => {
  const requests: any = [];
  const client = async (opts: { path: string; method?: string; body?: unknown }) => {
    (requests as any).push({ url: opts.path, method: opts.method ?? "GET", body: opts.body });
    const { path, method, body } = opts;
    if (path.startsWith("/epics") && method === "PATCH") {
      return { status: 200, statusText: "OK", headers: {}, body: { key: "EPIC-A", status: (body as any)?.status } };
    }
    if (path.startsWith("/tasks") && method === "PATCH") {
      return { status: 200, statusText: "OK", headers: {}, body: { key: (path as string).split("/")[2], ...(body as object) } };
    }
    if (path.startsWith("/tasks") && method === "POST") {
      return { status: 201, statusText: "Created", headers: {}, body: { key: (body as any)?.key, title: (body as any)?.title, epic_key: (body as any)?.epic_key, status: (body as any)?.status } };
    }
    if (path.startsWith("/tasks") && method === "GET") {
      return { status: 200, statusText: "OK", headers: {}, body: [taskA] };
    }
    return { status: 200, statusText: "OK", headers: {}, body: {} };
  };

  // Reuse an existing task by title (no POST is issued).
  const reused = await syncSpecKeeperTask({ title: "do the thing", epicId: "EPIC-A" }, client as never);
  assert.equal(reused.created, false);
  assert.equal(reused.task.key, "TASK-1");
  assert.ok(reused.selection.startsWith("reused task"));

  // Patch a task status.
  requests.length = 0;
  const updated = await updateSpecKeeperTask(taskA, { status: "done", status_note: "verified" }, {}, client as never);
  assert.deepEqual(requests, [
    { url: "/tasks/TASK-1", method: "PATCH", body: { status: "done", status_note: "verified" } },
  ]);
  assert.equal(updated.status, "done");

  // updateTaskStatus adds only the status and optional note.
  requests.length = 0;
  await updateTaskStatus(taskA, "in_progress", "started", {}, client as never);
  assert.deepEqual(requests, [
    { url: "/tasks/TASK-1", method: "PATCH", body: { status: "in_progress", status_note: "started" } },
  ]);

  // updateEpicStatus patches the epic route.
  requests.length = 0;
  await updateEpicStatus(epicA, "done", {}, client as never);
  assert.deepEqual(requests, [
    { url: "/epics/EPIC-A", method: "PATCH", body: { status: "done" } },
  ]);

  // syncPlanStepTasks creates one task per step with the first step in_progress.
  requests.length = 0;
  const noTasksClient = async (opts: { path: string; method?: string; body?: unknown }) => {
    (requests as any).push({ url: opts.path, method: opts.method ?? "GET", body: opts.body });
    const { path, method, body } = opts;
    if (path.startsWith("/tasks") && method === "GET") return { status: 200, statusText: "OK", headers: {}, body: [] as unknown[] };
    if (path.startsWith("/tasks") && method === "POST") {
      return { status: 201, statusText: "Created", headers: {}, body: { key: (body as any)?.key, title: (body as any)?.title, epic_key: (body as any)?.epic_key, status: (body as any)?.status } };
    }
    return { status: 200, statusText: "OK", headers: {}, body: {} };
  };
  const stepSync = await syncPlanStepTasks(epicA, ["First step", "Second step"], { keyPrefix: "EA-" }, noTasksClient as never);
  assert.equal(stepSync.createdCount, 2);
  assert.equal(stepSync.tasks.length, 2);
  assert.equal(stepSync.tasks[0].status, "in_progress");
  assert.equal(stepSync.tasks[1].status, "todo");
  assert.equal(requests[1].method, "POST");
  assert.deepEqual((requests[1].body as any)?.status, "in_progress");
  assert.deepEqual((requests[3].body as any)?.status, "todo");

  // Creating a new task includes the derived key, epic_key, and default status.
  requests.length = 0;
  const created = await syncSpecKeeperTask(
    { title: "Brand new task", epicId: "EPIC-A", keyPrefix: "EA-", defaultStatus: "in_progress" },
    noTasksClient as never,
  );
  assert.equal(created.created, true);
  assert.equal(created.task.key, "EA-brand-new-task");
  assert.deepEqual(requests[1].body, {
    key: "EA-brand-new-task",
    title: "Brand new task",
    description: "Auto-created by elastic-agent for: Brand new task",
    status: "in_progress",
    epic_key: "EPIC-A",
  });

  // syncPlanStepTasksById keys tasks by stable step ID instead of array position.
  requests.length = 0;
  const byId = await syncPlanStepTasksById(
    epicA,
    [
      { stepId: 10, title: "First step" },
      { stepId: 20, title: "Second step" },
    ],
    { keyPrefix: "EA-" },
    noTasksClient as never,
  );
  assert.equal(byId.createdCount, 2);
  assert.equal(byId.tasks.size, 2);
  assert.equal(byId.tasks.get(10)?.status, "in_progress");
  assert.equal(byId.tasks.get(20)?.status, "todo");
  assert.equal(byId.tasks.has(1), false);

  // reconcilePlanStepTasks keeps existing tasks by stable ID even when steps
  // are reordered/reworded, and creates a task only for newly introduced IDs.
  requests.length = 0;
  const reconcileClient = async (opts: { path: string; method?: string; body?: unknown }) => {
    (requests as any).push({ url: opts.path, method: opts.method ?? "GET", body: opts.body });
    const { path, method, body } = opts;
    if (path.startsWith("/tasks") && method === "GET") return { status: 200, statusText: "OK", headers: {}, body: [] as unknown[] };
    if (path.startsWith("/tasks") && method === "POST") {
      return { status: 201, statusText: "Created", headers: {}, body: { key: (body as any)?.key, title: (body as any)?.title, epic_key: (body as any)?.epic_key, status: (body as any)?.status } };
    }
    if (path.startsWith("/tasks") && method === "PATCH") {
      return { status: 200, statusText: "OK", headers: {}, body: { key: (path as string).split("/")[2], ...(body as object) } };
    }
    return { status: 200, statusText: "OK", headers: {}, body: {} };
  };
  const originalTasks = new Map<number, any>([
    [1, { key: "S-1", title: "Step one", status: "done" }],
    [2, { key: "S-2", title: "Step two", status: "todo" }],
  ]);
  const reconciled = await reconcilePlanStepTasks(
    epicA,
    originalTasks,
    [
      { stepId: 2, title: "Step two (reworded)" },
      { stepId: 3, title: "Step three" },
      { stepId: 1, title: "Step one" },
    ],
    { keyPrefix: "EA-", epicId: "EPIC-A" },
    reconcileClient as never,
  );
  assert.deepEqual(reconciled.createdStepIds, [3]);
  assert.deepEqual(reconciled.removedStepIds, []);
  assert.equal(reconciled.tasks.get(1), originalTasks.get(1));
  assert.equal(reconciled.tasks.get(2), originalTasks.get(2));
  assert.equal(reconciled.tasks.get(3)?.title, "Step three");
  assert.equal(originalTasks.size, 2);

  // A step ID that disappears is blocked (unless done) and dropped.
  requests.length = 0;
  const withRemoval = new Map<number, any>([
    [1, { key: "S-1", title: "Step one", status: "done" }],
    [2, { key: "S-2", title: "Step two", status: "todo" }],
    [3, { key: "S-3", title: "Step three", status: "in_progress" }],
  ]);
  const afterRemoval = await reconcilePlanStepTasks(
    epicA,
    withRemoval,
    [
      { stepId: 1, title: "Step one" },
      { stepId: 3, title: "Step three" },
    ],
    { keyPrefix: "EA-", epicId: "EPIC-A" },
    reconcileClient as never,
  );
  assert.deepEqual(afterRemoval.removedStepIds, [2]);
  assert.equal(afterRemoval.tasks.has(2), false);
  const patches = requests.filter((entry) => entry.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], {
    url: "/tasks/S-2",
    method: "PATCH",
    body: { status: "blocked", status_note: "Removed from the plan by a replan." },
  });
  assert.equal(withRemoval.size, 3);

  // Removed tasks that are already done are left untouched.
  requests.length = 0;
  const doneRemoval = await reconcilePlanStepTasks(
    epicA,
    new Map([[9, { key: "S-9", title: "Done step", status: "done" }]]),
    [],
    { keyPrefix: "EA-", epicId: "EPIC-A" },
    reconcileClient as never,
  );
  assert.deepEqual(doneRemoval.removedStepIds, [9]);
  assert.equal(requests.filter((entry) => entry.method === "PATCH").length, 0);

  console.log("Spec Keeper task flow fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
