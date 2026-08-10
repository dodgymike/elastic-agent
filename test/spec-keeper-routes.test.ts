import assert from "node:assert/strict";
import specKeeper, { resolveSpecKeeperPath } from "../tools/SpecKeeper.ts";

const slug = "elastic-agent";
assert.equal(resolveSpecKeeperPath("/tasks?status=todo", slug), "/api/v1/projects/elastic-agent/tasks?status=todo");
assert.equal(resolveSpecKeeperPath("/tasks/WORK-1/status", slug), "/api/v1/projects/elastic-agent/tasks/WORK-1/status");
assert.equal(resolveSpecKeeperPath("/tasks/WORK-1/chain-runs", slug), "/api/v1/projects/elastic-agent/tasks/WORK-1/chain-runs");
assert.equal(resolveSpecKeeperPath("/api/v1/projects", slug), "/api/v1/projects");
assert.throws(() => resolveSpecKeeperPath("/task-queue", slug), /Unsupported Spec Keeper project resource/);
assert.throws(() => resolveSpecKeeperPath("/tasks"), /projectSlug is required/);

(async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await specKeeper({ path: "/tasks", projectSlug: slug, accessToken: "test-token", apiBase: "https://spec.example/" });
    await specKeeper({ path: "/tasks/WORK-1/chain-runs", projectSlug: slug, accessToken: "test-token", apiBase: "https://spec.example" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests, [
    { url: "https://spec.example/api/v1/projects/elastic-agent/tasks", method: "GET" },
    { url: "https://spec.example/api/v1/projects/elastic-agent/tasks/WORK-1/chain-runs", method: "GET" },
  ]);
  console.log("Spec Keeper project-scoped route fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
