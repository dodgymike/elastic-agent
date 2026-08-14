import assert from "node:assert/strict";
import {
  syncSpecKeeperTask,
  updateSpecKeeperTask,
  updateTaskStatus,
  updateEpicStatus,
  syncPlanStepTasks,
  taskIdentifier,
  generateTaskKey,
  selectMatchingTask,
} from "../specKeeperFlow.js";

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

  console.log("Spec Keeper task flow fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
