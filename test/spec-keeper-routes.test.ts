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
import specKeeper, {
  formatSpecKeeperFailureDiagnostic,
  resolveSpecKeeperPath,
} from "../tools/SpecKeeper.ts";

const slug = "elastic-agent";
assert.equal(resolveSpecKeeperPath("/tasks?status=todo", slug), "/api/v1/projects/elastic-agent/tasks?status=todo");
assert.equal(resolveSpecKeeperPath("/tasks/WORK-1/status", slug), "/api/v1/projects/elastic-agent/tasks/WORK-1/status");
assert.equal(resolveSpecKeeperPath("/tasks/WORK-1/chain-runs", slug), "/api/v1/projects/elastic-agent/tasks/WORK-1/chain-runs");
assert.equal(resolveSpecKeeperPath("/api/v1/projects", slug), "/api/v1/projects");
assert.throws(() => resolveSpecKeeperPath("/task-queue", slug), /Unsupported Spec Keeper project resource/);
assert.throws(() => resolveSpecKeeperPath("/tasks"), /projectSlug is required/);

// Failure diagnostics redact secret-shaped keys and embedded credentials so a
// Spec Keeper error can never leak a token or password into logs.
const jsonDiagnostic = formatSpecKeeperFailureDiagnostic(
  JSON.stringify({ accessToken: "top-secret-token", message: "denied" }),
);
assert.ok(jsonDiagnostic, "expected a diagnostic for a non-empty error body");
assert.ok(jsonDiagnostic.includes("[REDACTED]"));
assert.ok(!jsonDiagnostic.includes("top-secret-token"));

const plainDiagnostic = formatSpecKeeperFailureDiagnostic(
  "HTTP 401 access_token=plain-secret-token",
);
assert.ok(plainDiagnostic, "expected a diagnostic for a non-empty error body");
assert.ok(plainDiagnostic.includes("[REDACTED]"));
assert.ok(!plainDiagnostic.includes("plain-secret-token"));

function makeWorkspaceFixture(prefix: string): {
  workspace: string;
  canonicalWorkspace: string;
  credentialFile: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
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
  return { workspace, canonicalWorkspace, credentialFile };
}

(async () => {
  // Scenario 1: project-scoped route fixtures resolve through the workspace
  // mapping, including the case where explicit projectSlug/apiBase are omitted.
  {
    const { workspace } = makeWorkspaceFixture("spec-keeper-routes-");
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
  }

  // Scenario 2: a failing request redacts secret-shaped keys from the error
  // diagnostics so the access token never enters an Error message.
  {
    const { workspace } = makeWorkspaceFixture("spec-keeper-routes-error-");
    const originalFetch = globalThis.fetch;
    const previousCwd = process.cwd();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ accessToken: "leaked-access-token", message: "denied" }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      )) as typeof fetch;
    try {
      process.chdir(workspace);
      await assert.rejects(
        () =>
          specKeeper({
            path: "/tasks",
            projectSlug: slug,
            accessToken: "leaked-access-token",
            apiBase: "https://spec.example/",
          }),
        (error: Error) => {
          assert.ok(error.message.includes("[REDACTED]"));
          assert.ok(!error.message.includes("leaked-access-token"));
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.chdir(previousCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  console.log("Spec Keeper route and failure-diagnostic fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
