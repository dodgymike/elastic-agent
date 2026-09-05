import assert from "node:assert/strict";
import {
  chmodSync,
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
import {
  describeSpecKeeperMigrationReport,
  migrateSpecKeeperWorkspace,
} from "../specKeeperMigration.js";
import {
  loadSpecKeeperWorkspaceRegistry,
  resolveSpecKeeperRuntimeDefaults,
} from "../specKeeperConfig.js";

const root = mkdtempSync(join(tmpdir(), "spec-keeper-migration-"));

function makeWorkspace(name: string): string {
  const workspace = join(root, name);
  mkdirSync(workspace);
  return workspace;
}

function writeLegacyConfig(
  workspace: string,
  contents: string,
  mode = 0o644,
): void {
  const path = join(workspace, ".spec-keeper");
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

function writeLegacyCredential(
  workspace: string,
  contents: string,
  mode = 0o664,
): string {
  const path = join(workspace, ".spec.local.json");
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

try {
  // Happy path: a legacy `.spec-keeper` file plus a legacy credential store are
  // migrated into the new directory layout with secure permissions.
  {
    const workspace = makeWorkspace("happy");
    writeLegacyConfig(
      workspace,
      JSON.stringify({
        projectSlug: "legacy-slug",
        apiBase: "https://legacy.example/",
        credentialStore: ".spec.local.json",
        defaultEpic: { key: "LEGACY-EPIC", status: "in_progress" },
        defaultTask: { keyPrefix: "LEGACY-", status: "in_progress" },
      }),
    );
    const legacyCredentialPath = writeLegacyCredential(
      workspace,
      JSON.stringify({
        Username: "legacy-user",
        Password: "super-secret-password",
        "API base": "https://legacy.example",
        Region: "us-east-1",
        "Client ID": "legacy-client",
        Project: "legacy-slug",
      }),
    );
    const canonical = realpathSync(workspace);

    const report = migrateSpecKeeperWorkspace(workspace);
    assert.equal(report.migrated, true);
    assert.equal(report.projectSlug, "legacy-slug");
    assert.equal(report.apiBase, "https://legacy.example");
    assert.equal(report.startDirectory, canonical);
    assert.ok(!existsSync(join(workspace, ".spec-keeper.legacy.migrating")));
    assert.ok(existsSync(join(workspace, ".spec-keeper")));
    assert.ok(statSync(join(workspace, ".spec-keeper")).isDirectory());

    const configPath = join(workspace, ".spec-keeper", "config");
    const registry = readJson(configPath) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(registry), [canonical]);
    assert.equal(registry[canonical].projectSlug, "legacy-slug");
    assert.equal(registry[canonical].credentialFile, ".spec-keeper/legacy-slug.json");
    assert.equal(registry[canonical].apiBase, "https://legacy.example");
    assert.equal((registry[canonical].defaultEpic as Record<string, unknown>).key, "LEGACY-EPIC");
    assert.equal((registry[canonical].defaultTask as Record<string, unknown>).keyPrefix, "LEGACY-");

    const credentialFile = join(workspace, ".spec-keeper", "legacy-slug.json");
    assert.ok(existsSync(credentialFile));
    if (process.platform !== "win32") {
      assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
      assert.equal(statSync(legacyCredentialPath).mode & 0o777, 0o600);
    }
    const credential = readJson(credentialFile);
    assert.equal(credential.Username, "legacy-user");
    assert.equal(credential.Project, "legacy-slug");
    // The legacy secret value must not appear in the secret-free report.
    const description = describeSpecKeeperMigrationReport(report);
    assert.ok(!description.includes("super-secret-password"));
    assert.ok(!description.includes("legacy-user"));
  }

  // Missing legacy credential store: the config mapping is still written and
  // the report flags the missing store without exposing anything.
  {
    const workspace = makeWorkspace("missing-credential");
    writeLegacyConfig(
      workspace,
      JSON.stringify({
        projectSlug: "missing-cred",
        apiBase: "https://missing.example",
        credentialStore: ".spec.local.json",
      }),
    );
    const report = migrateSpecKeeperWorkspace(workspace);
    assert.equal(report.migrated, true);
    assert.equal(report.credentialFile, undefined);
    assert.ok(report.warnings.some((warning) => warning.includes("No legacy credential store found")));
    const registry = loadSpecKeeperWorkspaceRegistry({ startDirectory: workspace });
    assert.equal(registry.registry[realpathSync(workspace)].projectSlug, "missing-cred");
    assert.equal(
      registry.registry[realpathSync(workspace)].credentialFile,
      ".spec-keeper/missing-cred.json",
    );
  }

  // Malformed legacy config file fails closed and leaves the file in place.
  {
    const workspace = makeWorkspace("malformed-config");
    writeLegacyConfig(workspace, "{ not valid json");
    assert.throws(
      () => migrateSpecKeeperWorkspace(workspace),
      /cannot migrate.*not valid JSON/i,
    );
    assert.ok(existsSync(join(workspace, ".spec-keeper")));
  }

  // Malformed legacy credential store fails closed and restores the legacy
  // config file rather than leaving a half-migrated workspace.
  {
    const workspace = makeWorkspace("malformed-credential");
    writeLegacyConfig(
      workspace,
      JSON.stringify({ projectSlug: "bad-cred", credentialStore: ".spec.local.json" }),
    );
    writeLegacyCredential(workspace, "{ not valid json");
    assert.throws(
      () => migrateSpecKeeperWorkspace(workspace),
      /could not read the legacy credential store/i,
    );
    assert.ok(existsSync(join(workspace, ".spec-keeper")));
    assert.ok(!existsSync(join(workspace, ".spec-keeper", "config")));
  }

  // A directory at `.spec-keeper` (already migrated) is reported as no-op.
  {
    const workspace = makeWorkspace("already-migrated");
    mkdirSync(join(workspace, ".spec-keeper"));
    const report = migrateSpecKeeperWorkspace(workspace);
    assert.equal(report.migrated, false);
    assert.ok(report.warnings.some((warning) => warning.includes("already a directory")));
  }

  // No legacy file at all is reported as no-op.
  {
    const workspace = makeWorkspace("none");
    const report = migrateSpecKeeperWorkspace(workspace);
    assert.equal(report.migrated, false);
    assert.ok(report.warnings.some((warning) => warning.includes("nothing to migrate")));
  }

  // After migration, runtime defaults resolve projectSlug/apiBase from the
  // workspace mapping and preserve defaultEpic/defaultTask from the entry.
  {
    const workspace = makeWorkspace("runtime");
    writeLegacyConfig(
      workspace,
      JSON.stringify({
        projectSlug: "runtime-slug",
        apiBase: "https://runtime.example/",
        credentialStore: ".spec.local.json",
        defaultEpic: { key: "RUNTIME-EPIC" },
        defaultTask: { keyPrefix: "RT-" },
      }),
    );
    writeLegacyCredential(workspace, JSON.stringify({ Username: "u", Password: "p" }), 0o600);
    const report = migrateSpecKeeperWorkspace(workspace);
    assert.equal(report.migrated, true);
    const defaults = resolveSpecKeeperRuntimeDefaults({ startDirectory: workspace, env: {} });
    assert.equal(defaults.workspace?.config.projectSlug, "runtime-slug");
    assert.equal(defaults.projectSlug, "runtime-slug");
    assert.equal(defaults.apiBase, "https://runtime.example");
    assert.equal(defaults.defaultEpic?.key, "RUNTIME-EPIC");
    assert.equal(defaults.defaultTask?.keyPrefix, "RT-");
  }

  // Without any workspace mapping, runtime defaults fail open to an
  // unconfigured object with an actionable warning instead of throwing.
  {
    const workspace = makeWorkspace("runtime-unconfigured");
    const defaults = resolveSpecKeeperRuntimeDefaults({ startDirectory: workspace, env: {} });
    assert.equal(defaults.workspace, null);
    assert.equal(defaults.projectSlug, undefined);
    assert.equal(defaults.apiBase, "https://api.spec.elasticninja.com");
    assert.ok(defaults.warnings.some((warning) => warning.includes("no workspace mapping")));
  }

  console.log("Spec Keeper migration fixtures passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
