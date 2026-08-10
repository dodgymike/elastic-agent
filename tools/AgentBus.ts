/**
 * Minimal authenticated Agent Bus client for coordination and status handoffs.
 *
 * Configure the deployment-specific endpoint and credential only through the
 * environment or individual call options; secrets are never persisted here.
 * The payload is deliberately transparent because Agent Bus deployments may
 * evolve their message schemas independently.
 */
export type AgentBusMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AgentBusOptions {
  /** Deployment API path, such as /api/v1/messages. */
  path: string;
  method?: AgentBusMethod;
  body?: unknown;
  /** Defaults to AGENT_BUS_BASE_URL. */
  baseUrl?: string;
  /** Defaults to AGENT_BUS_ACCESS_TOKEN. */
  accessToken?: string;
  /** Defaults to elastic-agent-agent-bus/1.0. */
  userAgent?: string;
}

export interface AgentBusResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Send a coordination message or retrieve an Agent Bus handoff/status feed.
 *
 * Use this to announce work before acting and to report verification results
 * afterwards. Callers must use the message schema published by their Agent Bus
 * deployment (for example recipient, topic, status, and handoff fields).
 */
export default async function agentBus(options: AgentBusOptions): Promise<AgentBusResult> {
  const baseUrl = options.baseUrl ?? process.env.AGENT_BUS_BASE_URL;
  const accessToken = options.accessToken ?? process.env.AGENT_BUS_ACCESS_TOKEN;
  if (!baseUrl?.trim()) throw new Error("Agent Bus needs AGENT_BUS_BASE_URL or options.baseUrl.");
  if (!accessToken?.trim()) throw new Error("Agent Bus needs AGENT_BUS_ACCESS_TOKEN or options.accessToken.");
  if (!options.path.startsWith("/")) throw new Error("Agent Bus path must begin with '/'.");

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
  };
}
