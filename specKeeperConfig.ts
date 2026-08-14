import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Non-secret Spec Keeper default configuration.
 *
 * The local `.spec-keeper` file is intentionally safe to commit: it carries
 * only operational defaults such as the project slug, API base, credential
 * store path, and default epic/task settings. Credentials never live here;
 * they stay in the approved secret store (for example `.spec.local.json`).
 *
 * Precedence, resolved per field and highest first:
 *   1. explicit per-call arguments,
 *   2. local `.spec-keeper` file,
 *   3. environment defaults,
 *   4. secret-store compatibility fallback (deprecated, operational fields
 *      only),
 *   5. built-in prompt fallback.
 */

export interface SpecKeeperEpicDefaults {
  /** Stable epic key for fetch-or-create. */
  key?: string;
  /** Fallback title when creating an epic. */
  title?: string;
  /** Fallback description when creating an epic. */
  description?: string;
  /** Default status for a newly created epic. */
  status?: string;
}

export interface SpecKeeperTaskDefaults {
  /** Stable task key for fetch-or-create. */
  key?: string;
  /** Epic to attach new tasks to when no epic is selected. */
  epicKey?: string;
  /** Prefix for generated task keys when no stable key is configured. */
  keyPrefix?: string;
  /** Fallback title when creating a task. */
  title?: string;
  /** Fallback description when creating a task. */
  description?: string;
  /** Default status for a newly created task. */
  status?: string;
}

export interface SpecKeeperDefaultsConfig {
  projectSlug?: string;
  apiBase?: string;
  credentialStore?: string;
  defaultEpic?: SpecKeeperEpicDefaults;
  defaultTask?: SpecKeeperTaskDefaults;
}

/** Explicit per-call operational fields accepted by the resolver. */
export interface SpecKeeperDefaultsInput {
  projectSlug?: string;
  apiBase?: string;
}

export type SpecKeeperConfigSource =
  | "argument"
  | "spec-keeper"
  | "environment"
  | "secret-store"
  | "builtin";

export interface ResolvedSpecKeeperDefaults {
  /** Undefined only when no layer supplies a slug and no built-in is used. */
  projectSlug?: string;
  apiBase: string;
  credentialStore: string;
  defaultEpic?: SpecKeeperEpicDefaults;
  defaultTask?: SpecKeeperTaskDefaults;
  sources: {
    projectSlug: SpecKeeperConfigSource;
    apiBase: SpecKeeperConfigSource;
    credentialStore: SpecKeeperConfigSource;
  };
  warnings: string[];
}

const DEFAULTS_FILE_NAME = ".spec-keeper";
const BUILTIN_PROJECT_SLUG = "elastic-agent";
const BUILTIN_API_BASE = "https://api.spec.elasticninja.com";
const BUILTIN_CREDENTIAL_STORE = ".spec.local.json";

interface LoadedDefaultsFile {
  config: SpecKeeperDefaultsConfig;
  source: "file" | "missing";
  warnings: string[];
}

interface Candidate {
  value: string | undefined;
  source: SpecKeeperConfigSource;
}

function resolveFromCwd(cwd: string, filename: string): string {
  return isAbsolute(filename) ? filename : resolve(cwd, filename);
}

/**
 * Read a non-empty string from the recognized keys, warning on wrong types.
 * Empty/whitespace values are treated as absent for this layer so a blank
 * first alias does not shadow a later valid alias or a lower-precedence layer.
 */
function readString(
  record: Record<string, unknown>,
  keys: string[],
  warnings: string[],
  fieldLabel: string,
): string | undefined {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (value !== undefined && value !== null) {
      warnings.push(
        `Spec Keeper .spec-keeper has an invalid '${fieldLabel}' value; ignoring it.`,
      );
    }
  }
  return undefined;
}

/**
 * Read a nested object from the recognized keys, warning on wrong types.
 * Null and non-object values do not shadow later aliases or lower layers.
 */
function readObject(
  record: Record<string, unknown>,
  keys: string[],
  warnings: string[],
  fieldLabel: string,
): Record<string, unknown> | undefined {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (value !== undefined && value !== null) {
      warnings.push(
        `Spec Keeper .spec-keeper has an invalid '${fieldLabel}' value; ignoring it.`,
      );
    }
  }
  return undefined;
}

