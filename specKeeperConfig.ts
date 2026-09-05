import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

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
    const code = (error as NodeJS.ErrnoException).code;
    // After migration `.spec-keeper` is a directory, not the legacy file. Treat
    // it as "missing" so startup does not report a spurious read error.
    if (code === "ENOENT" || code === "EISDIR") {
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

/**
 * New workspace registry layout (`.spec-keeper/config`).
 *
 * The `.spec-keeper/config` file is a JSON object keyed by canonical absolute
 * start directory. Each value carries only non-secret routing metadata for
 * that workspace:
 *
 * - `projectSlug`: URL-safe project slug for project-scoped routes.
 * - `credentialFile`: path to the workspace's credential file (owner-only
 *   permissions), resolved relative to the workspace start directory when
 *   loaded.
 * - `apiBase` (optional): API origin override for this workspace.
 *
 * Lookup is fail-closed and keyed by the canonical start directory: the caller
 * canonicalizes its start directory with
 * {@link canonicalizeSpecKeeperStartDirectory}, then looks it up in the
 * registry. When no mapping exists, the lookup throws an actionable error that
 * lists the configured workspaces instead of searching for credential files
 * implicitly.
 */

export const SPEC_KEEPER_WORKSPACE_DIR = ".spec-keeper";
export const SPEC_KEEPER_WORKSPACE_CONFIG_FILE = "config";

/** Non-secret routing metadata for one configured workspace. */
export interface SpecKeeperWorkspaceConfig {
  /** URL-safe project slug for project-scoped Spec Keeper routes. */
  projectSlug: string;
  /** Path to the workspace credential file, relative to the start directory unless absolute. */
  credentialFile: string;
  /** Optional API origin override for this workspace. */
  apiBase?: string;
  /** Optional epic defaults carried over from the legacy `.spec-keeper` file. */
  defaultEpic?: SpecKeeperEpicDefaults;
  /** Optional task defaults carried over from the legacy `.spec-keeper` file. */
  defaultTask?: SpecKeeperTaskDefaults;
}

/** `.spec-keeper/config` keyed by canonical absolute start directory. */
export type SpecKeeperWorkspaceRegistry = Record<string, SpecKeeperWorkspaceConfig>;

export interface LoadedSpecKeeperWorkspaceRegistry {
  registry: SpecKeeperWorkspaceRegistry;
  source: "file" | "missing";
  /** Absolute path of the `.spec-keeper/config` file that was read (or would be read). */
  path: string;
  warnings: string[];
}

export interface ResolvedSpecKeeperWorkspace {
  /** Canonical absolute start-directory key that matched the registry. */
  startDirectory: string;
  config: SpecKeeperWorkspaceConfig;
  /** Absolute path of the `.spec-keeper/config` file that supplied the mapping. */
  configPath: string;
  warnings: string[];
}

/**
 * Directory containing the agent's `main.ts` entry module, derived from this
 * module's own compiled location (`__dirname`) rather than `process.cwd()` so
 * the `.spec-keeper/config` registry has a stable home even when the process is
 * started from a different directory.
 *
 * The search starts at this module's directory and walks upward for a directory
 * containing `main.ts` (the agent's source entry). This locates the same source
 * root whether the runtime executes TypeScript directly or the compiled
 * `dist/main.js`. When no ancestor contains `main.ts` (for example a bare
 * deployment that ships only compiled output), the module directory itself is
 * used as a safe fallback so the resolved path is always non-empty and stable.
 */
export function specKeeperMainDirectory(): string {
  const moduleDir = __dirname;
  const filesystemRoot = parse(moduleDir).root;
  let dir = moduleDir;
  const seen = new Set<string>();
  while (dir && dir !== filesystemRoot && !seen.has(dir)) {
    seen.add(dir);
    if (existsSync(join(dir, "main.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (existsSync(join(filesystemRoot, "main.ts"))) return filesystemRoot;
  return moduleDir;
}

/**
 * Absolute path of the `.spec-keeper/config` registry.
 *
 * The default base directory is the directory containing `main.ts` (see
 * {@link specKeeperMainDirectory}) so the registry location no longer depends
 * on the process working directory. An explicit base directory can be supplied
 * for tooling, tests, and non-standard deployments.
 */
export function specKeeperWorkspaceConfigPath(startDirectory?: string): string {
  return join(
    startDirectory ?? specKeeperMainDirectory(),
    SPEC_KEEPER_WORKSPACE_DIR,
    SPEC_KEEPER_WORKSPACE_CONFIG_FILE,
  );
}

/**
 * Canonicalize a workspace start directory for registry lookups. The path is
 * first resolved to an absolute path, then symlink-resolved with
 * `fs.realpathSync` (matching the runtime's own canonicalization) so aliases
 * such as `/home` -> `/mnt/sdb4` compare equal. When realpath cannot resolve
 * the path (it does not exist yet), the resolved absolute path is returned so
 * lookups stay deterministic.
 */
export function canonicalizeSpecKeeperStartDirectory(startDirectory: string): string {
  const trimmed = (startDirectory ?? "").trim();
  if (!trimmed) {
    throw new Error("Spec Keeper requires a non-empty workspace start directory.");
  }
  const absolute = resolve(trimmed);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Read one non-empty string field from a workspace entry with registry-specific warnings. */
function readWorkspaceField(
  record: Record<string, unknown>,
  keys: string[],
  fieldLabel: string,
  workspaceKey: string,
  warnings: string[],
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
        `Spec Keeper .spec-keeper/config entry for '${workspaceKey}' has an invalid '${fieldLabel}' value; ignoring it.`,
      );
    }
  }
  return undefined;
}

/** Read a nested object field from a workspace entry with registry-specific warnings. */
function readWorkspaceObject(
  record: Record<string, unknown>,
  keys: string[],
  fieldLabel: string,
  workspaceKey: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (value !== undefined && value !== null) {
      warnings.push(
        `Spec Keeper .spec-keeper/config entry for '${workspaceKey}' has an invalid '${fieldLabel}' value; ignoring it.`,
      );
    }
  }
  return undefined;
}

function normalizeWorkspaceEpicDefaults(
  value: Record<string, unknown>,
  workspaceKey: string,
  warnings: string[],
): SpecKeeperEpicDefaults {
  return {
    key: readWorkspaceField(value, ["key", "epicKey", "epic_key"], "defaultEpic.key", workspaceKey, warnings),
    title: readWorkspaceField(value, ["title"], "defaultEpic.title", workspaceKey, warnings),
    description: readWorkspaceField(value, ["description"], "defaultEpic.description", workspaceKey, warnings),
    status: readWorkspaceField(value, ["status"], "defaultEpic.status", workspaceKey, warnings),
  };
}

function normalizeWorkspaceTaskDefaults(
  value: Record<string, unknown>,
  workspaceKey: string,
  warnings: string[],
): SpecKeeperTaskDefaults {
  return {
    key: readWorkspaceField(value, ["key", "taskKey", "task_key"], "defaultTask.key", workspaceKey, warnings),
    epicKey: readWorkspaceField(value, ["epicKey", "epic_key"], "defaultTask.epicKey", workspaceKey, warnings),
    keyPrefix: readWorkspaceField(value, ["keyPrefix", "key_prefix"], "defaultTask.keyPrefix", workspaceKey, warnings),
    title: readWorkspaceField(value, ["title"], "defaultTask.title", workspaceKey, warnings),
    description: readWorkspaceField(value, ["description"], "defaultTask.description", workspaceKey, warnings),
    status: readWorkspaceField(value, ["status"], "defaultTask.status", workspaceKey, warnings),
  };
}

interface NormalizedSpecKeeperWorkspaceEntry {
  key: string;
  config: SpecKeeperWorkspaceConfig;
}

/**
 * Normalize one `.spec-keeper/config` entry. Invalid entries (non-absolute
 * keys, non-object values, or missing required projectSlug/credentialFile) are
 * skipped with a warning so a single malformed entry never breaks the whole
 * registry.
 */
function normalizeSpecKeeperWorkspaceEntry(
  key: string,
  raw: unknown,
  warnings: string[],
): NormalizedSpecKeeperWorkspaceEntry | undefined {
  if (!isAbsolute(key)) {
    warnings.push(
      `Spec Keeper .spec-keeper/config has an invalid workspace key '${key}'; keys must be absolute start-directory paths. Ignoring it.`,
    );
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(
      `Spec Keeper .spec-keeper/config entry for '${key}' is invalid; expected a JSON object. Ignoring it.`,
    );
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const projectSlug = readWorkspaceField(
    record,
    ["projectSlug", "project_slug", "project", "Project"],
    "projectSlug",
    key,
    warnings,
  );
  const credentialFile = readWorkspaceField(
    record,
    ["credentialFile", "credential_file", "credentialStore", "credential_store", "credential store"],
    "credentialFile",
    key,
    warnings,
  );
  if (!projectSlug || !credentialFile) {
    warnings.push(
      `Spec Keeper .spec-keeper/config entry for '${key}' is missing projectSlug or credentialFile; ignoring it.`,
    );
    return undefined;
  }

  const config: SpecKeeperWorkspaceConfig = { projectSlug, credentialFile };
  const apiBase = readWorkspaceField(
    record,
    ["apiBase", "api_base", "API base", "API Base"],
    "apiBase",
    key,
    warnings,
  );
  if (apiBase) config.apiBase = apiBase;

  const epic = readWorkspaceObject(
    record,
    ["defaultEpic", "default_epic"],
    "defaultEpic",
    key,
    warnings,
  );
  if (epic) config.defaultEpic = normalizeWorkspaceEpicDefaults(epic, key, warnings);

  const task = readWorkspaceObject(
    record,
    ["defaultTask", "default_task"],
    "defaultTask",
    key,
    warnings,
  );
  if (task) config.defaultTask = normalizeWorkspaceTaskDefaults(task, key, warnings);

  return { key: canonicalizeSpecKeeperStartDirectory(key), config };
}

/** Parse and normalize the `.spec-keeper/config` workspace registry. */
export function loadSpecKeeperWorkspaceRegistry(options?: {
  startDirectory?: string;
  /** Explicit base directory for `.spec-keeper/config`; defaults to the main.ts directory. */
  configDirectory?: string;
}): LoadedSpecKeeperWorkspaceRegistry {
  const startDirectory = canonicalizeSpecKeeperStartDirectory(
    options?.startDirectory ?? process.cwd(),
  );
  const configDirectory = options?.configDirectory
    ? resolve(options.configDirectory)
    : undefined;
  const filename = specKeeperWorkspaceConfigPath(configDirectory);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { registry: {}, source: "missing", path: filename, warnings: [] };
    }
    const reason =
      error instanceof SyntaxError ? "it is not valid JSON" : "it could not be read";
    return {
      registry: {},
      source: "file",
      path: filename,
      warnings: [
        `Spec Keeper .spec-keeper/config is invalid: ${reason}. No workspace mappings were loaded.`,
      ],
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      registry: {},
      source: "file",
      path: filename,
      warnings: [
        "Spec Keeper .spec-keeper/config is invalid: the top-level value must be a JSON object. No workspace mappings were loaded.",
      ],
    };
  }

  const warnings: string[] = [];
  const registry: SpecKeeperWorkspaceRegistry = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = normalizeSpecKeeperWorkspaceEntry(key, value, warnings);
    if (entry) registry[entry.key] = entry.config;
  }
  return { registry, source: "file", path: filename, warnings };
}

