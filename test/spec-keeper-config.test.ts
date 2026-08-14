import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeSpecKeeperDefaults,
  loadSpecKeeperDefaultsFile,
  resolveSpecKeeperDefaults,
} from "../specKeeperConfig.js";

const BUILTIN_PROJECT_SLUG = "elastic-agent";
const BUILTIN_API_BASE = "https://api.spec.elasticninja.com";
const BUILTIN_CREDENTIAL_STORE = ".spec.local.json";

const root = mkdtempSync(join(tmpdir(), "spec-keeper-config-"));
const cwd = join(root, "repo");
mkdirSync(cwd);
const emptyDir = join(root, "empty");
mkdirSync(emptyDir);

const writeDefaults = (contents: string) =>
  writeFileSync(join(cwd, ".spec-keeper"), contents);

try {
  // Missing .spec-keeper falls back to built-in defaults and reports builtin
  // sources without warnings.
  const missing = resolveSpecKeeperDefaults(undefined, { cwd: emptyDir, env: {} });
  assert.equal(missing.projectSlug, BUILTIN_PROJECT_SLUG);
  assert.equal(missing.apiBase, BUILTIN_API_BASE);
  assert.equal(missing.credentialStore, BUILTIN_CREDENTIAL_STORE);
  assert.equal(missing.sources.projectSlug, "builtin");
  assert.equal(missing.sources.apiBase, "builtin");
  assert.equal(missing.sources.credentialStore, "builtin");
  assert.deepEqual(missing.warnings, []);
  assert.equal(loadSpecKeeperDefaultsFile({ cwd: emptyDir, env: {} }).source, "missing");

  // A valid .spec-keeper file overrides environment and built-in values and
  // carries default epic/task settings.
  writeDefaults(
    JSON.stringify({
      projectSlug: "file-slug",
      apiBase: "https://file.example/",
      credentialStore: ".file-creds.json",
      defaultEpic: { key: "FILE-EPIC", status: "in_progress" },
      defaultTask: { keyPrefix: "FILE-", status: "in_progress" },
    }),
  );
  const fromFile = resolveSpecKeeperDefaults(undefined, {
    cwd,
    env: {
      SPEC_KEEPER_PROJECT_SLUG: "env-slug",
      SPEC_KEEPER_API_BASE: "https://env.example",
      SPEC_KEEPER_CONFIG_PATH: ".env-creds.json",
    },
  });
  assert.equal(fromFile.projectSlug, "file-slug");
  assert.equal(fromFile.sources.projectSlug, "spec-keeper");
  assert.equal(fromFile.apiBase, "https://file.example");
  assert.equal(fromFile.sources.apiBase, "spec-keeper");
  assert.equal(fromFile.credentialStore, ".file-creds.json");
  assert.equal(fromFile.sources.credentialStore, "spec-keeper");
  assert.equal(fromFile.defaultEpic?.key, "FILE-EPIC");
  assert.equal(fromFile.defaultTask?.keyPrefix, "FILE-");

  // Environment overrides built-in when no file exists.
  const fromEnvironment = resolveSpecKeeperDefaults(undefined, {
    cwd: emptyDir,
    env: {
      SPEC_KEEPER_PROJECT_SLUG: "env-slug",
      SPEC_KEEPER_API_BASE: "https://env.example",
      SPEC_KEEPER_CONFIG_PATH: ".env-creds.json",
    },
  });
  assert.equal(fromEnvironment.projectSlug, "env-slug");
  assert.equal(fromEnvironment.sources.projectSlug, "environment");
  assert.equal(fromEnvironment.apiBase, "https://env.example");
  assert.equal(fromEnvironment.sources.apiBase, "environment");
  assert.equal(fromEnvironment.credentialStore, ".env-creds.json");
  assert.equal(fromEnvironment.sources.credentialStore, "environment");

  // Explicit per-call arguments override the file.
  const fromArgument = resolveSpecKeeperDefaults(
    { projectSlug: "arg-slug", apiBase: "https://arg.example" },
    { cwd, env: {} },
  );
  assert.equal(fromArgument.projectSlug, "arg-slug");
  assert.equal(fromArgument.sources.projectSlug, "argument");
  assert.equal(fromArgument.apiBase, "https://arg.example");
  assert.equal(fromArgument.sources.apiBase, "argument");

  // camelCase, snake_case, and human-readable keys are normalized. Blank first
  // aliases are treated as absent so later aliases still win for that layer.
  writeDefaults(
    JSON.stringify({
      projectSlug: "   ",
      project_slug: "snake-slug",
      "API base": "https://human.example",
      credential_store: "",
      configPath: ".alias-creds.json",
      default_epic: { epic_key: "SNAKE-EPIC", status: "in_progress" },
      default_task: { task_key: "SNAKE-TASK", epic_key: "SNAKE-EPIC" },
    }),
  );
  const normalized = resolveSpecKeeperDefaults(undefined, { cwd, env: {} });
  assert.equal(normalized.projectSlug, "snake-slug");
  assert.equal(normalized.apiBase, "https://human.example");
  assert.equal(normalized.credentialStore, ".alias-creds.json");
  assert.equal(normalized.defaultEpic?.key, "SNAKE-EPIC");
  assert.equal(normalized.defaultTask?.key, "SNAKE-TASK");
  assert.equal(normalized.defaultTask?.epicKey, "SNAKE-EPIC");

  // Malformed JSON produces a clear warning and falls back without throwing.
  writeDefaults("{ not valid json");
  const malformed = resolveSpecKeeperDefaults(undefined, { cwd, env: {} });
  assert.equal(malformed.projectSlug, BUILTIN_PROJECT_SLUG);
  assert.equal(malformed.apiBase, BUILTIN_API_BASE);
  assert.equal(malformed.credentialStore, BUILTIN_CREDENTIAL_STORE);
  assert.ok(malformed.warnings.some((warning) => warning.includes("not valid JSON")));

  // Invalid field types produce warnings and do not shadow fallback values.
  writeDefaults(JSON.stringify({ projectSlug: 123, apiBase: true, defaultEpic: "epic" }));
  const invalid = resolveSpecKeeperDefaults(undefined, { cwd, env: {} });
  assert.equal(invalid.projectSlug, BUILTIN_PROJECT_SLUG);
  assert.equal(invalid.apiBase, BUILTIN_API_BASE);
  assert.ok(invalid.warnings.some((warning) => warning.includes("projectSlug")));
  assert.ok(invalid.warnings.some((warning) => warning.includes("apiBase")));
  assert.ok(invalid.warnings.some((warning) => warning.includes("defaultEpic")));

  // The verification summary reports winning sources and redacts URL userinfo.
  const secretApiBase = resolveSpecKeeperDefaults(
    { apiBase: "https://user:pass@api.example/" },
    { cwd: emptyDir, env: {} },
  );
  const summary = describeSpecKeeperDefaults(secretApiBase);
  assert.ok(summary.includes("projectSlug=elastic-agent (source: builtin)"));
  assert.ok(summary.includes("apiBase=https://REDACTED:REDACTED@api.example (source: argument)"));
  assert.ok(summary.includes("credentialStore=.spec.local.json (source: builtin)"));
  assert.ok(!summary.includes("user:pass"));
  assert.ok(!summary.includes("pass@"));

  console.log("Spec Keeper config fallback and logging fixtures passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
