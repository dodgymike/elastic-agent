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
import specKeeper from "../tools/SpecKeeper.ts";

const originalFetch = globalThis.fetch;

interface WorkspaceFixture {
  workspace: string;
  canonical: string;
  specDir: string;
}

function makeWorkspace(): WorkspaceFixture {
  const workspace = mkdtempSync(join(tmpdir(), "spec-keeper-tool-lookup-"));
  const specDir = join(workspace, ".spec-keeper");
  mkdirSync(specDir);
  return { workspace, canonical: realpathSync(workspace), specDir };
}

function writeWorkspaceConfig(
  fixture: WorkspaceFixture,
  entry: Record<string, unknown>,
): void {
  writeFileSync(
    join(fixture.specDir, "config"),
    JSON.stringify({ [fixture.canonical]: entry }),
  );
}

function writeCredential(fixture: WorkspaceFixture, name: string, contents: string, mode = 0o600): void {
  const path = join(fixture.specDir, name);
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

async function withCwd(dir: string, run: () => Promise<void> | void): Promise<void> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    await run();
  } finally {
    process.chdir(previous);
  }
}

(async () => {
  // Missing workspace mapping fails closed before any credential lookup.
  {
    const fixture = makeWorkspace();
    try {
      await withCwd(fixture.workspace, async () => {
        await assert.rejects(
          () =>
            specKeeper({
              path: "/tasks",
              accessToken: "tok",
              configDirectory: fixture.workspace,
            }),
          (error: Error) => {
            assert.match(error.message, /no workspace mapping for start directory/);
            assert.ok(error.message.includes("No .spec-keeper/config was found at"));
            return true;
          },
        );
      });
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  }

  // The canonical start directory keys the mapping, and the mapped
  // projectSlug/apiBase are used when callers omit explicit overrides.
  {
    const fixture = makeWorkspace();
    writeWorkspaceConfig(fixture, {
      projectSlug: "workspace-slug",
      credentialFile: ".spec-keeper/workspace-slug.json",
      apiBase: "https://workspace.example/",
    });
    writeCredential(fixture, "workspace-slug.json", "{}");

    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await withCwd(fixture.workspace, async () => {
        await specKeeper({
          path: "/tasks",
          accessToken: "tok",
          configDirectory: fixture.workspace,
        });
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
    assert.deepEqual(calls, [
      { url: "https://workspace.example/api/v1/projects/workspace-slug/tasks", method: "GET" },
    ]);
  }

  // An explicit startDirectory keys the lookup without relying on process.cwd(),
  // while the configDirectory override points the registry read at the fixture.
  {
    const fixture = makeWorkspace();
    writeWorkspaceConfig(fixture, {
      projectSlug: "explicit-start",
      credentialFile: ".spec-keeper/explicit.json",
      apiBase: "https://explicit.example/",
    });
    writeCredential(fixture, "explicit.json", "{}");

    const otherDir = mkdtempSync(join(tmpdir(), "spec-keeper-tool-lookup-other-"));
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await withCwd(otherDir, async () => {
        await specKeeper({
          path: "/tasks",
          accessToken: "tok",
          startDirectory: fixture.workspace,
          configDirectory: fixture.workspace,
        });
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(otherDir, { recursive: true, force: true });
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
    assert.deepEqual(calls, [
      { url: "https://explicit.example/api/v1/projects/explicit-start/tasks", method: "GET" },
    ]);
  }

  // A relative credentialFile resolves against the canonical start directory.
  {
    const fixture = makeWorkspace();
    writeWorkspaceConfig(fixture, {
      projectSlug: "workspace-slug",
      credentialFile: ".spec-keeper/credentials.json",
    });
    writeCredential(fixture, "credentials.json", JSON.stringify({ accessToken: "from-file" }));

    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await withCwd(fixture.workspace, async () => {
        await specKeeper({
          path: "/tasks",
          configDirectory: fixture.workspace,
        });
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.spec.elasticninja.com/api/v1/projects/workspace-slug/tasks");
  }

  // A missing credential file fails closed after the mapping resolves.
  {
    const fixture = makeWorkspace();
    writeWorkspaceConfig(fixture, {
      projectSlug: "workspace-slug",
      credentialFile: ".spec-keeper/missing.json",
    });
    try {
      await withCwd(fixture.workspace, async () => {
        await assert.rejects(
          () =>
            specKeeper({
              path: "/tasks",
              accessToken: "tok",
              configDirectory: fixture.workspace,
            }),
          /credential file.*does not exist/i,
        );
      });
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  }

  // A malformed credential file fails closed without exposing its contents.
  {
    const fixture = makeWorkspace();
    writeWorkspaceConfig(fixture, {
      projectSlug: "workspace-slug",
      credentialFile: ".spec-keeper/malformed.json",
    });
    writeCredential(fixture, "malformed.json", "{ not valid json");
    try {
      await withCwd(fixture.workspace, async () => {
        await assert.rejects(
          () =>
            specKeeper({
              path: "/tasks",
              accessToken: "tok",
              configDirectory: fixture.workspace,
            }),
          /could not load its local credential store/i,
        );
      });
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  }

  // A group/world-readable credential file fails closed.
  if (process.platform !== "win32") {
    const fixture = makeWorkspace();
    writeWorkspaceConfig(fixture, {
      projectSlug: "workspace-slug",
      credentialFile: ".spec-keeper/permissive.json",
    });
    writeCredential(fixture, "permissive.json", "{}", 0o644);
    try {
      await withCwd(fixture.workspace, async () => {
        await assert.rejects(
          () =>
            specKeeper({
              path: "/tasks",
              accessToken: "tok",
              configDirectory: fixture.workspace,
            }),
          /overly permissive permissions/i,
        );
      });
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  }

  console.log("Spec Keeper tool workspace lookup fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
