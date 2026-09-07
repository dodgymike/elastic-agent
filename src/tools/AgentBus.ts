/**
 * Agent Bus tool — talks to the bus ONLY through the local `./agent-busctl`
 * CLI for its subcommands: `whoami`, long-poll `watch` (wait for a message),
 * `send`, `agents` (list registered agents), `logout` (clear the session), and
 * `help` (show the CLI usage). It never issues a raw HTTP request and never
 * reads a bearer/access token — the `agent-busctl` credential store owns all
 * secret material, and we only pass it the non-secret `--identity <dir>` path.
 *
 * NOT in this tool
 * - `enrol` is intentionally separate and lives in the `AgentBusEnrol` tool; it
 *   is deliberately NOT exposed here (it writes an identity + roster).
 * - `broadcast` is NOT a real `agent-busctl` subcommand — it is only a boolean
 *   attribute on `watch` message records (whether a message was broadcast), so
 *   there is no `broadcast` action to implement here.
 *
 * SECURITY POSTURE
 * - No `fetch`/`Http`/network client is ever constructed. Communication with
 *   the bus is delegated to `agent-busctl`, which authenticates with the
 *   enrolled identity it already holds.
 * - This tool never reads `data.json` and never sends secret-store contents,
 *   enrollment recipes, invite codes, or private keys as a message body.
 * - It never reads or logs bearer tokens. The only credential-adjacent value
 *   we handle is the non-secret `--identity` credential-store *directory*, so
 *   the CLI can locate (but never expose back to us) the credential.
 *
 * DEFAULT FLAGS
 * Every invocation is prefixed with the default flags `--identity <dir>` and
 * `--persist-session`. The `--identity` store is resolved, highest precedence
 * first: an explicit `identity` option, the `AGENT_BUS_IDENTITY` env, the
 * enrolled `identityStore` recorded in `.agent-bus.local` (written by
 * `AgentBusEnrol`), then `<root>/tmp/elastic-identity`. Preferring the roster's
 * `identityStore` keeps `--identity` pointing at the store the identity was
 * actually enrolled into, avoiding `no identity has been enrolled` (exit 3)
 * misfires. An explicit `identity`, `persistSession`, or `busUrl` option
 * overrides the corresponding default. The tool fails fast (throwing a clear
 * diagnostic) rather than falling back to any HTTP path when a requested action
 * has no `agent-busctl` subcommand.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * The actions this tool can perform through `agent-busctl`. `enrol` is
 * intentionally NOT here (it lives in `AgentBusEnrol`), and `broadcast` is not
 * a real subcommand (it is only a `watch` message attribute).
 */
export type AgentBusAction = "whoami" | "watch" | "send" | "agents" | "logout" | "help";

export interface AgentBusOptions {
  /**
   * Which `agent-busctl` action to run. Optional: when omitted the tool infers
   * it — `send` when `to` is supplied, `watch` when a wait bound (`forDuration`
   * or `count`) is supplied, otherwise `whoami`.
   */
  action?: AgentBusAction;

  // --- whoami ---
  /** [whoami] Authenticate against the bus (`agent-busctl whoami --verify`). */
  verify?: boolean;

  // --- watch (long-poll wait) ---
  /**
   * [watch] How long to wait for a message, as a CLI duration (e.g. "30s",
   * "5m", "500ms"). Maps to `agent-busctl watch --for <dur>`.
   */
  forDuration?: string;
  /** [watch] Stop after N messages have arrived (`agent-busctl watch --count`). */
  count?: number;

  // --- send ---
  /**
   * [send] Fully-qualified recipient `<bus-id>.<agent-id>` (a bare agent name is
   * refused by `agent-busctl`). Sent to `agent-busctl send <to> <body>`.
   */
  to?: string;
  /**
   * [send] The message body. Sent verbatim as a single argument to
   * `agent-busctl send <to> <body>`. Must never carry secret-store contents.
   */
  message?: string;

