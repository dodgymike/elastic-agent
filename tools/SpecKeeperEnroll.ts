import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import {
  canonicalizeSpecKeeperStartDirectory,
  specKeeperWorkspaceConfigPath,
  SPEC_KEEPER_WORKSPACE_DIR,
  type SpecKeeperWorkspaceConfig,
  type SpecKeeperWorkspaceRegistry,
} from "../specKeeperConfig.js";

/**
 * Redeem a one-time Spec Keeper agent-enrollment token and persist the
 * returned credential recipe in the new workspace credential layout:
 *
 *   .spec-keeper/<project-slug>.json   (owner-only; never committed)
 *   .spec-keeper/config                (non-secret workspace mapping)
 *
 * The credential file holds the endpoint details and the one-time credential
 * set returned by the enrollment endpoint. The single-use enrollment token is
 * consumed by the redeem call and is never written to disk or logged.
 */
export interface SpecKeeperEnrollOptions {
  /** Token from the `#token=` fragment of a Spec Keeper enrollment URL. */
  token: string;
  /**
   * Project slug recorded in `.spec-keeper/config` and used to name the
   * credential file. Defaults to the enrollment recipe's `project_slug`.
   */
  projectSlug?: string;
  /**
   * Workspace start directory that keys the `.spec-keeper/config` entry and
   * owns the written credential file. Defaults to the process working
   * directory.
   */
  startDirectory?: string;
}

export interface SpecKeeperEnrollment {
  username: string;
  password: string;
  api_base: string;
  project_slug: string;
  role: string;
  region?: string;
  client_id?: string;
  recipe: Record<string, string>;
}

export interface SpecKeeperEnrollWorkspace {
  /** Canonical absolute start-directory key recorded in `.spec-keeper/config`. */
  startDirectory: string;
  /** Project slug used for the workspace mapping. */
  projectSlug: string;
  /** Absolute path of the written credential file. */
  credentialFile: string;
  /** Absolute path of the updated `.spec-keeper/config`. */
  configPath: string;
}

/** The enrollment recipe plus the workspace metadata that was persisted. */
export interface SpecKeeperEnrollmentResult extends SpecKeeperEnrollment {
  workspace: SpecKeeperEnrollWorkspace;
}

const REDEEM_ENDPOINT =
  "https://api.spec.elasticninja.com/api/v1/agent-enrollments/redeem";
const PROJECT_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CREDENTIAL_FILE_MODE = 0o600;
const MAX_ERROR_DIAGNOSTIC_LENGTH = 512;
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|token|password|secret|credential|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token)/i;

/** Recursively redact secret-shaped keys from an enrollment error payload. */
function redactEnrollmentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactEnrollmentValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactEnrollmentValue(item),
      ]),
    );
  }
  return value;
}

/** Bound and redact an enrollment error body before it enters an Error message. */
function redactEnrollmentErrorBody(text: string): string {
  if (!text) return text;
  let diagnostic = text;
  try {
    diagnostic = JSON.stringify(redactEnrollmentValue(JSON.parse(text)));
  } catch {
    // Non-JSON error body: redact common credential forms and keep it bounded.
    diagnostic = text
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED AUTHORIZATION]")
      .replace(
        /(\b(?:access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key|credential|authorization|token)\b\s*[:=]\s*)[^\s,;]+/gi,
        "$1[REDACTED]",
      );
  }
  if (diagnostic.length > MAX_ERROR_DIAGNOSTIC_LENGTH) {
    return `${diagnostic.slice(0, MAX_ERROR_DIAGNOSTIC_LENGTH)}…`;
  }
  return diagnostic;
}

/**
 * Parse and validate the enrollment response. Missing or malformed required
 * fields fail closed without ever including their values in diagnostics.
 */
function parseEnrollment(text: string): SpecKeeperEnrollment {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Spec Keeper enrollment returned an invalid response.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Spec Keeper enrollment returned an invalid response.");
  }

  const record = raw as Record<string, unknown>;
  const str = (key: string) => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const username = str("username");
  const password = str("password");
  const api_base = str("api_base") ?? str("apiBase");
  const project_slug = str("project_slug") ?? str("projectSlug");
  const role = str("role");
  const region = str("region");
  const client_id = str("client_id") ?? str("clientId");

  if (!username || !password || !api_base || !project_slug) {
    throw new Error(
      "Spec Keeper enrollment returned an incomplete recipe; expected username, password, api_base, and project_slug.",
    );
  }

  const recipe: Record<string, string> = {};
  const rawRecipe = record["recipe"];
  if (rawRecipe && typeof rawRecipe === "object" && !Array.isArray(rawRecipe)) {
    for (const [key, value] of Object.entries(rawRecipe as Record<string, unknown>)) {
      if (typeof value === "string") recipe[key] = value;
    }
  }

  return {
    username,
    password,
    api_base,
    project_slug,
    role: role ?? "",
    region,
    client_id,
    recipe,
  };
}

function resolveProjectSlug(
  explicit: string | undefined,
  recipeSlug: string | undefined,
): string {
  const value = (explicit?.trim() || recipeSlug?.trim() || "").trim();
  if (!value) {
    throw new Error(
      "Spec Keeper enrollment needs a project slug; pass projectSlug or ensure the enrollment recipe includes project_slug.",
    );
  }
  if (!PROJECT_SLUG_PATTERN.test(value)) {
    throw new Error("Spec Keeper projectSlug must be a URL-safe project slug.");
  }
  return value;
}

function resolveApiBase(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(
      "Spec Keeper enrollment api_base must start with http:// or https://.",
    );
  }
  return normalized;
}

