import assert from "node:assert/strict";
import {
  fetchSpecKeeperTask,
  describeTaskWorkOrder,
  SpecKeeperTaskFetchError,
} from "../specKeeperTaskFetch.js";

const ok = (body: unknown) => ({ status: 200, statusText: "OK", headers: {}, body });

(async () => {
  // A direct task object is normalized into a work order via GET /tasks/:id.
  {
    const calls: Array<{ path: string; method?: string }> = [];
    const client = async (opts: { path: string; method?: string }) => {
      calls.push({ path: opts.path, method: opts.method });
      return ok({
        key: "TASK-1",
        title: "Add task mode",
        description: "Wire task mode into the CLI",
        status: "todo",
        acceptance_criteria: ["Fetch tasks by id", "Normalize work orders"],
        epic: { key: "EPIC-A", title: "Task mode epic", description: "Epic description" },
      });
    };

    const workOrder = await fetchSpecKeeperTask("TASK-1", {}, client as never);
    assert.deepEqual(calls, [{ path: "/tasks/TASK-1", method: "GET" }]);
    assert.equal(workOrder.id, "TASK-1");
    assert.equal(workOrder.title, "Add task mode");
    assert.equal(workOrder.description, "Wire task mode into the CLI");
    assert.equal(workOrder.status, "todo");
    assert.deepEqual(workOrder.acceptanceCriteria, ["Fetch tasks by id", "Normalize work orders"]);
    assert.equal(workOrder.epic?.key, "EPIC-A");
    assert.equal(workOrder.epic?.title, "Task mode epic");
    assert.equal(workOrder.epic?.description, "Epic description");
    assert.equal(workOrder.epic?.publicId, undefined);
    assert.equal(workOrder.raw.key, "TASK-1");
  }

  // A wrapped { task: ... } body and stringified acceptance criteria normalize too.
  {
    const workOrder = await fetchSpecKeeperTask(
      "11111111-1111-1111-1111-111111111111",
      {},
      (async () =>
        ok({
          task: {
            public_id: "11111111-1111-1111-1111-111111111111",
            title: "Wrapped task",
            status: "in_progress",
            acceptanceCriteria: "First criterion\nSecond criterion",
          },
        })) as never,
    );
    assert.equal(workOrder.id, "11111111-1111-1111-1111-111111111111");
    assert.equal(workOrder.title, "Wrapped task");
    assert.equal(workOrder.status, "in_progress");
    assert.deepEqual(workOrder.acceptanceCriteria, ["First criterion", "Second criterion"]);
    assert.equal(workOrder.epic, null);
  }

  // An array response is accepted when it contains the requested task id.
  {
    const workOrder = await fetchSpecKeeperTask(
      "TASK-9",
      {},
      (async () =>
        ok([
          { key: "TASK-8", title: "other" },
          { key: "TASK-9", title: "requested task", status: "done" },
        ])) as never,
    );
    assert.equal(workOrder.id, "TASK-9");
    assert.equal(workOrder.title, "requested task");
    assert.equal(workOrder.status, "done");
  }

  // Not-found responses are classified with an actionable diagnostic.
  await assert.rejects(
    () =>
      fetchSpecKeeperTask(
        "MISSING",
        {},
        (async () => {
          throw new Error(
            "Spec Keeper request GET /api/v1/projects/elastic-agent/tasks/MISSING failed (404 Not Found); diagnostics: {}",
          );
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskFetchError &&
      error.kind === "not-found" &&
      error.taskId === "MISSING" &&
      /not found/i.test(error.message),
  );

  // Permission failures (401/403) are classified separately.
  await assert.rejects(
    () =>
      fetchSpecKeeperTask(
        "FORBIDDEN",
        {},
        (async () => {
          throw new Error(
            "Spec Keeper request GET /api/v1/projects/elastic-agent/tasks/FORBIDDEN failed (403 Forbidden); diagnostics: {}",
          );
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskFetchError &&
      error.kind === "permission" &&
      error.taskId === "FORBIDDEN" &&
      /denied access/i.test(error.message),
  );

  // Configuration failures are classified with an actionable diagnostic.
  await assert.rejects(
    () =>
      fetchSpecKeeperTask(
        "TASK-1",
        {},
        (async () => {
          throw new Error("Spec Keeper projectSlug must be a URL-safe project slug.");
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskFetchError &&
      error.kind === "configuration" &&
      /not configured correctly/i.test(error.message),
  );

  // Network failures are classified separately from API errors.
  await assert.rejects(
    () =>
      fetchSpecKeeperTask(
        "TASK-1",
        {},
        (async () => {
          throw new Error(
            "Spec Keeper request GET /api/v1/projects/elastic-agent/tasks/TASK-1 could not be sent.",
          );
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskFetchError &&
      error.kind === "network" &&
      /could not be reached/i.test(error.message),
  );

  // A malformed task id is rejected as a usage error before any request.
  await assert.rejects(
    () =>
      fetchSpecKeeperTask(
        "bad/id",
        {},
        (async () => {
          throw new Error("client should not be called for malformed ids");
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskFetchError &&
      error.kind === "usage" &&
      error.taskId === "bad/id",
  );

  // A successful-looking response without a task-shaped body is a protocol error.
  await assert.rejects(
    () => fetchSpecKeeperTask("TASK-1", {}, (async () => ok({})) as never),
    (error: unknown) =>
      error instanceof SpecKeeperTaskFetchError &&
      error.kind === "protocol" &&
      /unrecognizable task payload/i.test(error.message),
  );

  // describeTaskWorkOrder stays secret-safe and concise.
  const summary = describeTaskWorkOrder({
    id: "TASK-1",
    title: "Add task mode",
    description: "desc",
    acceptanceCriteria: ["one"],
    status: "todo",
    epic: { key: "EPIC-A" },
    raw: {},
  });
  assert.equal(
    summary,
    'task TASK-1 fetched: "Add task mode" (status=todo, one, epic=EPIC-A).',
  );

  console.log("Spec Keeper task fetch fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