/**
 * Resolve the Spec Keeper workspace mapping for a start directory.
 *
 * The start directory is canonicalized (absolute-path resolution plus
 * symlink-resolution) before lookup into `.spec-keeper/config`. When the
 * canonical start directory has no mapping, this throws an actionable error
 * listing the configured workspaces. It never searches for credential files
 * implicitly: callers must resolve a workspace mapping before loading any
 * credential file.
 */
export function resolveSpecKeeperWorkspace(
  startDirectory?: string,
  options?: { configDirectory?: string },
): ResolvedSpecKeeperWorkspace {
  const canonicalStart = canonicalizeSpecKeeperStartDirectory(
    startDirectory ?? process.cwd(),
  );
  const loaded = loadSpecKeeperWorkspaceRegistry({
    startDirectory: canonicalStart,
    configDirectory: options?.configDirectory,
  });
  const config = loaded.registry[canonicalStart];
  if (config) {
    return {
      startDirectory: canonicalStart,
      config,
      configPath: loaded.path,
      warnings: loaded.warnings,
    };
  }

  const configured = Object.keys(loaded.registry).sort();
  const details = [...loaded.warnings];
  if (configured.length) {
    details.push(
      `Configured workspaces:\n${configured.map((workspace) => `  - ${workspace}`).join("\n")}`,
    );
  } else if (loaded.source === "missing") {
    details.push(`No .spec-keeper/config was found at ${loaded.path}.`);
  }

  throw new Error(
    `Spec Keeper has no workspace mapping for start directory '${canonicalStart}'.` +
      (details.length ? `\n${details.join("\n")}` : "") +
      `\nCreate or update ${loaded.path} with an entry keyed by this start directory (projectSlug and credentialFile), or run SpecKeeperEnroll/migration to create the mapping.`,
  );
}

