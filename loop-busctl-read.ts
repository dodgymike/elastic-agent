/**
 * loop-busctl-read.ts — loop-mode Agent Bus reads through the `agent-busctl`
 * CLI instead of a raw authenticated HTTP client.
 *
 * WHY: the loop-mode poll (`loopBusRead` in main.ts) previously went through
 * `tools/AgentBus.ts`, which required a bearer credential
 * (`options.accessToken` or `AGENT_BUS_ACCESS_TOKEN`) and threw
 * "Agent Bus needs options.accessToken or AGENT_BUS_ACCESS_TOKEN" at startup
 * when none was configured. That credential is not actually how this Agent Bus
 * authenticates: the real mechanism is the enrolled identity, held by
 * `agent-busctl` in a credential store and driven with `--bus` and `--identity`
 * (e.g. `./agent-busctl --bus https://127.0.0.1:18090 --identity
 * tmp/elastic-identity/ watch`). No access token is involved.
 *
 * This module is the "similar call": it shells out to `agent-busctl watch` with
 * the resolved bus URL and identity store, parses its NDJSON message stream
 * into the flat message array the loop-mode router expects, and never requires
 * (or reads) an `AGENT_BUS_ACCESS_TOKEN`.
 *
 * FAIL-SOFT: every transport/configuration failure is surfaced as an
 * `AgentBusMessageReadResult.error` string (never thrown through the poll), so
 * loop mode continues normal execution exactly as it did for an unreachable
 * bus. An empty watch (no messages arrived in the bounded window) is a normal
 * "nothing to do" outcome, not an error.
 *
 * SECURITY: only non-secret configuration (bus URL, identity store path, and
 * the `agent-busctl` binary path) is resolved from the environment / roster.
 * The CLI owns the secret credential and never exposes it to us; we never
 * read or log any token.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentBusMessageReadResult } from "./loop-poll.js";

/** Default roster filename written by AgentBusEnrol (.agent-bus.local). */
export const DEFAULT_STORE_FILENAME = ".agent-bus.local";

/** Environment variable that overrides the roster path. */
export const AGENT_BUS_STORE_ENV = "AGENT_BUS_STORE";

/** Environment variable that overrides the agent-busctl binary path. */
export const AGENT_BUSCTL_ENV = "AGENT_BUSCTL";

/** Non-secret fields read from the enrolled `.agent-bus.local` roster. */
export interface AgentBusLocalRoster {
  busUrl?: string;
  busFingerprint?: string;
  identityStore?: string;
}

/** A single `agent-busctl watch --json` NDJSON message record. */
export interface AgentBusCtlWatchRecord {
  message_id?: string;
  seq?: number | string;
  from?: string;
  broadcast?: boolean;
  to?: string | string[];
  bus_path?: string;
  sent_at?: string;
  size?: number;
  content_sha256?: string;
  body?: string;
  text?: string;
  [key: string]: unknown;
}

/** The `agent-busctl` sub-process decision returned by `watchAgentBus`. */
export interface AgentBusCtlInvocation {
  /** Absolute path to the `agent-busctl` binary that was invoked. */
  readonly binary: string;
  /** Resolved --bus URL. */
  readonly busUrl?: string;
  /** Resolved --identity store directory. */
  readonly identityStore?: string;
}

/**
 * How long one bounded `agent-busctl watch --for` window waits before the CLI
 * reports "empty". Kept small so a single poll at a step boundary never blocks
 * for a long stretch.
 */
export const DEFAULT_WATCH_WINDOW_MS = 600;

/** Resolve an absolute or repo-relative store path against the given root. */
function resolveStorePath(store: string | undefined, root: string): string {
  if (!store) return join(root, DEFAULT_STORE_FILENAME);
  return isAbsolute(store) ? store : resolve(root, store);
}

/**
 * Load the enrolled, non-secret roster. Accepts both camelCase and snake_case
 * keys. A missing/malformed store yields no defaults (never throws), so the
 * read still works when everything is provided via the environment.
 */
export function loadAgentBusRoster(storePath: string | undefined, root = process.cwd()): AgentBusLocalRoster {
  const filename = resolveStorePath(storePath, root);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const str = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = record[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };
  return {
    busUrl: str(["busUrl", "bus_url", "bus"]),
    busFingerprint: str(["busFingerprint", "bus_fingerprint", "bus_cert_fingerprint"]),
    identityStore: str(["identityStore", "identity_store"]),
  };
}

/**
 * Resolve the absolute `agent-busctl` binary path. Precedence: explicit
 * `AGENT_BUSCTL` env, then `<cwd>/agent-busctl`, then a `PATH` lookup. The
 * relative cwd path is made absolute so we spawn it from any working directory
 * (loop mode chdirs into a worktree).
 */
export function resolveAgentBusCtlBinary(
  explicit?: string,
  env: string | undefined = process.env[AGENT_BUSCTL_ENV],
  root = process.cwd(),
): string | undefined {
  const prefer = explicit?.trim() || env?.trim();
  if (prefer) return isAbsolute(prefer) ? prefer : resolve(root, prefer);
  const local = join(root, "agent-busctl");
  try {
    readFileSync(local);
    return local;
  } catch {
    // fall through to PATH lookup
  }
  return "agent-busctl"; // resolved by the OS against PATH
}

