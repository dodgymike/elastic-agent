/**
 * loop-busctl-read.ts — loop-mode Agent Bus reads through the `agent-busctl`
 * CLI instead of a raw authenticated HTTP client.
 *
 * CURSOR RESUME: `agent-busctl watch` is a long-lived NDJSON stream that the
 * bus treats as at-least-once. Each received message carries a stable position
 * identifier (`message_id` in the form `<bus-id>-<seq>`, or `seq` alone).
 * `loop-busctl-read` captures that cursor id from each parsed message, keeps
 * it in-process via `getLastCursorId()`, and persists it to a loop-mode state
 * file (default `bus-cursor.json`, git-ignored, alongside `bus-queue.json`)
 * through the `saveCursor` / `loadCursor` helpers so a later poll can resume
 * from the saved position. None of this touches secrets or `data.json` — the
 * cursor is an opaque non-secret position token only.
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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
 * Resolve the cursor id a poll should start from, so the next `agent-busctl
 * watch` resumes where a previous poll left off instead of re-delivering the
 * retained window.
 *
 * Precedence, highest first:
 *   1. the in-process cursor captured by the most recent successful poll
 *      (`getLastCursorId()`) — this is the live resume within a single
 *      loop-mode run across pre-planning, between-step, and idle polls;
 *   2. a persisted cursor from a loop-mode state file (via `loadCursor`), so a
 *      restarted run can also pick up where it stopped.
 *
 * `cursorFilePath` is optional: when omitted we resume only from the in-process
 * cursor. A missing/illegible state file yields no cursor (normal first run),
 * never a throw. When a cursor id is resolved, the caller appends
 * `--cursor <id>` to the `agent-busctl watch` args so the CLI starts at that
 * explicit position rather than at its own persisted position.
 */