function normalizeEpicDefaults(
  value: Record<string, unknown>,
  warnings: string[],
): SpecKeeperEpicDefaults {
  return {
    key: readString(value, ["key", "epicKey", "epic_key"], warnings, "defaultEpic.key"),
    title: readString(value, ["title"], warnings, "defaultEpic.title"),
    description: readString(value, ["description"], warnings, "defaultEpic.description"),
    status: readString(value, ["status"], warnings, "defaultEpic.status"),
  };
}

function normalizeTaskDefaults(
  value: Record<string, unknown>,
  warnings: string[],
): SpecKeeperTaskDefaults {
  return {
    key: readString(value, ["key", "taskKey", "task_key"], warnings, "defaultTask.key"),
    epicKey: readString(value, ["epicKey", "epic_key"], warnings, "defaultTask.epicKey"),
    keyPrefix: readString(value, ["keyPrefix", "key_prefix"], warnings, "defaultTask.keyPrefix"),
    title: readString(value, ["title"], warnings, "defaultTask.title"),
    description: readString(value, ["description"], warnings, "defaultTask.description"),
    status: readString(value, ["status"], warnings, "defaultTask.status"),
  };
}

function normalizeDefaultsConfig(
  raw: Record<string, unknown>,
  warnings: string[],
): SpecKeeperDefaultsConfig {
  const config: SpecKeeperDefaultsConfig = {
    projectSlug: readString(
      raw,
      ["projectSlug", "project_slug", "project", "Project"],
      warnings,
      "projectSlug",
    ),
    apiBase: readString(
      raw,
      ["apiBase", "api_base", "API base", "API Base"],
      warnings,
      "apiBase",
    ),
    credentialStore: readString(
      raw,
      ["credentialStore", "credential_store", "credential store", "configPath"],
      warnings,
      "credentialStore",
    ),
  };

  const epic = readObject(raw, ["defaultEpic", "default_epic"], warnings, "defaultEpic");
  if (epic) config.defaultEpic = normalizeEpicDefaults(epic, warnings);

  const task = readObject(raw, ["defaultTask", "default_task"], warnings, "defaultTask");
  if (task) config.defaultTask = normalizeTaskDefaults(task, warnings);

  return config;
}

/** Parse and normalize only the local `.spec-keeper` file. */
export function loadSpecKeeperDefaultsFile(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): LoadedDefaultsFile {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const override = env.SPEC_KEEPER_DEFAULTS_PATH?.trim();
  const filename = override
    ? resolveFromCwd(cwd, override)
    : join(cwd, DEFAULTS_FILE_NAME);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, source: "missing", warnings: [] };
    }
    const reason =
      error instanceof SyntaxError
        ? "it is not valid JSON"
        : "it could not be read";
    return {
      config: {},
      source: "file",
      warnings: [
        `Spec Keeper .spec-keeper is invalid: ${reason}. Using environment and built-in defaults.`,
      ],
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      config: {},
      source: "file",
      warnings: [
        "Spec Keeper .spec-keeper is invalid: the top-level value must be a JSON object. Using environment and built-in defaults.",
      ],
    };
  }

  const warnings: string[] = [];
  return {
    config: normalizeDefaultsConfig(raw as Record<string, unknown>, warnings),
    source: "file",
    warnings,
  };
}

/** Read only the operational fields from the secret store for deprecated fallback. */
function readSecretStoreOperationalDefaults(
  credentialStore: string,
  cwd: string,
): { projectSlug?: string; apiBase?: string; warning?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolveFromCwd(cwd, credentialStore), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      warning:
        "Spec Keeper secret store could not be read for compatibility defaults; using built-in defaults.",
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      warning:
        "Spec Keeper secret store is not a JSON object; using built-in defaults.",
    };
  }

  const record = raw as Record<string, unknown>;
  const warnings: string[] = [];
  return {
    projectSlug: readString(
      record,
      ["projectSlug", "project_slug", "Project", "project"],
      warnings,
      "projectSlug",
    ),
    apiBase: readString(
      record,
      ["apiBase", "api_base", "API base", "API Base"],
      warnings,
      "apiBase",
    ),
    warning: warnings[0],
  };
}

/** Pick the first non-empty candidate and report the winning source. */
function pickFirst(candidates: Candidate[]): { value: string | undefined; source: SpecKeeperConfigSource } {
  for (const candidate of candidates) {
    const value = typeof candidate.value === "string" ? candidate.value.trim() : "";
    if (value) return { value, source: candidate.source };
  }
  const last = candidates[candidates.length - 1];
  return { value: undefined, source: last?.source ?? "builtin" };
}

