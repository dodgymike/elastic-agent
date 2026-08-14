import { readFileSync } from "node:fs";
import { resolveSpecKeeperDefaults } from "../specKeeperConfig.js";
/**
 * Authenticated Spec Keeper client for goals, plans, decisions, and task state.
 *
 * Authentication is supplied at call time (or by environment variables), never
 * written to the repository.  It can use a short-lived access token directly,
 * refresh an expired session, or mint a Cognito access token from the enrolled
 * agent's username/password.  The latter two options make this tool usable for
 * autonomous task bookkeeping without embedding a secret in source.
 */
export type SpecKeeperMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface SpecKeeperOptions {
  /** Supported project resource route (for example /tasks) or an absolute /api/v1 route. */
  path: string;
  /** Project slug for resource routes. Defaults to SPEC_KEEPER_PROJECT_SLUG or enrolled configuration. */
  projectSlug?: string;
  /** HTTP method for the requested Spec Keeper endpoint. */
  method?: SpecKeeperMethod;
  /** JSON payload for POST, PUT, and PATCH calls. */
  body?: unknown;
  /** Short-lived bearer token. Defaults to SPEC_KEEPER_ACCESS_TOKEN. */
  accessToken?: string;
  /** Cognito refresh token. Defaults to SPEC_KEEPER_REFRESH_TOKEN. */
  refreshToken?: string;
  /** Enrolled Cognito username. Defaults to SPEC_KEEPER_USERNAME. */
  username?: string;
  /** Enrolled Cognito password. Defaults to SPEC_KEEPER_PASSWORD. */
  password?: string;
  /** Cognito app client ID. Defaults to SPEC_KEEPER_CLIENT_ID. */
  clientId?: string;
  /** Cognito region. Defaults to SPEC_KEEPER_REGION. */
  region?: string;
  /** API origin. Defaults to SPEC_KEEPER_API_BASE or hosted Spec Keeper. */
  apiBase?: string;
  /** Hosted API requires a non-default User-Agent header. */
  userAgent?: string;
}

interface SpecKeeperSecretConfig {
  accessToken?: string;
  refreshToken?: string;
  username?: string;
  password?: string;
  clientId?: string;
  region?: string;
  apiBase?: string;
  projectSlug?: string;
  project_slug?: string;
}

/**
 * Normalize the local credential store's field names to the camelCase keys the
 * client reads. The local secret store uses human-friendly keys (for example
 * "Username", "Password", "API base", "Region", "Client ID", "Project"), so map
 * those well-known variants to the canonical shape before use.
 */
function normalizeSecretConfig(raw: Record<string, unknown>): SpecKeeperSecretConfig {
  const value = (key: string) => {
    const v = raw[key];
    return typeof v === "string" ? v : undefined;
  };
  return {
    accessToken: value("accessToken") ?? value("Access Token") ?? value("AccessToken"),
    refreshToken: value("refreshToken") ?? value("Refresh Token") ?? value("RefreshToken"),
    username: value("username") ?? value("Username") ?? value("USERNAME"),
    password: value("password") ?? value("Password") ?? value("PASSWORD"),
    clientId: value("clientId") ?? value("Client ID") ?? value("ClientId") ?? value("client_id"),
    region: value("region") ?? value("Region") ?? value("REGION"),
    apiBase: value("apiBase") ?? value("API base") ?? value("API Base") ?? value("api_base"),
    projectSlug: value("projectSlug") ?? value("project_slug") ?? value("Project") ?? value("project"),
  };
}

/**
 * Load the enrolled agent credentials from the local, permission-restricted
 * secret store. Explicit call options and environment variables always take
 * precedence, so deployments can continue to use their normal secret manager.
 */
function loadSecretConfig(filename: string): SpecKeeperSecretConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return normalizeSecretConfig(value as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Do not expose a parsing error or file contents: this is a secret store.
    throw new Error("Spec Keeper could not load its local credential store.", { cause: error });
  }
}

export interface SpecKeeperResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Parsed JSON when possible; otherwise response text. */
  body: unknown;
}