/** Owner-only mode used for workspace credential files. */
export const SPEC_KEEPER_CREDENTIAL_FILE_MODE = 0o600;
/** Non-secret mode used for the `.spec-keeper/config` registry. */
export const SPEC_KEEPER_WORKSPACE_CONFIG_MODE = 0o644;

/** Resolve a workspace `credentialFile` to an absolute path relative to the canonical start directory. */
export function resolveSpecKeeperCredentialFile(
  startDirectory: string,
  credentialFile: string,
): string {
  return isAbsolute(credentialFile) ? credentialFile : resolve(startDirectory, credentialFile);
}

/**
 * Ensure `.spec-keeper` exists as a directory. A legacy `.spec-keeper` file
 * blocks the new layout and must be migrated (not silently deleted) first.
 */
export function ensureSpecKeeperWorkspaceDir(specDir: string): void {
  let existing: Stats | undefined;
  try {
    existing = statSync(specDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Spec Keeper could not inspect '${specDir}'.`, { cause: error });
    }
  }

  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(
        `Spec Keeper cannot write under '${specDir}' because a file already exists there. Migrate the legacy .spec-keeper file first (or move it aside).`,
      );
    }
    return;
  }

  try {
    mkdirSync(specDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      let rechecked: Stats | undefined;
      try {
        rechecked = statSync(specDir);
      } catch {
        rechecked = undefined;
      }
      if (rechecked?.isDirectory()) return;
      throw new Error(
        `Spec Keeper cannot write under '${specDir}' because a file already exists there. Migrate the legacy .spec-keeper file first (or move it aside).`,
      );
    }
    throw new Error(`Spec Keeper could not create '${specDir}'.`, { cause: error });
  }
}

/** Write a workspace credential file and enforce owner-only permissions on POSIX. */
export function writeSpecKeeperCredentialFile(
  credentialFile: string,
  record: Record<string, unknown>,
): void {
  writeFileSync(credentialFile, `${JSON.stringify(record, null, 2)}\n`, {
    mode: SPEC_KEEPER_CREDENTIAL_FILE_MODE,
  });
  if (process.platform !== "win32") {
    chmodSync(credentialFile, SPEC_KEEPER_CREDENTIAL_FILE_MODE);
  }
}

/**
 * Upsert one workspace entry into `.spec-keeper/config`. Existing entries are
 * preserved; a missing file (or its parent `.spec-keeper` directory) is
 * created, while a malformed or non-object file is refused rather than
 * overwritten.
 */
export function upsertSpecKeeperWorkspaceConfig(
  configPath: string,
  canonicalStart: string,
  entry: SpecKeeperWorkspaceConfig,
): void {
  // The shared registry may live under the main.ts directory (or an explicit
  // configDirectory override) whose `.spec-keeper` directory does not exist
  // yet; create it (owner-only) before reading or writing the config file.
  ensureSpecKeeperWorkspaceDir(dirname(configPath));

  let registry: SpecKeeperWorkspaceRegistry = {};
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Spec Keeper could not read '${configPath}'.`, { cause: error });
    }
  }

  if (existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error(
        `Spec Keeper refuses to overwrite malformed '${configPath}'. Fix or remove it before continuing.`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `Spec Keeper refuses to overwrite invalid '${configPath}'; the top-level value must be a JSON object.`,
      );
    }
    registry = parsed as SpecKeeperWorkspaceRegistry;
  }

  registry[canonicalStart] = entry;
  writeFileSync(configPath, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: SPEC_KEEPER_WORKSPACE_CONFIG_MODE,
  });
}