  // --- output / overrides ---
  /** Emit machine-readable output (`agent-busctl ... --json`). Defaults true. */
  json?: boolean;
  /**
   * Override the default `--identity <dir>` credential-store directory.
   * Defaults to `<root>/tmp/elastic-identity` (the enrolled identity store).
   */
  identity?: string;
  /** Apply `--persist-session` (reuse the session token across processes). Defaults true. */
  persistSession?: boolean;
  /**
   * Override the `--bus <url>` the CLI talks to. When omitted, the CLI resolves
   * it from its own store / `AGENT_BUS_URL` / `.agent-bus.local`.
   */
  busUrl?: string;
  /** Path to the `agent-busctl` binary. Defaults to `<root>/agent-busctl`. */
  binary?: string;
  /** Workspace/root directory used to resolve relative paths and defaults. Defaults to cwd. */
  root?: string;
}

export interface AgentBusResult {
  /** The `agent-busctl` action that was invoked. */
  action: AgentBusAction;
  /** The `agent-busctl` binary that was invoked (absolute path when known). */
  binary: string;
  /** Exit code of the `agent-busctl` process (0 on success). */
  exitCode: number;
  /** Raw stdout of the `agent-busctl` process. */
  stdout: string;
  /** Raw stderr of the `agent-busctl` process (diagnostics; never secrets). */
  stderr: string;
  /**
   * Parsed messages for a `watch` action (NDJSON records). Empty for whoami/send.
   */
  messages: readonly Record<string, unknown>[];
  /** Resolved `--identity` credential-store directory that was used. */
  identity: string;
  /** True when `--persist-session` was applied. */
  persistSession: boolean;
  /** The resolved `--bus` URL, when one was provided. */
  busUrl?: string;
}

/** Default credential-store directory relative to the workspace root. */
const DEFAULT_IDENTITY_SUBDIR = join("tmp", "elastic-identity");

/** Resolve the workspace root: an explicit option, else cwd. */
function resolveRoot(root: string | undefined): string {
  return resolve((root && root.trim()) || process.cwd());
}

/** Resolve an absolute or root-relative path against the root. */
function resolvePath(p: string, root: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(root, p);
}

/**
 * Resolve the `--identity` credential-store directory. Precedence: explicit
 * option > `AGENT_BUS_IDENTITY` env > `AGENT_BUS_STORE` roster's identityStore
 * (enrolled via `AgentBusEnrol`, recorded in `.agent-bus.local`) >
 * `<root>/tmp/elastic-identity` default.
 *
 * Consulting the roster matters because `AgentBusEnrol` (and the loop-mode
 * reader) store the enrolled identity under the roster's `identityStore`, which
 * is not always the `<root>/tmp/elastic-identity` default. Pointing `--identity`
 * at a store that has no enrolled identity yields `no identity has been
 * enrolled` even though an identity exists elsewhere, so we prefer the enrolled
 * location when one is recorded.
 */
function resolveDefaultIdentity(
  identity: string | undefined,
  env: NodeJS.ProcessEnv,
  root: string,
): string {
  if (identity && identity.trim()) return resolvePath(identity.trim(), root);
  const envIdentity = env.AGENT_BUS_IDENTITY?.trim();
  if (envIdentity) return resolvePath(envIdentity, root);
  const rosterIdentity = loadRosterIdentityStore(root);
  if (rosterIdentity) return rosterIdentity;
  return join(root, DEFAULT_IDENTITY_SUBDIR);
}

/**
 * Read the non-secret enrolled identity-store directory from `.agent-bus.local`
 * (written by `AgentBusEnrol`). Returns an absolute path, or undefined when the
 * roster is missing/malformed or records no `identityStore`. Never reads secret
 * material: the roster holds only non-secret metadata (bus URL, fingerprint,
 * agent id, identity-store path).
 */
