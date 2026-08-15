import assert from "node:assert/strict";
import {
  claimSpecKeeperTask,
  addSpecKeeperTaskNote,
  taskClaimState,
  describeClaimedSpecKeeperTask,
  SpecKeeperTaskClaimError,
  DEFAULT_TASK_CLAIM_STATUS,
} from "../specKeeperTaskClaim.js";
import { TaskWorkOrder } from "../specKeeperTaskFetch.js";

const ok = (body: unknown, status = 200) => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: {},
  body,
});

const makeWorkOrder = (overrides: Partial<TaskWorkOrder> = {}): TaskWorkOrder => ({
  id: "TASK-1",
  title: "Add task mode",
  description: "Wire task mode into the CLI",
  acceptanceCriteria: ["Fetch tasks by id", "Claim fetched tasks"],
  status: "todo",
  epic: { key: "EPIC-A" },
  raw: { key: "TASK-1", title: "Add task mode", status: "todo" },
  ...overrides,
});

const record = (calls: Array<{ path: string; method?: string; body?: unknown }>) =>
  async (opts: { path: string; method?: string; body?: unknown }) => {
    calls.push({ path: opts.path, method: opts.method, body: opts.body });
    return ok({});
  };

(async () => {
  assert.equal(DEFAULT_TASK_CLAIM_STATUS, "in_progress");

  // Claimability classification is explicit and status aliases are handled.
  assert.equal(taskClaimState("todo"), "claimable");
  assert.equal(taskClaimState("open"), "claimable");
  assert.equal(taskClaimState("In Progress"), "already-claimed");
  assert.equal(taskClaimState("under_review"), "already-claimed");
  assert.equal(taskClaimState("done"), "not-claimable");
  assert.equal(taskClaimState("blocked"), "not-claimable");
  assert.equal(taskClaimState("mystery"), "claimability-unknown");

  // A claimable task is PATCHed into the claimed state and the claim result is
  // recorded as a note on the task.
  {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const client = async (opts: { path: string; method?: string; body?: unknown }) => {
      calls.push({ path: opts.path, method: opts.method, body: opts.body });
      if (opts.path.endsWith("/notes")) return ok({ id: "note-1" }, 201);
      return ok({ key: "TASK-1", title: "Add task mode", status: "in_progress" });
    };

    const result = await claimSpecKeeperTask(makeWorkOrder(), {}, client as never);
    assert.deepEqual(calls, [
      {
        path: "/tasks/TASK-1",
        method: "PATCH",
        body: {
          status: "in_progress",
          status_note:
            "Claimed task 'TASK-1' by elastic-agent task mode (todo -> in_progress).",
        },
      },
      {
        path: "/tasks/TASK-1/notes",
        method: "POST",
        body: {
          content:
            "Claimed task 'TASK-1' by elastic-agent task mode (todo -> in_progress).",
        },
      },
    ]);
    assert.equal(result.id, "TASK-1");
    assert.equal(result.status, "in_progress");
    assert.equal(result.forced, false);
    assert.equal(result.note.recorded, true);
    assert.equal(result.note.path, "/tasks/TASK-1/notes");
    assert.equal(result.task.status, "in_progress");
  }

  // claimStatus, claimNote, tasksPath, and noteContentField are respected.
  {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const client = record(calls);
    const result = await claimSpecKeeperTask(
      makeWorkOrder(),
      {
        tasksPath: "/tasks",
        claimStatus: "claimed",
        claimNote: "Taking over task execution",
        noteContentField: "body",
      },
      client as never,
    );
    assert.deepEqual(calls, [
      {
        path: "/tasks/TASK-1",
        method: "PATCH",
        body: { status: "claimed", status_note: "Taking over task execution" },
      },
      {
        path: "/tasks/TASK-1/notes",
        method: "POST",
        body: { body: "Taking over task execution" },
      },
    ]);
    assert.equal(result.status, "claimed");
    assert.equal(result.forced, false);
  }

  // Already-claimed tasks fail closed before any request is sent.
  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder({ status: "in_progress" }),
        {},
        (async () => {
          throw new Error("client should not be called");
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "already-claimed" &&
      error.taskId === "TASK-1" &&
      /already claimed/i.test(error.message),
  );

  // Not-claimable terminal/blocked states fail closed before any request.
  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder({ status: "done" }),
        {},
        (async () => {
          throw new Error("client should not be called");
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "not-claimable" &&
      /not claimable/i.test(error.message),
  );

  // Unrecognized statuses also fail closed rather than guessing.
  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder({ status: "mystery" }),
        {},
        (async () => {
          throw new Error("client should not be called");
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "claimability-unknown" &&
      /unrecognized status/i.test(error.message),
  );

  // forceClaim is the safe explicit override: it skips only the local
  // precheck and still records the claim result.
  {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const client = record(calls);
    const result = await claimSpecKeeperTask(
      makeWorkOrder({ status: "in_progress" }),
      { forceClaim: true },
      client as never,
    );
    assert.equal(result.forced, true);
    assert.equal(result.status, "in_progress");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls[1].method, "POST");
    assert.ok(calls[1].path.endsWith("/notes"));
  }

  // Server-side 409 conflicts are authoritative and fail closed.
  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder(),
        {},
        (async () => {
          throw new Error(
            "Spec Keeper request PATCH /api/v1/projects/elastic-agent/tasks/TASK-1 failed (409 Conflict); diagnostics: {}",
          );
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "conflict" &&
      /already claimed or in a conflicting state/i.test(error.message),
  );

  // Server-side 423 locked responses are classified as not claimable.
  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder(),
        {},
        (async () => {
          throw new Error(
            "Spec Keeper request PATCH /api/v1/projects/elastic-agent/tasks/TASK-1 failed (423 Locked); diagnostics: {}",
          );
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "not-claimable" &&
      /locked and not claimable/i.test(error.message),
  );

  // Not-found and permission failures are classified with actionable messages.
  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder(),
        {},
        (async () => {
          throw new Error(
            "Spec Keeper request PATCH /api/v1/projects/elastic-agent/tasks/TASK-1 failed (404 Not Found); diagnostics: {}",
          );
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "not-found" &&
      /was not found/i.test(error.message),
  );

  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder(),
        {},
        (async () => {
          throw new Error(
            "Spec Keeper request PATCH /api/v1/projects/elastic-agent/tasks/TASK-1 failed (403 Forbidden); diagnostics: {}",
          );
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "permission" &&
      /denied the claim/i.test(error.message),
  );

  // Network and configuration failures stay distinct from API conflicts.
  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder(),
        {},
        (async () => {
          throw new Error(
            "Spec Keeper request PATCH /api/v1/projects/elastic-agent/tasks/TASK-1 could not be sent.",
          );
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "network" &&
      /could not be reached/i.test(error.message),
  );

  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder(),
        {},
        (async () => {
          throw new Error("Spec Keeper projectSlug must be a URL-safe project slug.");
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "configuration" &&
      /not configured correctly/i.test(error.message),
  );

  // A failed note is non-fatal because the claim transition already happened;
  // the result carries a visible diagnostic for the caller to surface.
  {
    const client = async (opts: { path: string; method?: string; body?: unknown }) => {
      if (opts.method === "PATCH") return ok({ key: "TASK-1", status: "in_progress" });
      throw new Error(
        "Spec Keeper request POST /api/v1/projects/elastic-agent/tasks/TASK-1/notes failed (500 Internal Server Error); diagnostics: {}",
      );
    };
    const result = await claimSpecKeeperTask(makeWorkOrder(), {}, client as never);
    assert.equal(result.status, "in_progress");
    assert.equal(result.note.recorded, false);
    assert.equal(result.note.path, "/tasks/TASK-1/notes");
    assert.match(result.note.error ?? "", /failed \(500/);
  }

  // addSpecKeeperTaskNote posts a single note with the configured field.
  {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const client = record(calls);
    await addSpecKeeperTaskNote("TASK-1", "hello", {}, client as never);
    assert.deepEqual(calls, [
      { path: "/tasks/TASK-1/notes", method: "POST", body: { content: "hello" } },
    ]);
  }

  // Missing and malformed work-order ids are usage errors.
  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder({ id: "" }),
        {},
        (async () => {
          throw new Error("client should not be called");
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "usage" &&
      /without a task id/i.test(error.message),
  );

  await assert.rejects(
    () =>
      claimSpecKeeperTask(
        makeWorkOrder({ id: "bad/id" }),
        {},
        (async () => {
          throw new Error("client should not be called");
        }) as never,
      ),
    (error: unknown) =>
      error instanceof SpecKeeperTaskClaimError &&
      error.kind === "usage" &&
      /malformed/i.test(error.message),
  );

  // describeClaimedSpecKeeperTask stays secret-safe and concise.
  assert.equal(
    describeClaimedSpecKeeperTask({
      id: "TASK-1",
      status: "in_progress",
      forced: false,
      task: { key: "TASK-1", status: "in_progress" },
      note: { recorded: true, path: "/tasks/TASK-1/notes" },
    }),
    "task TASK-1 claimed (status=in_progress, claim note recorded).",
  );
  assert.match(
    describeClaimedSpecKeeperTask({
      id: "TASK-1",
      status: "in_progress",
      forced: true,
      task: { key: "TASK-1", status: "in_progress" },
      note: { recorded: false, path: "/tasks/TASK-1/notes", error: "failed (500)" },
    }),
    /forced/,
  );

  console.log("Spec Keeper task claim fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
