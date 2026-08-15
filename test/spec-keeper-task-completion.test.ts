import assert from "node:assert/strict";
import {
  completeSpecKeeperTask,
  failSpecKeeperTask,
} from "../specKeeperTaskCompletion.js";

type Call = { path: string; method?: string; body?: unknown };

const ok = (body: unknown, status = 200) => ({
  status,
  statusText: status === 201 ? "Created" : "OK",
  headers: {},
  body,
});

const record = (calls: Call[]) =>
  async (opts: { path: string; method?: string; body?: unknown }) => {
    calls.push({ path: opts.path, method: opts.method, body: opts.body });
    return ok({});
  };

(async () => {
  // Completion performs status, note, and proof updates in that order.
  {
    const calls: Call[] = [];
    const result = await completeSpecKeeperTask(
      "TASK-1",
      { commit: "abc123", tests: "passed" },
      {},
      record(calls) as never,
    );
    assert.equal(result.taskId, "TASK-1");
    assert.equal(result.status, "done");
    assert.equal(result.statusUpdated, true);
    assert.equal(result.noteRecorded, true);
    assert.equal(result.proofAttached, true);
    assert.equal(result.proofMethod, "field");
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(calls, [
      {
        path: "/tasks/TASK-1",
        method: "PATCH",
        body: { status: "done", status_note: "Task completed." },
      },
      {
        path: "/tasks/TASK-1/notes",
        method: "POST",
        body: { content: "Task completed." },
      },
      {
        path: "/tasks/TASK-1",
        method: "PATCH",
        body: { proof: { commit: "abc123", tests: "passed" } },
      },
    ]);
  }

  // Failure defaults to blocked and embeds the diagnostic in every update.
  {
    const calls: Call[] = [];
    const result = await failSpecKeeperTask(
      "TASK-1",
      "execution crashed",
      {},
      record(calls) as never,
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.statusUpdated, true);
    assert.equal(result.noteRecorded, true);
    assert.equal(result.proofAttached, true);
    assert.equal(result.proofMethod, "field");
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(calls, [
      {
        path: "/tasks/TASK-1",
        method: "PATCH",
        body: { status: "blocked", status_note: "Task blocked: execution crashed" },
      },
      {
        path: "/tasks/TASK-1/notes",
        method: "POST",
        body: { content: "Task blocked: execution crashed" },
      },
      {
        path: "/tasks/TASK-1",
        method: "PATCH",
        body: {
          proof: { outcome: "blocked", diagnostic: "execution crashed" },
        },
      },
    ]);
  }

  // failureStatus failed changes the terminal status and proof outcome.
  {
    const calls: Call[] = [];
    const result = await failSpecKeeperTask(
      "TASK-1",
      "oops",
      { failureStatus: "failed" },
      record(calls) as never,
    );
    assert.equal(result.status, "failed");
    assert.deepEqual((calls[0].body as { status: string; status_note: string }).status, "failed");
    assert.deepEqual(
      (calls[0].body as { status: string; status_note: string }).status_note,
      "Task failed: oops",
    );
    assert.deepEqual((calls[2].body as { proof: unknown }).proof, {
      outcome: "failed",
      diagnostic: "oops",
    });
  }

  // Diagnostics are bounded before they are embedded in updates.
  {
    const calls: Call[] = [];
    await failSpecKeeperTask(
      "TASK-1",
      "x".repeat(100),
      { maxDiagnosticLength: 10 },
      record(calls) as never,
    );
    const bounded = "x".repeat(9) + "…";
    assert.deepEqual(
      (calls[0].body as { status: string; status_note: string }).status_note,
      `Task blocked: ${bounded}`,
    );
    assert.deepEqual(
      (calls[2].body as { proof: { outcome: string; diagnostic: string } }).proof.diagnostic,
      bounded,
    );
  }

  // Blank diagnostics degrade to a stable placeholder.
  {
    const calls: Call[] = [];
    await failSpecKeeperTask("TASK-1", "   ", {}, record(calls) as never);
    assert.deepEqual(
      (calls[0].body as { status: string; status_note: string }).status_note,
      "Task blocked: no diagnostic provided",
    );
    assert.deepEqual(
      (calls[2].body as { proof: { outcome: string; diagnostic: string } }).proof.diagnostic,
      "no diagnostic provided",
    );
  }

  // Every update failing is non-fatal and returns bounded diagnostics.
  {
    const calls: Call[] = [];
    const client = async (opts: { path: string; method?: string; body?: unknown }) => {
      calls.push({ path: opts.path, method: opts.method, body: opts.body });
      throw new Error(
        `Spec Keeper request ${opts.method ?? "GET"} ${opts.path} failed (500 Internal Server Error); diagnostics: {}`,
      );
    };
    const result = await completeSpecKeeperTask(
      "TASK-1",
      { commit: "abc" },
      {},
      client as never,
    );
    assert.equal(result.statusUpdated, false);
    assert.equal(result.noteRecorded, false);
    assert.equal(result.proofAttached, false);
    assert.equal(result.proofMethod, "none");
    assert.equal(calls.length, 4);
    assert.ok(result.diagnostics.length >= 3);
    assert.match(result.diagnostics.join("\n"), /500 Internal Server Error/);
    assert.match(result.diagnostics.join("\n"), /proof not attached/);
  }

  // A failed status update does not prevent note and proof updates.
  {
    const calls: Call[] = [];
    let patchAttempts = 0;
    const client = async (opts: { path: string; method?: string; body?: unknown }) => {
      calls.push({ path: opts.path, method: opts.method, body: opts.body });
      if (opts.method === "PATCH") {
        patchAttempts += 1;
        if (patchAttempts === 1) {
          throw new Error(
            "Spec Keeper request PATCH /tasks/TASK-1 failed (400 Bad Request); diagnostics: {}",
          );
        }
      }
      return ok({});
    };
    const result = await completeSpecKeeperTask(
      "TASK-1",
      { commit: "abc" },
      {},
      client as never,
    );
    assert.equal(result.statusUpdated, false);
    assert.equal(result.noteRecorded, true);
    assert.equal(result.proofAttached, true);
    assert.equal(result.proofMethod, "field");
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0], /400 Bad Request/);
  }

  // A failed proof field update falls back to a proof note in completion.
  {
    const calls: Call[] = [];
    const client = async (opts: { path: string; method?: string; body?: unknown }) => {
      calls.push({ path: opts.path, method: opts.method, body: opts.body });
      if (opts.method === "PATCH" && (opts.body as { proof?: unknown } | undefined)?.proof) {
        throw new Error(
          "Spec Keeper request PATCH /tasks/TASK-1 failed (400 Bad Request); diagnostics: {}",
        );
      }
      return ok({});
    };
    const result = await completeSpecKeeperTask(
      "TASK-1",
      "abc123",
      {},
      client as never,
    );
    assert.equal(result.statusUpdated, true);
    assert.equal(result.noteRecorded, true);
    assert.equal(result.proofAttached, true);
    assert.equal(result.proofMethod, "note");
    assert.equal(calls.length, 4);
    assert.equal(calls[3].method, "POST");
    assert.equal(calls[3].path, "/tasks/TASK-1/notes");
    assert.deepEqual(calls[3].body, { content: "Proof: abc123" });
  }

  console.log("Spec Keeper task completion fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
