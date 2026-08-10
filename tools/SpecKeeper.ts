import { readFileSync } from "node:fs";
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
  /** Absolute Spec Keeper route, e.g. /tasks. Legacy /api/<route> aliases remain supported. */
  path: string;
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
}

/**
 * Load the enrolled agent credentials from the local, permission-restricted
 * secret store. Explicit call options and environment variables always take
 * precedence, so deployments can continue to use their normal secret manager.
 */
function loadSecretConfig(): SpecKeeperSecretConfig {
  const filename = process.env.SPEC_KEEPER_CONFIG_PATH ?? "/tmp/spec-keeper.json";
  try {
    const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as SpecKeeperSecretConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Do not expose a parsing error or file contents: this is a secret store.
    throw new Error("Spec Keeper could not load its local credential store.");
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
 * The hosted deployment exposes its project resources at the origin root.
 * Keep these aliases so callers built against the former /api/ assumption
 * continue to reach the discovered routes during the migration.
 */
const LEGACY_API_ROUTE_PREFIXES = [
  "/goals",
  "/epics",
  "/tasks",
  "/task-queue",
  "/dependencies",
  "/decisions",
  "/plans",
  "/procedures",
  "/handoffs",
] as const;

/** Validate an absolute route and map the former /api/<resource> aliases. */
export function resolveSpecKeeperPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("path must be an absolute Spec Keeper route beginning with '/'.");
  }
  if (/[\r\n\0]/.test(path)) {
    throw new Error("Spec Keeper path must not contain control characters.");
  }

  for (const prefix of LEGACY_API_ROUTE_PREFIXES) {
    const legacyPrefix = `/api${prefix}`;
    if (path === legacyPrefix || path.startsWith(`${legacyPrefix}/`) || path.startsWith(`${legacyPrefix}?`)) {
      return path.slice(4);
    }
  }
  return path;
}

interface CognitoAuthenticationResult {
  AccessToken?: string;
}

interface CognitoResponse {
  AuthenticationResult?: CognitoAuthenticationResult;
  message?: string;
}

/** Mint a short-lived Cognito access token without persisting credentials. */
async function getAccessToken(options: SpecKeeperOptions): Promise<string> {
  const config = loadSecretConfig();
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
  const response = await fetch(`https://cognito-idp.${region.trim()}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      // Unlike the Spec Keeper API, Cognito does not mandate a User-Agent, but
      // declare one explicitly for reliable proxy behavior.
      "User-Agent": options.userAgent ?? "elastic-agent-spec-keeper/1.1",
    },
    body: JSON.stringify({
      AuthFlow: authFlow,
      ClientId: clientId.trim(),
      AuthParameters: authParameters,
    }),
  });
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
  const {
    path,
    method = "GET",
    body,
    apiBase,
    userAgent = "elastic-agent-spec-keeper/1.1",
  } = options;
  const requestPath = resolveSpecKeeperPath(path);
  if (!userAgent.trim()) {
    throw new Error("Spec Keeper requires a non-empty User-Agent header.");
  }

  const accessToken = await getAccessToken(options);
  const configuredApiBase = apiBase ?? process.env.SPEC_KEEPER_API_BASE ?? loadSecretConfig().apiBase ?? "https://api.spec.elasticninja.com";
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${configuredApiBase.replace(/\/+$/, "")}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
    // Do not put an arbitrary API/proxy response in an exception. Besides being
    // noisy for callers, an upstream error can echo request-related details.
    throw new Error(`Spec Keeper request ${method} ${requestPath} failed (${response.status} ${response.statusText}).`);
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody,
  };
}
