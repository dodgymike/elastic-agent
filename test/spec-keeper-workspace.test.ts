import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeSpecKeeperStartDirectory,
  loadSpecKeeperWorkspaceRegistry,
  resolveSpecKeeperWorkspace,
  specKeeperMainDirectory,
  specKeeperWorkspaceConfigPath,
} from "../specKeeperConfig.js";

const root = mkdtempSync(join(tmpdir(), "spec-keeper-workspace-"));
const workspace = join(root, "workspace");
mkdirSync(workspace);
const specDir = join(workspace, ".spec-keeper");
mkdirSync(specDir);

const writeConfig = (contents: string) =>
  writeFileSync(join(specDir, "config"), contents);

try {
  // Canonical start directories use absolute-path resolution followed by
  // symlink-resolution so aliases (e.g. /home -> /mnt) compare equal.
  const canonicalWorkspace = realpathSync(workspace);
  assert.equal(canonicalizeSpecKeeperStartDirectory(workspace), canonicalWorkspace);

  // A relative spelling resolves against the process cwd first, then
  // canonicalizes to the same absolute path.
  assert.equal(
    canonicalizeSpecKeeperStartDirectory("."),
    realpathSync(process.cwd()),
  );

  // A missing directory still produces a deterministic absolute path instead
  // of throwing, so lookups work before the directory exists.
  const missingDir = join(root, "missing");
  assert.equal(canonicalizeSpecKeeperStartDirectory(missingDir), missingDir);

  // An empty start directory is rejected rather than silently resolving to cwd.
  assert.throws(
    () => canonicalizeSpecKeeperStartDirectory("   "),
    /non-empty workspace start directory/,
  );

  // Symlinked start-directory spellings resolve to their real target.
  const target = join(root, "target");
  mkdirSync(target);
  const alias = join(root, "alias");
  let symlinkResolves = false;
  try {
    symlinkSync(target, alias, "dir");
    symlinkResolves = realpathSync(alias) === realpathSync(target);
  } catch {
    // Symlinks unsupported: skip the symlink-specific assertions.
  }
  if (symlinkResolves) {
    assert.equal(canonicalizeSpecKeeperStartDirectory(alias), realpathSync(target));
  }

  // The config path helper names `.spec-keeper/config` under an explicit base
  // directory, while its no-argument default is the directory containing
  // main.ts -- independent of the process working directory.
  assert.equal(
    specKeeperWorkspaceConfigPath(workspace),
    join(workspace, ".spec-keeper", "config"),
  );
  const mainDirConfigPath = join(specKeeperMainDirectory(), ".spec-keeper", "config");
  assert.equal(specKeeperWorkspaceConfigPath(), mainDirConfigPath);
  const unrelatedCwd = mkdtempSync(join(root, "unrelated-cwd-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(unrelatedCwd);
    assert.equal(specKeeperWorkspaceConfigPath(), mainDirConfigPath);
  } finally {
    process.chdir(previousCwd);
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }

  // Without a configDirectory override, the registry loader reads from the
  // main.ts directory even when the start directory is elsewhere.
  assert.equal(
    loadSpecKeeperWorkspaceRegistry({ startDirectory: workspace }).path,
    mainDirConfigPath,
  );

  // A missing registry file (under the explicit configDirectory override)
  // reports source "missing" with no warnings.
  const missingRegistry = loadSpecKeeperWorkspaceRegistry({
    startDirectory: workspace,
    configDirectory: workspace,
  });
  assert.equal(missingRegistry.source, "missing");
  assert.deepEqual(missingRegistry.registry, {});
  assert.deepEqual(missingRegistry.warnings, []);
  assert.equal(missingRegistry.path, join(workspace, ".spec-keeper", "config"));

  // A valid registry is keyed by the canonical start directory and normalizes
  // camelCase, snake_case, and legacy human-readable aliases.
  writeConfig(
    JSON.stringify({
      [canonicalWorkspace]: {
        projectSlug: "workspace-slug",
        credentialFile: ".spec-keeper/workspace-slug.json",
        apiBase: "https://workspace.example/",
      },
    }),
  );
  const loaded = loadSpecKeeperWorkspaceRegistry({
    startDirectory: workspace,
    configDirectory: workspace,
  });
  assert.equal(loaded.source, "file");
  assert.deepEqual(Object.keys(loaded.registry), [canonicalWorkspace]);
  assert.equal(loaded.registry[canonicalWorkspace].projectSlug, "workspace-slug");
  assert.equal(
    loaded.registry[canonicalWorkspace].credentialFile,
    ".spec-keeper/workspace-slug.json",
  );
  assert.equal(loaded.registry[canonicalWorkspace].apiBase, "https://workspace.example/");
  assert.deepEqual(loaded.warnings, []);

  // camelCase/snake_case/human aliases are accepted for the entry fields.
  writeConfig(
    JSON.stringify({
      [canonicalWorkspace]: {
        project_slug: "aliased-slug",
        credential_store: ".spec-keeper/aliased.json",
        "API base": "https://aliased.example",
      },
    }),
  );
  const aliased = loadSpecKeeperWorkspaceRegistry({
    startDirectory: workspace,
    configDirectory: workspace,
  });
  assert.equal(aliased.registry[canonicalWorkspace].projectSlug, "aliased-slug");
  assert.equal(
    aliased.registry[canonicalWorkspace].credentialFile,
    ".spec-keeper/aliased.json",
  );
  assert.equal(aliased.registry[canonicalWorkspace].apiBase, "https://aliased.example");

  // resolveSpecKeeperWorkspace returns the matching mapping.
  const resolved = resolveSpecKeeperWorkspace(workspace, {
    configDirectory: workspace,
  });
  assert.equal(resolved.startDirectory, canonicalWorkspace);
  assert.equal(resolved.config.projectSlug, "aliased-slug");
  assert.equal(resolved.configPath, join(workspace, ".spec-keeper", "config"));

  // Invalid entries are skipped with warnings rather than poisoning the
  // registry: a non-absolute key, a non-object value, and an entry missing
  // credentialFile are all ignored while the valid entry remains.
  writeConfig(
    JSON.stringify({
      [canonicalWorkspace]: { projectSlug: "good", credentialFile: ".spec-keeper/good.json" },
      "relative/key": { projectSlug: "bad", credentialFile: ".spec-keeper/bad.json" },
      [join(root, "not-an-object")]: "not-an-object",
      [join(root, "missing-credential")]: { projectSlug: "bad" },
    }),
  );
  const mixed = loadSpecKeeperWorkspaceRegistry({
    startDirectory: workspace,
    configDirectory: workspace,
  });
  assert.deepEqual(Object.keys(mixed.registry), [canonicalWorkspace]);
  assert.equal(mixed.registry[canonicalWorkspace].projectSlug, "good");
  assert.ok(
    mixed.warnings.some((warning) => warning.includes("invalid workspace key 'relative/key'")),
  );
  assert.ok(
    mixed.warnings.some((warning) => warning.includes("expected a JSON object")),
  );
  assert.ok(
    mixed.warnings.some((warning) => warning.includes("missing projectSlug or credentialFile")),
  );

  // Two keys that canonicalize to the same start directory collapse to a
  // single deterministic mapping (the later entry wins) rather than leaving an
  // ambiguous duplicate in the registry.
  writeConfig(
    JSON.stringify({
      [canonicalWorkspace]: {
        projectSlug: "first",
        credentialFile: ".spec-keeper/first.json",
      },
      [join(workspace, "child", "..")]: {
        projectSlug: "second",
        credentialFile: ".spec-keeper/second.json",
      },
    }),
  );
  const collapsed = loadSpecKeeperWorkspaceRegistry({
    startDirectory: workspace,
    configDirectory: workspace,
  });
  assert.deepEqual(Object.keys(collapsed.registry), [canonicalWorkspace]);
  assert.equal(collapsed.registry[canonicalWorkspace].projectSlug, "second");
  assert.equal(
    collapsed.registry[canonicalWorkspace].credentialFile,
    ".spec-keeper/second.json",
  );
  assert.equal(
    resolveSpecKeeperWorkspace(workspace, { configDirectory: workspace }).config.projectSlug,
    "second",
  );

  // Malformed JSON and non-object roots fail closed with a clear warning.
  writeConfig("{ not valid json");
  const malformed = loadSpecKeeperWorkspaceRegistry({
    startDirectory: workspace,
    configDirectory: workspace,
  });
  assert.equal(malformed.source, "file");
  assert.deepEqual(malformed.registry, {});
  assert.ok(malformed.warnings.some((warning) => warning.includes("not valid JSON")));

  writeConfig("[]");
  const nonObject = loadSpecKeeperWorkspaceRegistry({
    startDirectory: workspace,
    configDirectory: workspace,
  });
  assert.equal(nonObject.source, "file");
  assert.deepEqual(nonObject.registry, {});
  assert.ok(
    nonObject.warnings.some((warning) => warning.includes("top-level value must be a JSON object")),
  );

  // When no mapping exists for the start directory, the lookup throws an
  // actionable error that lists the configured workspaces.
  writeConfig(
    JSON.stringify({
      [join(root, "other-workspace")]: {
        projectSlug: "other",
        credentialFile: ".spec-keeper/other.json",
      },
    }),
  );
  assert.throws(
    () => resolveSpecKeeperWorkspace(workspace, { configDirectory: workspace }),
    (error: Error) => {
      assert.match(error.message, /no workspace mapping for start directory/);
      assert.ok(error.message.includes("Configured workspaces:"));
      assert.ok(error.message.includes(join(root, "other-workspace")));
      assert.ok(error.message.includes("projectSlug and credentialFile"));
      return true;
    },
  );

  // A missing registry fails closed with the config path and no implicit
  // credential-file search: a `.spec.local.json` sitting in the workspace does
  // not make the lookup succeed.
  const unconfigured = join(root, "unconfigured");
  mkdirSync(unconfigured);
  writeFileSync(join(unconfigured, ".spec.local.json"), JSON.stringify({ Project: "sneaky" }));
  assert.throws(
    () => resolveSpecKeeperWorkspace(unconfigured, { configDirectory: unconfigured }),
    (error: Error) => {
      assert.match(error.message, /no workspace mapping for start directory/);
      assert.ok(error.message.includes("No .spec-keeper/config was found at"));
      assert.ok(error.message.includes(join(unconfigured, ".spec-keeper", "config")));
      return true;
    },
  );

  // When no start directory is supplied, the lookup falls back to the process
  // working directory (canonicalized) while still reading the registry from
  // the explicit configDirectory override.
  {
    const fallbackCwd = join(root, "fallback-cwd");
    mkdirSync(fallbackCwd);
    mkdirSync(join(fallbackCwd, ".spec-keeper"));
    writeFileSync(
      join(fallbackCwd, ".spec-keeper", "config"),
      JSON.stringify({
        [realpathSync(fallbackCwd)]: {
          projectSlug: "fallback-slug",
          credentialFile: ".spec-keeper/fallback.json",
        },
      }),
    );
    const fallbackPreviousCwd = process.cwd();
    try {
      process.chdir(fallbackCwd);
      const fallbackResolved = resolveSpecKeeperWorkspace(undefined, {
        configDirectory: fallbackCwd,
      });
      assert.equal(fallbackResolved.startDirectory, realpathSync(fallbackCwd));
      assert.equal(fallbackResolved.config.projectSlug, "fallback-slug");
    } finally {
      process.chdir(fallbackPreviousCwd);
    }
  }

  console.log("Spec Keeper workspace registry layout and lookup fixtures passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