/** Build the owner-only credential file contents without echoing secrets. */
function buildCredentialRecord(
  enrollment: SpecKeeperEnrollment,
  apiBase: string | undefined,
  projectSlug: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    username: enrollment.username,
    password: enrollment.password,
    api_base: apiBase ?? enrollment.api_base,
    project_slug: projectSlug,
    role: enrollment.role,
  };
  if (enrollment.region) record.region = enrollment.region;
  if (enrollment.client_id) record.client_id = enrollment.client_id;
  if (Object.keys(enrollment.recipe).length > 0) record.recipe = enrollment.recipe;
  return record;
}

/**
 * Ensure `.spec-keeper` exists as a directory. A legacy `.spec-keeper` file
 * blocks the new layout and must be migrated (not silently deleted) first.
 */
function ensureWorkspaceDir(specDir: string): void {
  let existing: Stats | undefined;
  try {
    existing = statSync(specDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Spec Keeper enrollment could not inspect '${specDir}'.`, {
        cause: error,
      });
    }
  }

  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(
        `Spec Keeper enrollment cannot write under '${specDir}' because a file already exists there. Migrate the legacy .spec-keeper file first (or move it aside).`,
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
        `Spec Keeper enrollment cannot write under '${specDir}' because a file already exists there. Migrate the legacy .spec-keeper file first (or move it aside).`,
      );
    }
    throw new Error(`Spec Keeper enrollment could not create '${specDir}'.`, {
      cause: error,
    });
  }
}

/** Write the credential file and enforce owner-only permissions on POSIX. */
function writeCredentialFile(
  credentialFile: string,
  record: Record<string, unknown>,
): void {
  writeFileSync(credentialFile, `${JSON.stringify(record, null, 2)}\n`, {
    mode: CREDENTIAL_FILE_MODE,
  });
  if (process.platform !== "win32") {
    chmodSync(credentialFile, CREDENTIAL_FILE_MODE);
  }
}

/**
 * Upsert the workspace entry into `.spec-keeper/config`. Existing entries are
 * preserved; a missing file is created, while a malformed or non-object file
 * is refused rather than overwritten.
 */
function upsertWorkspaceConfig(
  configPath: string,
  canonicalStart: string,
  entry: SpecKeeperWorkspaceConfig,
): void {
  let registry: SpecKeeperWorkspaceRegistry = {};
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Spec Keeper enrollment could not read '${configPath}'.`, {
        cause: error,
      });
    }
  }

  if (existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error(
        `Spec Keeper enrollment refuses to overwrite malformed '${configPath}'. Fix or remove it before enrolling.`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `Spec Keeper enrollment refuses to overwrite invalid '${configPath}'; the top-level value must be a JSON object.`,
      );
    }
    registry = parsed as SpecKeeperWorkspaceRegistry;
  }

  registry[canonicalStart] = entry;
  writeFileSync(configPath, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o644,
  });
}

/**
 * Redeem an enrollment token and persist the returned recipe in the workspace
 * credential layout. Credentials are written only to the owner-only
 * `.spec-keeper/<project-slug>.json` file; the single-use token and returned
 * secret values are never printed or logged.
 */
export default async function specKeeperEnroll(
  options: SpecKeeperEnrollOptions,
): Promise<SpecKeeperEnrollmentResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("SpecKeeperEnroll options must be an object.");
  }
  if (typeof options.token !== "string" || !options.token.trim()) {
    throw new Error("A non-empty Spec Keeper enrollment token is required.");
  }
  if (options.projectSlug !== undefined && typeof options.projectSlug !== "string") {
    throw new TypeError("projectSlug must be a string.");
  }
  if (
    options.startDirectory !== undefined &&
    typeof options.startDirectory !== "string"
  ) {
    throw new TypeError("startDirectory must be a string path.");
  }
  if (options.projectSlug !== undefined && /[\r\n\0]/.test(options.projectSlug)) {
    throw new TypeError("projectSlug must not contain control characters.");
  }
  if (
    options.startDirectory !== undefined &&
    /[\r\n\0]/.test(options.startDirectory)
  ) {
    throw new TypeError("startDirectory must not contain control characters.");
  }

  const response = await fetch(REDEEM_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: options.token.trim() }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Spec Keeper enrollment failed (${response.status}): ${redactEnrollmentErrorBody(body)}`,
    );
  }

  const enrollment = parseEnrollment(body);
  const projectSlug = resolveProjectSlug(options.projectSlug, enrollment.project_slug);
  const canonicalStart = canonicalizeSpecKeeperStartDirectory(
    options.startDirectory?.trim() || process.cwd(),
  );
  const apiBase = resolveApiBase(enrollment.api_base);

  const specDir = join(canonicalStart, SPEC_KEEPER_WORKSPACE_DIR);
  ensureWorkspaceDir(specDir);
  const credentialFileRelative = join(SPEC_KEEPER_WORKSPACE_DIR, `${projectSlug}.json`);
  const credentialFile = join(canonicalStart, credentialFileRelative);
  writeCredentialFile(
    credentialFile,
    buildCredentialRecord(enrollment, apiBase, projectSlug),
  );

  const configPath = specKeeperWorkspaceConfigPath(canonicalStart);
  const entry: SpecKeeperWorkspaceConfig = {
    projectSlug,
    credentialFile: credentialFileRelative,
  };
  if (apiBase) entry.apiBase = apiBase;
  upsertWorkspaceConfig(configPath, canonicalStart, entry);

  return {
    username: enrollment.username,
    password: enrollment.password,
    api_base: apiBase ?? enrollment.api_base,
    project_slug: enrollment.project_slug,
    role: enrollment.role,
    region: enrollment.region,
    client_id: enrollment.client_id,
    recipe: enrollment.recipe,
    workspace: {
      startDirectory: canonicalStart,
      projectSlug,
      credentialFile,
      configPath,
    },
  };
}