/**
 * Resolve the `--bus` URL and `--identity` store directory for the CLI call.
 * Environment wins, then the roster. Returns `undefined` for either field when
 * it cannot be resolved so the caller can produce an actionable diagnostic.
 */
export function resolveAgentBusCtlTargets(
  rosterStore?: string,
  root = process.cwd(),
): { busUrl?: string; identityStore?: string } {
  const roster = loadAgentBusRoster(rosterStore, root);
  const busUrl = process.env.AGENT_BUS_URL?.trim() || process.env.AGENT_BUS_BASE_URL?.trim() || roster.busUrl;
  const identityStore =
    process.env.AGENT_BUS_IDENTITY?.trim() ||
    (roster.identityStore ? resolve(process.cwd(), roster.identityStore) : undefined);
  return { busUrl, identityStore };
}

/**
 * Parse the NDJSON stdout of `agent-busctl watch --json` into message records,
 * filtering out the trailing failure object (`ok:false`) that the CLI emits as
 * its final line. Returns `{ messages, empty }` so callers can distinguish
 * "no messages" (empty) from a batch that returned records.
 */
export function parseAgentBusCtlWatchOutput(
  stdout: string,
): { messages: readonly AgentBusCtlWatchRecord[]; empty: boolean } {
  const messages: AgentBusCtlWatchRecord[] = [];
  let empty = false;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A non-JSON line from the CLI is treated as a transport diagnostic and
      // skipped; the message stream itself is strictly NDJSON.
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const obj = record as Record<string, unknown>;
    if (obj.ok === false) {
      // The bounded watch's closing failure object: an empty/no-message
      // outcome (exit_code 8 / kind "empty") means "nothing arrived", not an
      // error. Other failure kinds still yield an empty message list; the
      // transport error (if any) is surfaced by the exit code handling in the
      // caller.
      if (obj.kind === "empty" || obj.exit_code === 8) empty = true;
      continue;
    }
    messages.push(obj as AgentBusCtlWatchRecord);
  }
  return { messages, empty };
}

/**
 * Invoke `agent-busctl watch` once, bounded by `timeoutMs`, and reduce its
 * NDJSON stream to an `AgentBusMessageReadResult` in the loop-poll `read`
 * contract shape (body = flat message array, error set on failure).
 */
export async function watchAgentBusOnce(options: {
  binary?: string;
  busUrl?: string;
  identityStore?: string;
  timeoutMs?: number;
  watchWindowMs?: number;
  root?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentBusMessageReadResult> {
  const root = options.root ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 2_000;
  const watchWindowMs = options.watchWindowMs ?? DEFAULT_WATCH_WINDOW_MS;
  const env = options.env ?? process.env;

  const binary = options.binary ?? resolveAgentBusCtlBinary(undefined, env[AGENT_BUSCTL_ENV], root) ?? "agent-busctl";
  const targets: { busUrl?: string; identityStore?: string } =
    options.busUrl || options.identityStore
      ? { busUrl: options.busUrl, identityStore: options.identityStore }
      : resolveAgentBusCtlTargets(undefined, root);
  const { busUrl, identityStore } = targets;

  if (!busUrl) {
    return {
      body: null,
      status: 0,
      error: "Agent Bus needs a --bus URL (AGENT_BUS_URL/AGENT_BUS_BASE_URL or an enrolled busUrl in .agent-bus.local).",
    };
  }
  if (!identityStore) {
    return {
      body: null,
      status: 0,
      error:
        "Agent Bus needs an --identity credential store (AGENT_BUS_IDENTITY or the enrolled identityStore in .agent-bus.local).",
    };
  }

  const args = [
    "--bus", busUrl,
    "--identity", identityStore,
    "watch",
    "--for", `${Math.max(0, Math.round(watchWindowMs))}ms`,
    "--json",
  ];

  return new Promise<AgentBusMessageReadResult>((resolveResult) => {
    const child: ChildProcess = spawn(binary, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveResult({
        body: null,
        status: 0,
        error: `Agent Bus read timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const reason = error instanceof Error ? error.message : String(error);
      resolveResult({
        body: null,
        status: 0,
        error: `could not run agent-busctl (${binary}): ${reason}`,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { messages, empty } = parseAgentBusCtlWatchOutput(stdout);
      if (messages.length > 0) {
        // Real messages arrived: surface them as the read body.
        resolveResult({ body: messages as unknown as unknown[], status: 0 });
        return;
      }
      if (empty) {
        // Bounded watch finished with no messages: an idle poll, not an error.
        resolveResult({ body: [], status: 0 });
        return;
      }
      // No messages and not a clean empty: treat as a soft read failure unless
      // the exit was clean (0) with an empty stream (defensive).
      const detail = stderr.trim() || (stdout.trim() ? stdout.trim() : `exit code ${code}`);
      resolveResult({
        body: null,
        status: code ?? 0,
        error: code
          ? `agent-busctl watch failed (exit ${code}): ${detail}`
          : `agent-busctl watch produced no messages: ${detail}`,
      });
    });
  });
}