function loadRosterIdentityStore(root: string): string | undefined {
  const storeFile = join(root, ".agent-bus.local");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(storeFile, "utf8"));
  } catch {
    return undefined; // missing/malformed roster — fall through to the default
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const candidate =
    (typeof record["identityStore"] === "string" && record["identityStore"].trim()) ||
    (typeof record["identity_store"] === "string" && record["identity_store"].trim());
  if (!candidate) return undefined;
  // Roster paths are typically absolute (AgentBusEnrol writes the resolved
  // identity store), but resolve any relative value against the same root so
  // the tool stays usable when run from a subdirectory.
  return resolvePath(candidate, root);
}

/** Resolve the `agent-busctl` binary path: explicit > `AGENT_BUSCTL` env > root-local > PATH. */
function resolveBinary(binary: string | undefined, env: NodeJS.ProcessEnv, root: string): string {
  const explicit = binary?.trim() || env.AGENT_BUSCTL?.trim();
  if (explicit) return resolvePath(explicit, root);
  const local = join(root, "agent-busctl");
  if (existsSync(local)) return local;
  return "agent-busctl"; // resolved by the OS against PATH
}

/** Parse a `--json` watch NDJSON stream into message records, dropping the CLI's closing `ok:false` object. */
function parseWatchMessages(stdout: string): readonly Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // Non-JSON lines are transport diagnostics; skip them in the parsed list.
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const obj = record as Record<string, unknown>;
    if (obj.ok === false) continue; // closing failure/empty object, not a message
    messages.push(obj);
  }
  return messages;
}

/** Confirm a requested action maps to a real `agent-busctl` subcommand; fail fast otherwise. */
function ensureSupportedAction(action: AgentBusAction, binary: string): void {
  // The actions below are the only ones this tool implements, and all are real
  // `agent-busctl` subcommands. `enrol` is intentionally separate (AgentBusEnrol)
  // and `broadcast` is not a subcommand, so neither is accepted here. If the
  // binary is missing entirely, the spawn below fails; this guard exists so an
  // unsupported action can never silently fall back to any HTTP transport.
  const supported: readonly AgentBusAction[] = ["whoami", "watch", "send", "agents", "logout", "help"];
  if (!supported.includes(action)) {
    throw new Error(
      `AgentBus action '${String(action)}' is not supported by agent-busctl (supported: ${supported.join(", ")}). ` +
        "Refusing to fall back to any HTTP path.",
    );
  }
  void binary;
}

/**
 * Resolve the action from the options when it was not supplied explicitly.
 * `send` when a recipient is present, `watch` when a wait bound is present,
 * otherwise `whoami`.
 */
function resolveAction(options: AgentBusOptions): AgentBusAction {
  if (options.action) return options.action;
  if (options.to && options.to.trim()) return "send";
  if (options.forDuration || typeof options.count === "number") return "watch";
  return "whoami";
}

/** Build the full `agent-busctl` argv for the resolved action and defaults. */
function buildArgs(
  action: AgentBusAction,
  options: AgentBusOptions,
  identity: string,
  persistSession: boolean,
): string[] {
  // Global/default flags come first so they can be overridden by the explicit
  // action-specific flags (the CLI accepts flags before or after the command).
  const args: string[] = ["--identity", identity];
  if (persistSession) args.push("--persist-session");
  if (options.busUrl && options.busUrl.trim()) {
    args.push("--bus", options.busUrl.trim());
  }

  switch (action) {
    case "whoami":
      args.push("whoami");
      if (options.verify) args.push("--verify");
      if (options.json ?? true) args.push("--json");
      break;
    case "watch":
      args.push("watch");
      if (options.json ?? true) args.push("--json");
      if (options.forDuration && options.forDuration.trim()) {
        args.push("--for", options.forDuration.trim());
      }
      if (typeof options.count === "number") {
        args.push("--count", String(options.count));
      }
      break;
    case "send":
      args.push("send");
      if (options.to && options.to.trim()) args.push(options.to.trim());
      if (options.message !== undefined && options.message !== null) {
        args.push(options.message);
      }
      if (options.json ?? true) args.push("--json");
      break;
    case "agents":
      args.push("agents");
      if (options.json ?? true) args.push("--json");
      break;
    case "logout":
      args.push("logout");
      if (options.json ?? true) args.push("--json");
      break;
    case "help":
      // `help` lists the CLI's subcommands as plain usage text; it does not
      // accept `--json` (the listing is interactive help, not data).
      args.push("help");
      break;
  }
  return args;
}

