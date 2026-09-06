import assert from "node:assert/strict";
import {
  attachSpecKeeperTaskProof,
  postSpecKeeperTaskNote,
  updateSpecKeeperTaskStatus,
} from "../specKeeperTaskLifecycle.js";
import { snapshotStepFeedback } from "../step-outcome.js";

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
  // Posting a note trims the content and uses the default content field.
  {
    const calls: Call[] = [];
    const result = await postSpecKeeperTaskNote(
      "TASK-1",
      "  hello  ",
      {},
      record(calls) as never,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(calls, [
      { path: "/tasks/TASK-1/notes", method: "POST", body: { content: "hello" } },
    ]);
  }

  // tasksPath and noteContentField are respected by note updates.
  {
    const calls: Call[] = [];
    await postSpecKeeperTaskNote(
      "TASK-2",
      "progress",
      { tasksPath: "/custom", noteContentField: "body" },
      record(calls) as never,
    );
    assert.deepEqual(calls, [
      { path: "/custom/TASK-2/notes", method: "POST", body: { body: "progress" } },
    ]);
  }

  // Malformed task ids and blank notes are rejected before any request.
  {
    let called = false;
    const client = async () => {
      called = true;
      return ok({});
    };
    await assert.rejects(
      () => postSpecKeeperTaskNote("bad/id", "hello", {}, client as never),
      /malformed/,
    );
    assert.equal(called, false);

    called = false;
    await assert.rejects(
      () => postSpecKeeperTaskNote("TASK-1", "   ", {}, client as never),
      /non-empty/,
    );
    assert.equal(called, false);
  }

  // Status updates PATCH the task with only the status and optional note.
  {
    const calls: Call[] = [];
    await updateSpecKeeperTaskStatus(
      "TASK-1",
      "in_progress",
      "started",
      {},
      record(calls) as never,
    );
    assert.deepEqual(calls, [
      {
        path: "/tasks/TASK-1",
        method: "PATCH",
        body: { status: "in_progress", status_note: "started" },
      },
    ]);
  }

  {
    const calls: Call[] = [];
    await updateSpecKeeperTaskStatus(
      "TASK-1",
      "done",
      undefined,
      {},
      record(calls) as never,
    );
    assert.deepEqual(calls, [
      { path: "/tasks/TASK-1", method: "PATCH", body: { status: "done" } },
    ]);
  }

  // Status updates respect a custom tasksPath and reject invalid inputs.
  {
    const calls: Call[] = [];
    await updateSpecKeeperTaskStatus(
      "TASK-3",
      "blocked",
      undefined,
      { tasksPath: "/custom" },
      record(calls) as never,
    );
    assert.deepEqual(calls, [
      { path: "/custom/TASK-3", method: "PATCH", body: { status: "blocked" } },
    ]);

    let called = false;
    const client = async () => {
      called = true;
      return ok({});
    };
    await assert.rejects(
      () => updateSpecKeeperTaskStatus("bad/id", "done", undefined, {}, client as never),
      /malformed/,
    );
    assert.equal(called, false);

    await assert.rejects(
      () => updateSpecKeeperTaskStatus("TASK-1", "   ", undefined, {}, client as never),
      /non-empty/,
    );
    assert.equal(called, false);
  }

  // Proofs attach through the configured proof field.
  {
    const calls: Call[] = [];
    const result = await attachSpecKeeperTaskProof(
      "TASK-1",
      { commit: "abc123" },
      {},
      record(calls) as never,
    );
    assert.equal(result.attached, true);
    assert.equal(result.method, "field");
    assert.equal(result.path, "/tasks/TASK-1");
    assert.match(result.detail ?? "", /proof/);
    assert.deepEqual(calls, [
      {
        path: "/tasks/TASK-1",
        method: "PATCH",
        body: { proof: { commit: "abc123" } },
      },
    ]);
  }

  // proofField and tasksPath are respected when attaching a proof.
  {
    const calls: Call[] = [];
    const result = await attachSpecKeeperTaskProof(
      "TASK-1",
      "abc123",
      { proofField: "evidence", tasksPath: "/custom" },
      record(calls) as never,
    );
    assert.equal(result.method, "field");
    assert.equal(result.path, "/custom/TASK-1");
    assert.deepEqual(calls, [
      { path: "/custom/TASK-1", method: "PATCH", body: { evidence: "abc123" } },
    ]);
  }

  // When the proof field update fails, the proof falls back to a task note.
  {
    const calls: Call[] = [];
    const client = async (opts: { path: string; method?: string; body?: unknown }) => {
      calls.push({ path: opts.path, method: opts.method, body: opts.body });
      if (opts.method === "PATCH") {
        throw new Error(
          "Spec Keeper request PATCH /tasks/TASK-1 failed (400 Bad Request); diagnostics: {}",
        );
      }
      return ok({ id: "note-1" }, 201);
    };
    const result = await attachSpecKeeperTaskProof("TASK-1", "abc123", {}, client as never);
    assert.equal(result.attached, true);
    assert.equal(result.method, "note");
    assert.equal(result.path, "/tasks/TASK-1/notes");
    assert.match(result.detail ?? "", /400 Bad Request/);
    assert.deepEqual(calls, [
      { path: "/tasks/TASK-1", method: "PATCH", body: { proof: "abc123" } },
      {
        path: "/tasks/TASK-1/notes",
        method: "POST",
        body: { content: "Proof: abc123" },
      },
    ]);
  }

  // Object proofs are JSON-stringified when they fall back to a note.
  {
    const calls: Call[] = [];
    const client = async (opts: { path: string; method?: string; body?: unknown }) => {
      calls.push({ path: opts.path, method: opts.method, body: opts.body });
      if (opts.method === "PATCH") throw new Error("field unsupported");
      return ok({ id: "note-2" }, 201);
    };
    const result = await attachSpecKeeperTaskProof(
      "TASK-1",
      { commit: "abc" },
      {},
      client as never,
    );
    assert.equal(result.method, "note");
    assert.deepEqual(calls[1], {
      path: "/tasks/TASK-1/notes",
      method: "POST",
      body: { content: 'Proof: {"commit":"abc"}' },
    });
  }

  // When both the field and note updates fail, the result is unattached with a
  // combined diagnostic.
  {
    let patchAttempts = 0;
    let noteAttempts = 0;
    const client = async (opts: { path: string; method?: string; body?: unknown }) => {
      if (opts.method === "PATCH") patchAttempts += 1;
      if (opts.method === "POST") noteAttempts += 1;
      throw new Error("network down");
    };
    const result = await attachSpecKeeperTaskProof("TASK-1", "abc123", {}, client as never);
    assert.equal(result.attached, false);
    assert.equal(result.method, "none");
    assert.match(result.error ?? "", /proof field update failed/);
    assert.match(result.error ?? "", /proof note failed/);
    assert.equal(patchAttempts, 1);
    assert.equal(noteAttempts, 1);
  }

  // Empty and invalid proofs never reach the client.
  {
    let called = false;
    const client = async () => {
      called = true;
      return ok({});
    };

    for (const proof of ["", "   "]) {
      called = false;
      const result = await attachSpecKeeperTaskProof("TASK-1", proof, {}, client as never);
      assert.equal(result.attached, false);
      assert.equal(result.method, "none");
      assert.equal(called, false);
    }

    called = false;
    const emptyObject = await attachSpecKeeperTaskProof("TASK-1", {}, {}, client as never);
    assert.equal(emptyObject.attached, false);
    assert.equal(emptyObject.method, "none");
    assert.equal(called, false);

    const malformed = await attachSpecKeeperTaskProof("bad/id", "abc", {}, client as never);
    assert.equal(malformed.attached, false);
    assert.equal(malformed.method, "none");
    assert.match(malformed.error ?? "", /malformed/);
  }

  // PI-01 behavioral coverage: the normalized step-outcome reducer's Spec
  // Keeper statuses are all accepted by the real lifecycle PATCH, and only a
  // succeeded outcome emits `done`. invalid JSON / failed checks / blocked
  // tools never become `done`; successful checks and successful non-code
  // deliverables both become `done`.
  {
    const scenarios = [
      {
        name: "invalid JSON",
        feedbackEntry: { valid: false, response_id: "resp-invalid-json", validationError: "Feedback JSON could not be parsed" },
        expectedStatus: "failed",
      },
      {
        name: "failed checks",
        feedbackEntry: { valid: true, response_id: "resp-failed-checks", feedback: { stepStatus: "failed", summary: "checks failed", findings: ["lint failed"] } },
        expectedStatus: "failed",
      },
      {
        name: "blocked tools",
        feedbackEntry: { valid: true, response_id: "resp-blocked-tool", feedback: { stepStatus: "blocked", summary: "tool unavailable", findings: [] } },
        expectedStatus: "blocked",
      },
      {
        name: "successful checks",
        feedbackEntry: { valid: true, response_id: "resp-success-checks", feedback: { stepStatus: "completed", summary: "checks passed", findings: ["lint ok", "test ok"] } },
        expectedStatus: "done",
      },
      {
        name: "successful non-code deliverables",
        feedbackEntry: { valid: true, response_id: "resp-success-report", feedback: { stepStatus: "completed", summary: "wrote report", findings: ["deliverable: docs/REPORT.md created"] } },
        expectedStatus: "done",
      },
    ];

    for (const scenario of scenarios) {
      const snapshot = snapshotStepFeedback({
        feedbackEntry: scenario.feedbackEntry,
        step: 1,
        stepText: "Executed step",
      });
      assert.equal(
        snapshot.reduced.specKeeperStatus,
        scenario.expectedStatus,
        `${scenario.name}: reducer status must be ${scenario.expectedStatus}`,
      );
      // A non-success outcome must never reach the external done status.
      if (scenario.expectedStatus !== "done") {
        assert.notEqual(snapshot.reduced.specKeeperStatus, "done", `${scenario.name}: must not emit done`);
      }

      const calls: Call[] = [];
      await updateSpecKeeperTaskStatus(
        "TASK-PI01",
        snapshot.reduced.specKeeperStatus,
        snapshot.reduced.specKeeperNote,
        {},
        record(calls) as never,
      );
      assert.deepEqual(calls, [
        {
          path: "/tasks/TASK-PI01",
          method: "PATCH",
          body: { status: scenario.expectedStatus, status_note: snapshot.reduced.specKeeperNote },
        },
      ]);
    }
  }

  console.log("Spec Keeper task lifecycle fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
