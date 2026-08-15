/**
 * Minimal authenticated Agent Bus client for coordination and status handoffs.
 *
 * Configure the deployment-specific endpoint, agent identity, and credential
 * through environment variables, individual call options, or the local
 * non-secret `.agent-bus.local` roster written by `AgentBusEnrol`. Per-call
 * options win, then environment variables, then the local roster, so an
 * operator's secret manager can always override the enrolled defaults.
 *
 * SECURITY: `.agent-bus.local` carries only non-secret metadata (bus URL,
 * bus fingerprint, agent id, identity store path) under mode 0600. It never
 * holds secret material, so credentials must still come from the environment
 * or per-call options. This client never returns or logs secret material.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type AgentBusMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AgentBusOptions {
  /** Deployment API path, such as /api/v1/messages. */
  path: string;
  method?: AgentBusMethod;
  body?: unknown;
  /** Defaults to AGENT_BUS_BASE_URL, then the enrolled busUrl in .agent-bus.local. */
  baseUrl?: string;
  /** Defaults to AGENT_BUS_ACCESS_TOKEN (never stored in .agent-bus.local). */
  accessToken?: string;
  /** Agent identity (for example the enrolled agent id). Defaults to AGENT_BUS_AGENT_ID, then .agent-bus.local agentId. */
  identity?: string;
  /** Path to the .agent-bus.local roster. Defaults to AGENT_BUS_STORE or <cwd>/.agent-bus.local. */
  store?: string;
  /** Defaults to elastic-agent-agent-bus/1.0. */
  userAgent?: string;
}

export interface AgentBusResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  /** Resolved agent identity used for this call, when one was configured. */
  identity?: string;
  /** Source that provided the resolved base URL. */
  baseUrlSource?: "option" | "environment" | "store";
}

/** Non-secret fields this client reads from the enrolled `.agent-bus.local` roster. */
interface AgentBusLocalConfig {
  busUrl?: string;
  agentId?: string;
  /**
   * Path to the `agent-busctl` identity store that owns the bearer credential.
   * Read only to make the "missing access token" diagnostic actionable — the
   * token itself is NEVER read from this path (it is secret and owned by the
   * operator's secret manager).
   */
  identityStore?: string;
}

/** The default (non-secret) roster filename written by AgentBusEnrol. */
export const DEFAULT_STORE_FILENAME = ".agent-bus.local";

/**
 * Load the enrolled, non-secret roster from `.agent-bus.local`. Explicit call
 * options and environment variables always take precedence (resolved by the
 * caller). A missing store falls back gracefully to no defaults; a malformed
 * store is treated as "no defaults" rather than failing the bus call, so the
 * tool remains usable when operators configure everything via the environment.
 */
function loadAgentBusLocalConfig(storePath: string | undefined): AgentBusLocalConfig {
  const filename =
    storePath ?? process.env.AGENT_BUS_STORE ?? join(process.cwd(), DEFAULT_STORE_FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // A malformed roster must not block a request that has an explicit
    // endpoint/credential; fall back gracefully rather than exposing contents.
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const str = (k: string) => {
    const v = record[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  return {
    busUrl: str("busUrl") ?? str("bus_url") ?? str("bus"),
    agentId: str("agentId") ?? str("agent_id") ?? str("id"),
    identityStore: str("identityStore") ?? str("identity_store"),
  };
}

/** Resolve an absolute or repo-relative store path against the given root. */
function resolveStorePath(store: string | undefined, root: string): string | undefined {
  if (!store) return undefined;
  return isAbsolute(store) ? store : resolve(root, store);
}

/**
 * Send a coordination message or retrieve an Agent Bus handoff/status feed.
 *
 * Use this to announce work before acting and to report verification results
 * afterwards. Callers must use the message schema published by their Agent Bus
 * deployment (for example recipient, topic, status, and handoff fields).
 */
export default async function agentBus(options: AgentBusOptions): Promise<AgentBusResult> {
  const storePath = resolveStorePath(options.store, process.cwd());
  const local = loadAgentBusLocalConfig(storePath);

  const optionBase = options.baseUrl?.trim() || "";
  const envBase = process.env.AGENT_BUS_BASE_URL?.trim() || "";
  const baseUrl = optionBase || envBase || local.busUrl || undefined;
  const identity =
    options.identity?.trim() || process.env.AGENT_BUS_AGENT_ID?.trim() || local.agentId || undefined;
  const accessToken = options.accessToken ?? process.env.AGENT_BUS_ACCESS_TOKEN;
  if (!baseUrl?.trim()) {
    throw new Error(
      "Agent Bus needs options.baseUrl, AGENT_BUS_BASE_URL, or an enrolled busUrl in .agent-bus.local.",
    );
  }
  if (!accessToken?.trim()) {
    if (local.identityStore) {
      // Enrolled but missing the bearer credential: tell the operator exactly
      // where it must come from so the loop-mode warning is actionable. The
      // identity store is owned by agent-busctl and is never read here.
      throw new Error(
        "Agent Bus needs options.accessToken or AGENT_BUS_ACCESS_TOKEN. You are enrolled " +
          `(identity '${identity ?? "(unknown)"}', bus '${baseUrl}'); export the bearer credential ` +
          `from the identity store '${local.identityStore}' to the AGENT_BUS_ACCESS_TOKEN ` +
          "environment variable (or pass accessToken per call).",
      );
    }
    throw new Error("Agent Bus needs options.accessToken or AGENT_BUS_ACCESS_TOKEN.");
  }
  if (!options.path.startsWith("/")) throw new Error("Agent Bus path must begin with '/'.");

  const baseUrlSource: AgentBusResult["baseUrlSource"] = options.baseUrl?.trim()
    ? "option"
    : envBase
      ? "environment"
      : "store";

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${options.path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken.trim()}`,
      "User-Agent": options.userAgent ?? "elastic-agent-agent-bus/1.0",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Preserve non-JSON server diagnostics for the caller.
  }
  if (!response.ok) {
    throw new Error(`Agent Bus request failed (${response.status} ${response.statusText}): ${text}`);
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body,
    ...(identity ? { identity } : {}),
    baseUrlSource,
  };
}