/**
 * Remove one workspace entry from `.spec-keeper/config`. A missing file or an
 * already-absent entry is a no-op, while a malformed or non-object file is
 * refused rather than modified. This is used by migration rollback so a failed
 * migration never leaves a half-written registry entry behind.
 */
export function removeSpecKeeperWorkspaceConfigEntry(
  configPath: string,
  canonicalStart: string,
): void {
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Spec Keeper could not read '${configPath}'.`, { cause: error });
  }

  if (!existing.trim()) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new Error(
      `Spec Keeper refuses to modify malformed '${configPath}'. Fix or remove it before continuing.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Spec Keeper refuses to modify invalid '${configPath}'; the top-level value must be a JSON object.`,
    );
  }

  const registry = parsed as SpecKeeperWorkspaceRegistry;
  if (!(canonicalStart in registry)) return;
  delete registry[canonicalStart];
  writeFileSync(configPath, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: SPEC_KEEPER_WORKSPACE_CONFIG_MODE,
  });
}

/** Combined runtime defaults: workspace routing plus legacy epic/task defaults. */
export interface ResolvedSpecKeeperRuntimeDefaults {
  /** URL-safe project slug from the workspace mapping (undefined when unconfigured). */
  projectSlug?: string;
  /** API base from the workspace mapping or the built-in fallback. */
  apiBase: string;
  /** Absolute path of the workspace credential file (undefined when unconfigured). */
  credentialFile?: string;
  defaultEpic?: SpecKeeperEpicDefaults;
  defaultTask?: SpecKeeperTaskDefaults;
  /** Resolved workspace mapping, or null when no mapping exists yet. */
  workspace: ResolvedSpecKeeperWorkspace | null;
  warnings: string[];
}

/**
 * Resolve Spec Keeper runtime defaults.
 *
 * The project slug and API base come from the `.spec-keeper/config` workspace
 * mapping (never from stale legacy `.spec-keeper` operational fields), while
 * `defaultEpic`/`defaultTask` come from the workspace entry when present or
 * the legacy `.spec-keeper` file while migration is still pending. When no
 * workspace mapping exists yet, this returns a fallback object with a null
 * workspace and an actionable warning so the run can proceed and Spec Keeper
 * calls fail closed only when actually attempted.
 */
export function resolveSpecKeeperRuntimeDefaults(options?: {
  startDirectory?: string;
  /** Explicit base directory for `.spec-keeper/config`; defaults to the main.ts directory. */
  configDirectory?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedSpecKeeperRuntimeDefaults {
  const startDirectory = options?.startDirectory ?? process.cwd();
  const env = options?.env ?? process.env;
  const legacy = loadSpecKeeperDefaultsFile({ cwd: startDirectory, env });
  const warnings = [...legacy.warnings];

  let workspace: ResolvedSpecKeeperWorkspace | null;
  try {
    workspace = resolveSpecKeeperWorkspace(startDirectory, {
      configDirectory: options?.configDirectory,
    });
    warnings.push(...workspace.warnings);
  } catch (error) {
    workspace = null;
    warnings.push(error instanceof Error ? error.message : String(error));
    return {
      projectSlug: undefined,
      apiBase: BUILTIN_API_BASE,
      credentialFile: undefined,
      defaultEpic: legacy.config.defaultEpic,
      defaultTask: legacy.config.defaultTask,
      workspace: null,
      warnings,
    };
  }

  const configuredApiBase = workspace.config.apiBase ?? BUILTIN_API_BASE;
  const apiBase = configuredApiBase.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(apiBase)) {
    throw new Error(
      "Spec Keeper apiBase must start with http:// or https:// (resolved from the workspace mapping).",
    );
  }

  return {
    projectSlug: workspace.config.projectSlug,
    apiBase,
    credentialFile: resolveSpecKeeperCredentialFile(
      workspace.startDirectory,
      workspace.config.credentialFile,
    ),
    defaultEpic: workspace.config.defaultEpic ?? legacy.config.defaultEpic,
    defaultTask: workspace.config.defaultTask ?? legacy.config.defaultTask,
    workspace,
    warnings,
  };
}

/** One-line, secret-safe summary of resolved runtime defaults for logs. */
export function describeSpecKeeperRuntimeDefaults(
  defaults: ResolvedSpecKeeperRuntimeDefaults,
): string {
  const workspace = defaults.workspace;
  const projectSlugSource = workspace ? "workspace" : "unconfigured";
  const apiBaseSource = workspace?.config.apiBase ? "workspace" : "builtin";
  const credentialFileSource = workspace ? "workspace" : "unconfigured";
  return (
    `projectSlug=${defaults.projectSlug ?? "(none)"} (source: ${projectSlugSource}), ` +
    `apiBase=${redactUrlCredentialsForLogging(defaults.apiBase)} (source: ${apiBaseSource}), ` +
    `credentialFile=${defaults.credentialFile ?? "(none)"} (source: ${credentialFileSource})`
  );
}
