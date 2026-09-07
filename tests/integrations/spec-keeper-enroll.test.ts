import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import specKeeperEnroll from "../../src/tools/SpecKeeperEnroll.ts";

const originalFetch = globalThis.fetch;
const root = mkdtempSync(join(tmpdir(), "spec-keeper-enroll-"));

interface FetchCall {
  url: string;
  method?: string;
  body?: string;
}

function makeWorkspace(name: string): string {
  const workspace = join(root, name);
  mkdirSync(workspace);
  return workspace;
}

function stubFetch(respond: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return respond();
  }) as typeof fetch;
  return calls;
}

function enrollResponse(recipe: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(recipe), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function withCwd<T>(dir: string, run: () => Promise<T> | T): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

const VALID_RECIPE = {
  username: "agent-user",
  password: "agent-password",
  api_base: "https://enroll.example/",
  project_slug: "enrolled-project",
  role: "agent",
  region: "us-east-1",
  client_id: "client-123",
};

(async () => {
  try {
    // Happy path: the returned recipe is persisted into
    // `.spec-keeper/<project-slug>.json` with owner-only permissions and
    // `.spec-keeper/config` is upserted under the canonical start-directory
    // key. The single-use token is sent only to the redeem endpoint and is
    // never written to disk.
    {
      const workspace = makeWorkspace("happy");
      const registryHome = join(root, "registry");
      mkdirSync(registryHome);
      const calls = stubFetch(() => enrollResponse(VALID_RECIPE));
      try {
        const result = await withCwd(workspace, () =>
          specKeeperEnroll({
            token: "single-use-enrollment-token",
            startDirectory: workspace,
            configDirectory: registryHome,
          }),
        );

        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.endsWith("/api/v1/agent-enrollments/redeem"));
        assert.equal(calls[0].method, "POST");
        assert.ok(calls[0].body?.includes("single-use-enrollment-token"));

        const canonical = realpathSync(workspace);
        const credentialPath = join(
          canonical,
          ".spec-keeper",
          "enrolled-project.json",
        );
        assert.ok(existsSync(credentialPath));
        if (process.platform !== "win32") {
          assert.equal(statSync(credentialPath).mode & 0o777, 0o600);
        }
        const credentialText = readFileSync(credentialPath, "utf8");
        assert.ok(!credentialText.includes("single-use-enrollment-token"));
        const credential = readJson(credentialPath);
        assert.equal(credential.username, "agent-user");
        assert.equal(credential.password, "agent-password");
        assert.equal(credential.api_base, "https://enroll.example");
        assert.equal(credential.project_slug, "enrolled-project");
        assert.equal(credential.role, "agent");
        assert.equal(credential.region, "us-east-1");
        assert.equal(credential.client_id, "client-123");

        const configPath = join(registryHome, ".spec-keeper", "config");
        assert.ok(existsSync(configPath));
        const configText = readFileSync(configPath, "utf8");
        assert.ok(!configText.includes("single-use-enrollment-token"));
        const config = readJson(configPath) as Record<
          string,
          Record<string, unknown>
        >;
        assert.deepEqual(Object.keys(config), [canonical]);
        assert.equal(config[canonical].projectSlug, "enrolled-project");
        assert.equal(
          config[canonical].credentialFile,
          ".spec-keeper/enrolled-project.json",
        );
        assert.equal(config[canonical].apiBase, "https://enroll.example");

        assert.equal(result.workspace.startDirectory, canonical);
        assert.equal(result.workspace.projectSlug, "enrolled-project");
        assert.equal(result.workspace.credentialFile, credentialPath);
        assert.equal(result.workspace.configPath, configPath);
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
        rmSync(registryHome, { recursive: true, force: true });
      }
    }

    // An explicit projectSlug wins over the recipe slug for both the credential
    // filename and the `.spec-keeper/config` entry.
    {
      const workspace = makeWorkspace("explicit-slug");
      stubFetch(() => enrollResponse(VALID_RECIPE));
      try {
        await withCwd(workspace, () =>
          specKeeperEnroll({
            token: "t",
            projectSlug: "explicit-project",
            startDirectory: workspace,
            configDirectory: workspace,
          }),
        );
        const canonical = realpathSync(workspace);
        const credentialPath = join(
          canonical,
          ".spec-keeper",
          "explicit-project.json",
        );
        assert.ok(existsSync(credentialPath));
        assert.equal(readJson(credentialPath).project_slug, "explicit-project");
        const config = readJson(join(canonical, ".spec-keeper", "config")) as Record<
          string,
          Record<string, unknown>
        >;
        assert.equal(config[canonical].projectSlug, "explicit-project");
        assert.equal(
          config[canonical].credentialFile,
          ".spec-keeper/explicit-project.json",
        );
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    // Upsert preserves entries for other workspaces while adding the new one.
    {
      const workspace = makeWorkspace("upsert");
      const specDir = join(workspace, ".spec-keeper");
      mkdirSync(specDir);
      const otherWorkspace = makeWorkspace("upsert-other");
      const otherCanonical = realpathSync(otherWorkspace);
      writeFileSync(
        join(specDir, "config"),
        JSON.stringify({
          [otherCanonical]: {
            projectSlug: "other-project",
            credentialFile: ".spec-keeper/other-project.json",
          },
        }),
      );
      stubFetch(() => enrollResponse(VALID_RECIPE));
      try {
        await withCwd(workspace, () =>
          specKeeperEnroll({
            token: "t",
            startDirectory: workspace,
            configDirectory: workspace,
          }),
        );
        const canonical = realpathSync(workspace);
        const config = readJson(join(canonical, ".spec-keeper", "config")) as Record<
          string,
          Record<string, unknown>
        >;
        assert.deepEqual(Object.keys(config).sort(), [canonical, otherCanonical].sort());
        assert.equal(config[otherCanonical].projectSlug, "other-project");
        assert.equal(config[canonical].projectSlug, "enrolled-project");
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
        rmSync(otherWorkspace, { recursive: true, force: true });
      }
    }

    // A non-OK redeem response is redacted before it enters an Error message,
    // so an echoed token never appears in logs.
    {
      const workspace = makeWorkspace("redact-error");
      stubFetch(
        () =>
          new Response(
            JSON.stringify({
              message: "denied",
              token: "single-use-enrollment-token",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      try {
        await withCwd(workspace, async () => {
          await assert.rejects(
            () => specKeeperEnroll({ token: "single-use-enrollment-token" }),
            (error: Error) => {
              assert.ok(error.message.includes("[REDACTED]"));
              assert.ok(!error.message.includes("single-use-enrollment-token"));
              return true;
            },
          );
        });
        // Nothing was persisted on failure.
        assert.ok(!existsSync(join(workspace, ".spec-keeper")));
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    // Non-JSON error bodies are redacted with the plain-text patterns as well.
    {
      const workspace = makeWorkspace("redact-plain");
      stubFetch(
        () =>
          new Response("token=single-use-enrollment-token and password=hunter2", {
            status: 400,
            headers: { "Content-Type": "text/plain" },
          }),
      );
      try {
        await withCwd(workspace, async () => {
          await assert.rejects(
            () => specKeeperEnroll({ token: "single-use-enrollment-token" }),
            (error: Error) => {
              assert.ok(error.message.includes("[REDACTED]"));
              assert.ok(!error.message.includes("single-use-enrollment-token"));
              assert.ok(!error.message.includes("hunter2"));
              return true;
            },
          );
        });
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    // An empty token is rejected before any redeem request is sent.
    {
      const workspace = makeWorkspace("empty-token");
      const calls = stubFetch(() => enrollResponse(VALID_RECIPE));
      try {
        await withCwd(workspace, async () => {
          await assert.rejects(
            () => specKeeperEnroll({ token: "   " }),
            /non-empty Spec Keeper enrollment token/,
          );
        });
        assert.equal(calls.length, 0);
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    // A legacy `.spec-keeper` file blocks the new layout instead of being
    // silently replaced.
    {
      const workspace = makeWorkspace("legacy-file");
      writeFileSync(
        join(workspace, ".spec-keeper"),
        JSON.stringify({ projectSlug: "legacy" }),
      );
      stubFetch(() => enrollResponse(VALID_RECIPE));
      try {
        await withCwd(workspace, async () => {
          await assert.rejects(
            () =>
              specKeeperEnroll({
                token: "t",
                startDirectory: workspace,
                configDirectory: workspace,
              }),
            /Migrate the legacy \.spec-keeper file first/,
          );
        });
        assert.ok(!statSync(join(workspace, ".spec-keeper")).isDirectory());
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    // A malformed existing `.spec-keeper/config` is refused rather than
    // overwritten.
    {
      const workspace = makeWorkspace("malformed-config");
      mkdirSync(join(workspace, ".spec-keeper"));
      writeFileSync(join(workspace, ".spec-keeper", "config"), "{ not valid json");
      stubFetch(() => enrollResponse(VALID_RECIPE));
      try {
        await withCwd(workspace, async () => {
          await assert.rejects(
            () =>
              specKeeperEnroll({
                token: "t",
                startDirectory: workspace,
                configDirectory: workspace,
              }),
            /refuses to overwrite malformed/,
          );
        });
        assert.equal(
          readFileSync(join(workspace, ".spec-keeper", "config"), "utf8"),
          "{ not valid json",
        );
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    // Invalid project slugs and incomplete recipes fail closed before any file
    // is written.
    {
      const workspace = makeWorkspace("invalid-slug");
      stubFetch(() => enrollResponse(VALID_RECIPE));
      try {
        await withCwd(workspace, async () => {
          await assert.rejects(
            () => specKeeperEnroll({ token: "t", projectSlug: "not a slug" }),
            /URL-safe project slug/,
          );
        });
        assert.ok(!existsSync(join(workspace, ".spec-keeper")));
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    {
      const workspace = makeWorkspace("incomplete-recipe");
      stubFetch(() => enrollResponse({ username: "only-user" }));
      try {
        await withCwd(workspace, async () => {
          await assert.rejects(
            () => specKeeperEnroll({ token: "t" }),
            /incomplete recipe/,
          );
        });
        assert.ok(!existsSync(join(workspace, ".spec-keeper")));
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    // An invalid api_base in the recipe fails closed before files are written.
    {
      const workspace = makeWorkspace("bad-api-base");
      stubFetch(() =>
        enrollResponse({ ...VALID_RECIPE, api_base: "not-a-url" }),
      );
      try {
        await withCwd(workspace, async () => {
          await assert.rejects(
            () => specKeeperEnroll({ token: "t" }),
            /must start with http:\/\/ or https:\/\//,
          );
        });
        assert.ok(!existsSync(join(workspace, ".spec-keeper")));
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(workspace, { recursive: true, force: true });
      }
    }

    console.log("Spec Keeper enrollment fixtures passed");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