/**
 * Resolve Spec Keeper operational defaults from every layer.
 *
 * Explicit per-call arguments win, then `.spec-keeper`, then environment, then
 * the deprecated secret-store operational fields, then the built-in prompt
 * fallback. Credentials are intentionally NOT resolved here; the SpecKeeper
 * client continues to read credentials from the resolved credential store.
 */
export function resolveSpecKeeperDefaults(
  explicit?: Partial<SpecKeeperDefaultsInput>,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ResolvedSpecKeeperDefaults {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const file = loadSpecKeeperDefaultsFile(options);
  const warnings = [...file.warnings];
  const fileConfig = file.config;

  const explicitValue = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  const credentialStorePick = pickFirst([
    { value: fileConfig.credentialStore, source: "spec-keeper" },
    { value: env.SPEC_KEEPER_CONFIG_PATH, source: "environment" },
    { value: BUILTIN_CREDENTIAL_STORE, source: "builtin" },
  ]);
  const credentialStore = credentialStorePick.value ?? BUILTIN_CREDENTIAL_STORE;

  let secretCompat:
    | { projectSlug?: string; apiBase?: string; warning?: string }
    | undefined;
  const getSecretCompat = () => {
    if (!secretCompat) {
      secretCompat = readSecretStoreOperationalDefaults(credentialStore, cwd);
      if (secretCompat.warning) warnings.push(secretCompat.warning);
    }
    return secretCompat;
  };

  const higherProjectSlug = pickFirst([
    { value: explicitValue(explicit?.projectSlug), source: "argument" },
    { value: fileConfig.projectSlug, source: "spec-keeper" },
    { value: env.SPEC_KEEPER_PROJECT_SLUG, source: "environment" },
  ]);
  let projectSlugPick = higherProjectSlug;
  if (projectSlugPick.value === undefined) {
    const compat = getSecretCompat();
    projectSlugPick = compat.projectSlug
      ? { value: compat.projectSlug, source: "secret-store" }
      : { value: BUILTIN_PROJECT_SLUG, source: "builtin" };
  }

  const higherApiBase = pickFirst([
    { value: explicitValue(explicit?.apiBase), source: "argument" },
    { value: fileConfig.apiBase, source: "spec-keeper" },
    { value: env.SPEC_KEEPER_API_BASE, source: "environment" },
  ]);
  let apiBasePick = higherApiBase;
  if (apiBasePick.value === undefined) {
    const compat = getSecretCompat();
    apiBasePick = compat.apiBase
      ? { value: compat.apiBase, source: "secret-store" }
      : { value: BUILTIN_API_BASE, source: "builtin" };
  }

  const apiBase = (apiBasePick.value ?? BUILTIN_API_BASE).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(apiBase)) {
    throw new Error(
      `Spec Keeper apiBase must start with http:// or https:// (resolved from ${apiBasePick.source}).`,
    );
  }

  return {
    projectSlug: projectSlugPick.value?.trim(),
    apiBase,
    credentialStore,
    defaultEpic: fileConfig.defaultEpic,
    defaultTask: fileConfig.defaultTask,
    sources: {
      projectSlug: projectSlugPick.source,
      apiBase: apiBasePick.source,
      credentialStore: credentialStorePick.source,
    },
    warnings,
  };
}

/**
 * Return an API base suitable for verification logging. Embedded URL userinfo
 * (username/password) is replaced so a misconfigured apiBase never leaks
 * credentials into logs.
 */
export function redactUrlCredentialsForLogging(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "REDACTED";
    if (url.password) url.password = "REDACTED";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/(https?:\/\/)([^/@\s]+)@/gi, "$1[REDACTED]@");
  }
}

/**
 * One-line, secret-safe summary of resolved Spec Keeper defaults for logs.
 * Reports the winning value and source for each operational field without
 * including credential-store contents or embedded URL credentials.
 */
export function describeSpecKeeperDefaults(
  defaults: ResolvedSpecKeeperDefaults,
): string {
  return (
    `projectSlug=${defaults.projectSlug ?? "(none)"} (source: ${defaults.sources.projectSlug}), ` +
    `apiBase=${redactUrlCredentialsForLogging(defaults.apiBase)} (source: ${defaults.sources.apiBase}), ` +
    `credentialStore=${defaults.credentialStore} (source: ${defaults.sources.credentialStore})`
  );
}