/**
 * Run one `agent-busctl` invocation synchronously and return its result. This
 * is the ONLY transport used by the tool — there is no HTTP path.
 */
function runAgentBusCtl(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  action: AgentBusAction,
  identity: string,
  persistSession: boolean,
  busUrl: string | undefined,
): AgentBusResult {
  const result = spawnSync(binary, args as string[], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // A bounded watch's `--for` already bounds the wait; this guard only
    // protects against a hung binary (there is no external watch timeout).
    timeout: action === "watch" ? 300_000 : 60_000,
  });

  const exitCode = typeof result.status === "number" ? result.status : 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (result.error) {
    const reason = result.error instanceof Error ? result.error.message : String(result.error);
    throw new Error(`could not run agent-busctl (${binary}): ${reason}`);
  }

  const messages = action === "watch" ? parseWatchMessages(stdout as string) : [];

  const resultObj: AgentBusResult = {
    action,
    binary,
    exitCode,
    stdout: stdout as string,
    stderr: stderr as string,
    messages,
    identity,
    persistSession,
    ...(busUrl ? { busUrl } : {}),
  };

  // Fail fast (clear diagnostic) rather than confusingly returning a partial
  // result. Non-zero exit codes are surfaced as errors with the CLI's own
  // stderr diagnostic, which is never secret material.
  if (exitCode !== 0) {
    const detail = (stderr || stdout || "").trim().slice(0, 512);
    const detailSuffix = detail ? ` ${detail}` : "";
    throw new Error(
      `agent-busctl ${action} failed (exit ${exitCode}) against '${binary}'.${detailSuffix}`,
    );
  }

  return resultObj;
}

/**
 * Run a coordination / Agent Bus operation, exclusively through the local
 * `agent-busctl` CLI.
 *
 *   - whoami  -> `agent-busctl --identity <dir> [--persist-session] whoami`
 *   - watch   -> `agent-busctl --identity <dir> [--persist-session] watch [--for <dur>]`
 *   - send    -> `agent-busctl --identity <dir> [--persist-session] send <to> <body>`
 *   - agents  -> `agent-busctl --identity <dir> [--persist-session] agents`
 *   - logout  -> `agent-busctl --identity <dir> [--persist-session] logout`
 *   - help    -> `agent-busctl --identity <dir> [--persist-session] help`
 *
 * `enrol` is intentionally NOT here (see `AgentBusEnrol`); `broadcast` is not a
 * real subcommand. The default flags `--identity <dir>` and `--persist-session`
 * are always prepended; explicit options override them. The tool never creates
 * an HTTP client and never sends or reads secret-store contents.
 */
export default async function agentBus(options: AgentBusOptions = {}): Promise<AgentBusResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("AgentBus options must be an object.");
  }

  const root = resolveRoot(options.root);
  const env = process.env;
  const identity = resolveDefaultIdentity(options.identity, env, root);
  const persistSession = options.persistSession ?? true;
  const binary = resolveBinary(options.binary, env, root);
  const action = resolveAction(options);

  ensureSupportedAction(action, binary);

  const args = buildArgs(action, options, identity, persistSession);
  return runAgentBusCtl(
    binary,
    args,
    env,
    action,
    identity,
    persistSession,
    options.busUrl && options.busUrl.trim() ? options.busUrl.trim() : undefined,
  );
}
