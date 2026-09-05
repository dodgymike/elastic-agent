import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import specKeeper, { resolveSpecKeeperPath } from "../tools/SpecKeeper.ts";

const slug = "elastic-agent";
assert.equal(resolveSpecKeeperPath("/tasks?status=todo", slug), "/api/v1/projects/elastic-agent/tasks?status=todo");
assert.equal(resolveSpecKeeperPath("/tasks/WORK-1/status", slug), "/api/v1/projects/elastic-agent/tasks/WORK-1/status");
assert.equal(resolveSpecKeeperPath("/tasks/WORK-1/chain-runs", slug), "/api/v1/projects/elastic-agent/tasks/WORK-1/chain-runs");
assert.equal(resolveSpecKeeperPath("/api/v1/projects", slug), "/api/v1/projects");
assert.throws(() => resolveSpecKeeperPath("/task-queue", slug), /Unsupported Spec Keeper project resource/);
assert.throws(() => resolveSpecKeeperPath("/tasks"), /projectSlug is required/);

(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "spec-keeper-routes-"));
  const specDir = join(workspace, ".spec-keeper");
  mkdirSync(specDir);
  const canonicalWorkspace = realpathSync(workspace);
  const credentialFile = join(specDir, `${slug}.json`);
  writeFileSync(
    join(specDir, "config"),
    JSON.stringify({
      [canonicalWorkspace]: {
        projectSlug: slug,
        credentialFile,
        apiBase: "https://spec.example/",
      },
    }),
  );
  writeFileSync(credentialFile, "{}", { mode: 0o600 });
  chmodSync(credentialFile, 0o600);

  const requests: Array<{ url: string; method?: string }> = [];
  const originalFetch = globalThis.fetch;
  const previousCwd = process.cwd();
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    process.chdir(workspace);
    await specKeeper({ path: "/tasks", projectSlug: slug, accessToken: "test-token", apiBase: "https://spec.example/" });
    await specKeeper({ path: "/tasks/WORK-1/chain-runs", projectSlug: slug, accessToken: "test-token", apiBase: "https://spec.example" });
    // Without explicit projectSlug/apiBase the `.spec-keeper/config` mapping wins.
    await specKeeper({ path: "/tasks", accessToken: "test-token" });
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(previousCwd);
    rmSync(workspace, { recursive: true, force: true });
  }
  assert.deepEqual(requests, [
    { url: "https://spec.example/api/v1/projects/elastic-agent/tasks", method: "GET" },
    { url: "https://spec.example/api/v1/projects/elastic-agent/tasks/WORK-1/chain-runs", method: "GET" },
    { url: "https://spec.example/api/v1/projects/elastic-agent/tasks", method: "GET" },
  ]);
  console.log("Spec Keeper project-scoped route fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
