import assert from "node:assert/strict";
import {
  selectMatchingEpic,
  isExactEpicMatch,
  epicIdentifier,
  epicKeywordScore,
  tasksQueryForEpic,
  syncSpecKeeperEpic,
  updateEpicWithPlan,
} from "../specKeeperFlow.js";

const epicA = { key: "EPIC-A", public_id: "11111111-1111-1111-1111-111111111111", title: "Add Edit tool with read-hash and epic-first flow", description: "Bootstrap work for edit tooling." };
const epicB = { key: "EPIC-B", public_id: "22222222-2222-2222-2222-222222222222", title: "Unrelated memory work", description: "A different epic." };

// Exact match by key/public_id wins.
assert.equal(selectMatchingEpic([epicA, epicB], "EPIC-A"), epicA);
assert.equal(selectMatchingEpic([epicA, epicB], "22222222-2222-2222-2222-222222222222"), epicB);
// Keyword overlap selects the best-matching epic.
assert.equal(selectMatchingEpic([epicA, epicB], "Add Edit tool"), epicA);
// Low overlap returns undefined so a new epic is created.
assert.equal(selectMatchingEpic([epicA, epicB], "totally unrelated keyword"), undefined);
assert.equal(isExactEpicMatch(epicA, "EPIC-A"), true);
assert.equal(isExactEpicMatch(epicA, "33333333-3333-3333-3333-333333333333"), false);
assert.equal(epicIdentifier(epicA), "EPIC-A");
assert.ok(epicKeywordScore(epicA, "Add Edit tool") >= 2);
assert.equal(tasksQueryForEpic(epicA), "epicId=EPIC-A");
assert.equal(tasksQueryForEpic({}), "");

(async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  const slug = "elastic-agent";
  const base = "https://spec.example";

  const mockClient = async (opts: { path: string; method?: string; body?: unknown }) => {
    requests.push({ url: opts.path, method: opts.method ?? "GET", body: opts.body });
    const body = opts.path.startsWith("/epics") && opts.method === "GET"
      ? [epicA]
      : opts.path.startsWith("/epics") && opts.method === "POST"
        ? [epicA]
        : opts.path.startsWith("/tasks")
          ? [{ key: "TASK-1", epic_key: "EPIC-A", title: "do the thing" }]
          : {};
    return { status: 200, statusText: "OK", headers: {}, body };
  };

  // Reuse existing epic: epics fetched first, then tasks filtered by epic.
  const reused = await syncSpecKeeperEpic({ title: "Add Edit tool", projectSlug: slug, accessToken: "tok", apiBase: base }, mockClient as never);
  assert.equal(reused.created, false);
  assert.equal(reused.epic.key, "EPIC-A");
  assert.deepEqual(reused.tasks, [{ key: "TASK-1", epic_key: "EPIC-A", title: "do the thing" }]);
  assert.ok(reused.selection.startsWith("reused epic"));
  assert.deepEqual(requests.map((r) => r.url), [
    "/epics",
    "/tasks?epicId=EPIC-A",
  ]);
  assert.deepEqual(requests.map((r) => r.method), ["GET", "GET"]);

  requests.length = 0;
  // No matching epic -> create one, then fetch its tasks.
  const created = await syncSpecKeeperEpic({ title: "Brand new epic title", projectSlug: slug, accessToken: "tok", apiBase: base }, mockClient as never);
  assert.equal(created.created, true);
  assert.equal(created.selection, `created epic "Brand new epic title"`);
  assert.deepEqual(requests.map((r) => r.url), [
    "/epics",
    "/epics",
    "/tasks?epicId=EPIC-A",
  ]);
  assert.deepEqual(requests.map((r) => r.method), ["GET", "POST", "GET"]);
  assert.deepEqual(requests[1].body, { title: "Brand new epic title", description: "Auto-created by elastic-agent for: Brand new epic title" });

  // updateEpicWithPlan sends PUT /epics/:id with the plan.
  requests.length = 0;
  const updated = await updateEpicWithPlan(epicA, "1. do\n2. done", { title: epicA.title, projectSlug: slug, accessToken: "tok", apiBase: base }, mockClient as never);
  assert.deepEqual(requests, [
    { url: "/epics/EPIC-A", method: "PUT", body: { title: epicA.title, description: epicA.description, plan: "1. do\n2. done" } },
  ]);
  assert.ok(updated);

  // Epic without an identifier cannot be updated.
  requests.length = 0;
  await updateEpicWithPlan({}, "plan", { title: "x", projectSlug: slug, accessToken: "tok", apiBase: base }, mockClient as never);
  assert.equal(requests.length, 0);

  globalThis.fetch = originalFetch;
  console.log("Spec Keeper epic-first flow fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