/**
 * Project resources are served beneath /api/v1/projects/{slug}.  Keep this
 * list deliberately aligned with the documented service resources so obsolete
 * root routes (for example /goals or /task-queue) fail before a request.
 */
const PROJECT_RESOURCES = new Set([
  "agents", "epics", "tasks", "reservations", "counters", "locks", "import",
  "export", "events", "notes", "changes", "decisions", "chain-runs", "jira-config", "jira",
]);

const MAX_FAILURE_DIAGNOSTIC_LENGTH = 512;
const SENSITIVE_DIAGNOSTIC_KEY = /(?:authorization|token|password|secret|credential|api[-_]?key|cookie|session|access[_-]?key|refresh[_-]?token)/i;
const PROJECT_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate a resolved project slug before it is embedded in a project route. */
function validateProjectSlug(configured: string | undefined): string | undefined {
  if (configured === undefined) return undefined;
  const slug = configured.trim();
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new Error("Spec Keeper projectSlug must be a URL-safe project slug.");
  }
  return slug;
}

/**
 * Map a supported project resource to the versioned, project-scoped API.
 * Absolute /api/v1 paths are retained for project discovery and uncommon
 * documented endpoints; all resource shorthand requires an explicit slug.
 */
export function resolveSpecKeeperPath(path: string, projectSlug?: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("path must be an absolute Spec Keeper route beginning with '/'.");
  }
  if (/[\r\n\0]/.test(path)) {
    throw new Error("Spec Keeper path must not contain control characters.");
  }
  if (path.startsWith("/api/v1/")) return path;

  const [route, query = ""] = path.split("?", 2);
  const resource = route.slice(1).split("/", 1)[0];
  if (!PROJECT_RESOURCES.has(resource)) {
    throw new Error(`Unsupported Spec Keeper project resource '${resource}'. Use a documented /api/v1 route.`);
  }
  if (!projectSlug || !PROJECT_SLUG_PATTERN.test(projectSlug)) {
    throw new Error(
      "A URL-safe Spec Keeper projectSlug is required for project resource routes. Configure it in .spec-keeper (projectSlug), SPEC_KEEPER_PROJECT_SLUG, or restore the built-in default 'elastic-agent'.",
    );
  }
  return `/api/v1/projects/${projectSlug}${route}${query ? `?${query}` : ""}`;
}

/** Redact common secret-shaped values before reporting bounded API diagnostics. */
function redactFailureDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFailureDiagnostic);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_DIAGNOSTIC_KEY.test(key) ? "[REDACTED]" : redactFailureDiagnostic(item),
    ]));
  }
  return value;
}