export function resolveStartCursorId(cursorFilePath?: string): {
  cursor: string | undefined;
  source: "memory" | "file" | "none";
  warnings: readonly string[];
} {
  const inMemory = getLastCursorId();
  if (inMemory !== undefined) {
    return { cursor: inMemory, source: "memory", warnings: [] };
  }
  if (cursorFilePath) {
    const loaded = loadCursor(cursorFilePath);
    if (loaded.cursor !== undefined) {
      return { cursor: loaded.cursor, source: "file", warnings: loaded.warnings };
    }
    return { cursor: undefined, source: "none", warnings: loaded.warnings };
  }
  return { cursor: undefined, source: "none", warnings: [] };
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

/** Default loop-mode cursor state file, resolved against the project root. */
export const BUS_CURSOR_FILENAME = "bus-cursor.json";

/**
 * In-process cursor id of the most recently received/parsed message. This is
 * module-scoped so successive polls within a single loop-mode run can resume
 * without re-reading the state file every time. It is never logged and never
 * contains secret material — only the non-secret position id.
 */
let lastCursorId: string | undefined;

/**
 * Build the default cursor state file path: `bus-cursor.json` in the project
 * root, alongside the existing (git-ignored) `bus-queue.json`. Keeping it with
 * the repo it coordinates makes it easy to relocate via a custom path while
 * remaining out of git.
 */
export function defaultBusCursorFilePath(projectRoot: string): string {
  return join(projectRoot, BUS_CURSOR_FILENAME);
}

/**
 * Extract the cursor (position) id from a single parsed message record.
 * `agent-busctl watch` records carry a stable `message_id` in the form
 * `<bus-id>-<seq>`; when that is absent we fall back to the numeric `seq`.
 * Returns `undefined` when the record carries neither, so a caller can decide
 * not to advance the stored cursor for that record.
 */
export function extractCursorId(record: AgentBusCtlWatchRecord): string | undefined {
  if (typeof record.message_id === "string" && record.message_id.trim()) {
    return record.message_id.trim();
  }
  if (record.seq !== undefined && record.seq !== null) {
    return String(record.seq);
  }
  return undefined;
}

/**
 * Capture the cursor id of the last message in a parsed batch, update the
 * in-process cursor, and optionally persist it to a loop-mode state file so a
 * later poll (or a restarted run) can resume from this position. Fully
 * fail-soft: a state file that cannot be written is surfaced as a diagnostic
 * string (never thrown) and only halts cursor persistence, not the read.
 *
 * @param messages  Parsed message records, in arrival order.
 * @param cursorFilePath  Optional state file to persist to (must be outside git).
 * @returns A non-fatal diagnostic string, or undefined when everything worked.
 */
export function captureAndPersistCursor(
  messages: readonly AgentBusCtlWatchRecord[],
  cursorFilePath?: string,
): string | undefined {
  // Advance to the last message's cursor id (arrival order = sequence order).
  let captured: string | undefined;
  for (const message of messages) {
    const id = extractCursorId(message);
    if (id !== undefined) captured = id;
  }
  if (captured === undefined) return undefined;
  lastCursorId = captured;
  if (!cursorFilePath) return undefined;
  return saveCursor(cursorFilePath, captured);
}

/** Return the in-process cursor id captured from the most recent message. */
export function getLastCursorId(): string | undefined {
  return lastCursorId;
}

/**
 * Clear the in-process cursor id. Used mainly by tests to isolate the
 * in-memory vs persisted-file resume paths and to simulate a fresh run. In
 * production the in-process cursor intentionally persists across polls within
 * a single loop-mode run; callers should not normally clear it.
 */
export function clearInMemoryCursor(): void {
  lastCursorId = undefined;
}

/**
 * Persist a cursor id to a loop-mode state file (git-ignored, never a secrets
 * store and never `data.json`). The write goes to a sibling temp file and is
 * renamed into place so a crash mid-write never leaves a truncated cursor.
 * Fail-soft: any I/O problem is returned as a diagnostic string rather than
 * thrown, so a read-only workspace degrades to in-memory-only cursor tracking.
 */
export function saveCursor(filePath: string, cursorId: string): string | undefined {
  if (!cursorId.trim()) return undefined;
  const tmpPath = `${filePath}.tmp`;
  const parent = dirname(filePath);
  try {
    if (parent && parent !== ".") {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(tmpPath, JSON.stringify({ cursor: cursorId }, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `could not persist bus cursor to '${filePath}' (${reason}); continuing with in-memory cursor only`;
  }
}

/**
 * Load a previously persisted cursor id from a loop-mode state file. A missing
 * file yields no cursor (a normal first run); a malformed/illegible file yields
 * no cursor plus a warning so the caller can surface it. Never throws.
 */
export function loadCursor(
  filePath: string,
): { cursor: string | undefined; warnings: readonly string[] } {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { cursor: undefined, warnings };
    }
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`could not read bus cursor '${filePath}': ${reason}; starting from the beginning`);
    return { cursor: undefined, warnings };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(
      `bus cursor '${filePath}' is not valid JSON (${reason}); starting from the beginning`,
    );
    return { cursor: undefined, warnings };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    warnings.push(`bus cursor '${filePath}' is not an object; starting from the beginning`);
    return { cursor: undefined, warnings };
  }
  const cursor = (payload as { cursor?: unknown }).cursor;
  if (typeof cursor !== "string" || !cursor.trim()) {
    warnings.push(`bus cursor '${filePath}' has no usable cursor; starting from the beginning`);
    return { cursor: undefined, warnings };
  }
  return { cursor: cursor.trim(), warnings };
}

/**
 * Invoke `agent-busctl watch` once and reduce its NDJSON stream to an
 * `AgentBusMessageReadResult` in the loop-poll `read` contract shape (body =
 * flat message array, error set on failure).
 *
 * NO-TIMEOUT: the CLI watch is long-lived by nature — it keeps streaming until
 * its `--for` watch window elapses and it emits its closing `ok:false`
 * object, then exits cleanly. We deliberately do NOT wrap the sub-process in a
 * Promise.race/child_process watchdog timeout. Shutdown is instead owned by the
 * caller (loop mode aborts/kills the run), and any unexpected process exit is
 * surfaced below through the `close`/`error` handlers rather than being masked
 * by a timer. The `watchWindowMs` option only tunes how long the CLI itself
 * waits for messages before reporting "idle" (`--for`), which is the CLI's
 * natural watch bound — not an external timeout that SIGKILLs the stream.
 */
export async function watchAgentBusOnce(options: {
  binary?: string;
  busUrl?: string;
  identityStore?: string;
  watchWindowMs?: number;
  root?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Loop-mode state file (git-ignored) to persist the latest cursor id to.
   * When set, each poll that receives messages records the last message's
   * cursor id there so a subsequent poll (or restart) can resume from it.
   */
  cursorFilePath?: string;
}): Promise<AgentBusMessageReadResult> {
  const root = options.root ?? process.cwd();
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

  // Resume from the saved cursor id when one exists (in-process first, then the
  // persisted state file), so this poll picks up where the previous poll or a
  // prior run left off instead of re-reading the retained window. When no
  // cursor exists (a normal first run) we omit --cursor entirely.
  const startCursor = resolveStartCursorId(options.cursorFilePath);
  if (startCursor.warnings.length > 0) {
    // A missing/illegible persisted cursor is non-fatal: we run from the start
    // (or from the CLI's own persisted position) and surface a warning. There
    // is no stderr/status channel here, so mirror the original saveCursor
    // diagnostic style by leaving the read to continue without a cursor.
    void startCursor.warnings;
  }

  const args = [
    "--bus", busUrl,
    "--identity", identityStore,
    "watch",
    ...(startCursor.cursor !== undefined ? ["--cursor", startCursor.cursor] : []),
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
    // No watchdog timer: the CLI watch is long-lived by nature, and shutdown
    // is owned by the caller. We settle only when the stream ends or the
    // process exits (unexpected or clean), which keeps errors from an
    // unexpected process exit visible instead of masking them with a timer.
    let settled = false;

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
      const { messages, empty } = parseAgentBusCtlWatchOutput(stdout);
      if (messages.length > 0) {
        // Real messages arrived: capture the cursor id of the last message
        // (kept in memory and persisted when a cursorFilePath was supplied) so
        // a subsequent poll or restarted run can resume from this position.
        // A persistence failure is non-fatal and must not fail the poll.
        captureAndPersistCursor(messages, options.cursorFilePath);
        // Surface them as the read body.
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