/** Convert an API error body into a safe, short diagnostic suitable for an Error message. */
export function formatSpecKeeperFailureDiagnostic(text: string): string | undefined {
  if (!text) return undefined;

  let diagnostic = text;
  try {
    diagnostic = JSON.stringify(redactFailureDiagnostic(JSON.parse(text)));
  } catch {
    // Redact common credential forms from non-JSON proxy and service errors.
    diagnostic = text
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, "[REDACTED AUTHORIZATION]")
      .replace(/\b(((?:access|refresh)?_?token|password|secret|api[-_]?key|credential)\b\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
  }
  if (diagnostic.length > MAX_FAILURE_DIAGNOSTIC_LENGTH) {
    return `${diagnostic.slice(0, MAX_FAILURE_DIAGNOSTIC_LENGTH)}…`;
  }
  return diagnostic;
}

interface CognitoAuthenticationResult {
  AccessToken?: string;
}

interface CognitoResponse {
  AuthenticationResult?: CognitoAuthenticationResult;
  message?: string;
}

/** Mint a short-lived Cognito access token without persisting credentials. */
async function getAccessToken(
  options: SpecKeeperOptions,
  config: SpecKeeperSecretConfig,
  userAgent: string,
): Promise<string> {
  const suppliedToken = options.accessToken ?? process.env.SPEC_KEEPER_ACCESS_TOKEN ?? config.accessToken;
  if (suppliedToken?.trim()) return suppliedToken.trim();

  const region = options.region ?? process.env.SPEC_KEEPER_REGION ?? config.region;
  const clientId = options.clientId ?? process.env.SPEC_KEEPER_CLIENT_ID ?? config.clientId;
  const refreshToken = options.refreshToken ?? process.env.SPEC_KEEPER_REFRESH_TOKEN ?? config.refreshToken;
  const username = options.username ?? process.env.SPEC_KEEPER_USERNAME ?? config.username;
  const password = options.password ?? process.env.SPEC_KEEPER_PASSWORD ?? config.password;

  if (!region?.trim() || !clientId?.trim()) {
    throw new Error(
      "Spec Keeper needs SPEC_KEEPER_ACCESS_TOKEN, or SPEC_KEEPER_REGION and SPEC_KEEPER_CLIENT_ID plus refresh-token or username/password credentials.",
    );
  }
  if (!refreshToken?.trim() && (!username?.trim() || !password?.trim())) {
    throw new Error(
      "Spec Keeper needs an access token, a refresh token, or enrolled username and password. Store these only in the approved secret environment.",
    );
  }

  const authParameters: Record<string, string> = refreshToken?.trim()
    ? { REFRESH_TOKEN: refreshToken.trim() }
    : { USERNAME: username!.trim(), PASSWORD: password!.trim() };
  const authFlow = refreshToken?.trim() ? "REFRESH_TOKEN_AUTH" : "USER_PASSWORD_AUTH";
  let response: Response;
  try {
    response = await fetch(`https://cognito-idp.${region.trim()}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
        // Unlike the Spec Keeper API, Cognito does not mandate a User-Agent, but
        // declare one explicitly for reliable proxy behavior.
        "User-Agent": userAgent,
      },
      body: JSON.stringify({
        AuthFlow: authFlow,
        ClientId: clientId.trim(),
        AuthParameters: authParameters,
      }),
    });
  } catch (error) {
    throw new Error("Spec Keeper authentication request could not be sent.", { cause: error });
  }
  const text = await response.text();
  let payload: CognitoResponse = {};
  try {
    payload = JSON.parse(text) as CognitoResponse;
  } catch {
    // Avoid including the raw body: authentication responses may be sensitive.
  }
  const token = payload.AuthenticationResult?.AccessToken;
  if (!response.ok || !token) {
    throw new Error(`Spec Keeper authentication failed (${response.status} ${response.statusText}).`);
  }
  return token;
}

/**
 * Call an authenticated Spec Keeper endpoint.
 *
 * Call GET before work to retrieve the cloud project's current goals/task
 * state; create or patch the applicable task before and after an action. The
 * endpoint's JSON schema is intentionally passed through so this remains
 * compatible with evolving Spec Keeper project schemas.
 */
export default async function specKeeper(options: SpecKeeperOptions): Promise<SpecKeeperResult> {
  const defaults = resolveSpecKeeperDefaults(options);
  const {
    path,
    method = "GET",
    body,
  } = options;
  const userAgent = (
    options.userAgent ?? process.env.SPEC_KEEPER_USER_AGENT ?? "elastic-agent-spec-keeper/1.1"
  ).trim();
  if (!userAgent) {
    throw new Error("Spec Keeper requires a non-empty User-Agent header.");
  }

  const projectSlug = validateProjectSlug(defaults.projectSlug);
  const requestPath = resolveSpecKeeperPath(path, projectSlug);
  const configuredApiBase = defaults.apiBase;
  const secretConfig = loadSecretConfig(defaults.credentialStore);
  const accessToken = await getAccessToken(options, secretConfig, userAgent);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${configuredApiBase}${requestPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Spec Keeper request ${method} ${requestPath} could not be sent.`, { cause: error });
  }
  const text = await response.text();
  let responseBody: unknown = text;
  if (text) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      // An HTML proxy error or an empty response is still useful to callers.
    }
  }
  if (!response.ok) {
    const diagnostic = formatSpecKeeperFailureDiagnostic(text);
    const suffix = diagnostic ? `; diagnostics: ${diagnostic}` : "";
    throw new Error(`Spec Keeper request ${method} ${requestPath} failed (${response.status} ${response.statusText})${suffix}.`);
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody,
  };
}
