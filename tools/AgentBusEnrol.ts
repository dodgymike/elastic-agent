import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Redeem an agent-bus enrollment invite through the local `agent-busctl`
 * client and record a non-secret roster summary in `.agent-bus.local`.
 *
 * The invite file (a single-use bearer credential) is consumed by
 * `agent-busctl enrol --invite-file …`, which generates the private keys,
 * writes them into a permission-restricted identity store, and returns the
 * bus-minted agent id. This tool never reads or stores the invite's secret
 * material itself: it only parses enough of the invite to validate it and to
 * default the `--name`, then lets `agent-busctl` handle the handshake.
 *
 * SECURITY: The writer never persists invite tokens, private keys, or bus
 * credentials to the repository. `.agent-bus.local` holds only non-secret
 * metadata (bus URL, fingerprint, agent id, identity store path) under mode
 * 0600. The actual secret material lives in the `agent-busctl` identity store
 * directory, which must be kept outside the repository.
 */
export interface AgentBusEnrolOptions {
  /** Path to the invite JSON file. Defaults to the single `agent-bus-invite-*.json` match. */
  inviteFile?: string;
  /** Agent name to enrol as. Defaults to the invite's embedded name, if present. */
  name?: string;
  /**
   * Directory where `agent-busctl` stores the enrolled identity credentials.
   * Defaults to `<repoRoot>/.agent-bus-identity`. Keep it outside the
   * repository for real enrollment workflows.
   */
  identity?: string;
  /**
   * Repo/workspace root used to locate the `agent-busctl` binary and the
   * default `.agent-bus.local` store. Defaults to the repository root (two
   * levels above the `tools/` directory).
   */
  rootDir?: string;
}

export interface AgentBusEnrolResult {
  /** Base URL of the bus the agent joined. */
  busUrl: string;
  /** Pinned TLS certificate fingerprint of the bus. */
  busFingerprint: string;
  /** Fully-qualified agent id minted by the bus (`<bus-id>.<agent-id>`). */
  agentId: string;
  /** Agent name used to enrol. */
  name: string;
  /** Directory where `agent-busctl` stored the identity credentials. */
  identityStore: string;
  /** Path of the non-secret `.agent-bus.local` metadata file that was written. */
  storeFile: string;
}

interface Invite {
  url?: string;
  busUrl?: string;
  bus?: string;
  fingerprint?: string;
  busFingerprint?: string;
  token?: string;
  invite?: string;
  name?: string;
  agentName?: string;
  expiresAt?: string;
  expiry?: string;
  exp?: number;
}

/** The invite filename pattern used for default single-match discovery. */
export const INVITE_GLOB = "agent-bus-invite-*.json";

/** The default (non-secret) metadata store written next to the repo root. */
export const DEFAULT_STORE_FILENAME = ".agent-bus.local";

const REQUIRED_MESSAGE =
  "Missing one or more required invite fields. An agent-bus invite must carry the bus URL, its TLS fingerprint, and the enrollment (bearer) credential.";

/**
 * Resolve the repo/workspace root: an explicit option, else the current
 * working directory (which is the repository root when the agent runs there,
 * matching the rest of the runtime). An explicit `rootDir` always wins so
 * standalone installs can point at their checkout.
 */
export function resolveRepoRoot(rootDir?: string): string {
  if (rootDir) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("rootDir must be a non-empty string.");
    }
    return resolve(rootDir.trim());
  }
  return resolve(process.cwd());
}

/** Locate the repo-root `agent-busctl` binary, falling back to PATH. */
function resolveAgentBusctlPath(root: string): string {
  const local = join(root, "agent-busctl");
  if (existsSync(local)) return local;
  return "agent-busctl"; // rely on PATH lookup
}

/** Truncate a single embedded secret-looking value so diagnostics stay safe. */
function redact(value: string | undefined): string {
  if (!value) return "(missing)";
  return value.length > 12 ? `${value.slice(0, 6)}…(${value.length} chars)` : "(redacted)";
}

/**
 * Parse and validate the invite file. Only reads enough to validate required
 * fields and to default the agent name; the bearer credential is never echoed.
 */
function loadAndValidateInvite(inviteFile: string): Invite {
  let text: string;
  try {
    text = readFileSync(inviteFile, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read invite file '${inviteFile}'. Check the path and file permissions.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invite file '${inviteFile}' is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invite file '${inviteFile}' must contain a JSON object.`);
  }

  const invite = parsed as Record<string, unknown>;
  const str = (k: string) => {
    const v = invite[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const url = str("url") ?? str("busUrl") ?? str("bus");
  const fingerprint = str("fingerprint") ?? str("busFingerprint");
  const token = str("token") ?? str("invite");
  const name = str("name") ?? str("agentName");

  if (!url || !fingerprint || !token) {
    throw new Error(`${REQUIRED_MESSAGE} Found url=${url ? "yes" : "no"}, fingerprint=${fingerprint ? "yes" : "no"}, credential=${token ? "yes" : "no"}.`);
  }
  if (/[\r\n\0]/.test(url) || /[\r\n\0]/.test(fingerprint)) {
    throw new Error("Invite url/fingerprint must not contain control characters.");
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(
      `Invite fingerprint must be 64 lowercase hex characters (got '${redact(fingerprint)}').`,
    );
  }

  const expiresAt = str("expiresAt") ?? str("expiry");
  const numericExp = typeof invite["exp"] === "number" ? invite["exp"] : undefined;
  if (expiresAt) {
    const expiryMillis = Date.parse(expiresAt);
    if (Number.isNaN(expiryMillis)) {
      throw new Error(`Invite expiry '${expiresAt}' is not a valid date.`);
    }
    if (expiryMillis <= Date.now()) {
      throw new Error("Invite has already expired. Ask the operator for a fresh invite; a single-use invite cannot be reused.");
    }
  } else if (typeof numericExp === "number") {
    if (numericExp <= Date.now() / 1000) {
      throw new Error("Invite has already expired. Ask the operator for a fresh invite; a single-use invite cannot be reused.");
    }
  }

  return { url, fingerprint, token, name, expiresAt, exp: numericExp };
}

/**
 * Discover the single `agent-bus-invite-*.json` file in the repo root. If
 * there are zero or multiple matches, refuse rather than guessing.
 */
function discoverInviteFile(root: string): string {
  const glob = INVITE_GLOB;
  const prefix = glob.slice(0, glob.indexOf("*"));
  const suffix = glob.slice(glob.indexOf("*") + 1);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw new Error(`Could not list repo root '${root}' to discover an invite file.`);
  }
  const matches = entries.filter(
    (entry) =>
      entry.startsWith(prefix) && entry.endsWith(suffix) && statSync(join(root, entry)).isFile(),
  );
  if (matches.length === 0) {
    throw new Error(
      `No invite file found. Create an '${INVITE_GLOB}' in the repo root or pass inviteFile explicitly.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} invite files (${matches.join(", ")}). Pass inviteFile explicitly to choose one.`,
    );
  }
  return join(root, matches[0]);
}

/** Best-effort parse of `agent-busctl --json` output into a record. */
function parseCtlJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // non-JSON stderr diagnostic
  }
  return null;
}

/** Extract the agent id from JSON output across common field names. */
function extractAgentId(json: Record<string, unknown> | null, text: string): string | undefined {
  if (json) {
    for (const key of ["agentId", "agent_id", "id", "agent"]) {
      const v = json[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  const match = text.match(/[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/);
  return match ? match[0] : undefined;
}

/**
 * Redeem the invite through the local `agent-busctl` and store the non-secret
 * roster summary. Throws an Error with actionable diagnostics on failure.
 */
export default function agentBusEnrol(options: AgentBusEnrolOptions = {}): AgentBusEnrolResult {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("AgentBusEnrol options must be an object.");
  }
  if (options.inviteFile !== undefined && typeof options.inviteFile !== "string") {
    throw new TypeError("inviteFile must be a string path.");
  }
  if (options.name !== undefined && typeof options.name !== "string") {
    throw new TypeError("name must be a string.");
  }
  if (options.identity !== undefined && typeof options.identity !== "string") {
    throw new TypeError("identity must be a string directory path.");
  }
  if (options.inviteFile !== undefined && /[\r\n\0]/.test(options.inviteFile)) {
    throw new TypeError("inviteFile must not contain control characters.");
  }
  if (options.name !== undefined && /[\r\n\0]/.test(options.name)) {
    throw new TypeError("name must not contain control characters.");
  }

  const root = resolveRepoRoot(options.rootDir);
  const invitePath = options.inviteFile
    ? resolve(root, options.inviteFile)
    : discoverInviteFile(root);

  const invite = loadAndValidateInvite(invitePath);
  const name = options.name ? options.name.trim() : invite.name ?? "";
  if (!name) {
    throw new Error(
      "No agent name supplied. Pass an explicit name or include a 'name' field in the invite.",
    );
  }

  const identityStore = options.identity
    ? (isAbsolute(options.identity) ? options.identity : resolve(root, options.identity))
    : join(root, ".agent-bus-identity");

  const agentBusctl = resolveAgentBusctlPath(root);
  const args = [
    "enrol",
    "--invite-file",
    invitePath,
    "--name",
    name,
    "--identity",
    identityStore,
    "--json",
  ];

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(agentBusctl, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const execErr = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    exitCode = typeof execErr.status === "number" ? execErr.status : 1;
    stdout = execErr.stdout ?? "";
    stderr = execErr.stderr ?? "";
  }

  if (exitCode !== 0) {
    const diagnostic = (stderr || stdout || "").trim().slice(0, 512);
    const diagSuffix = diagnostic ? ` ${diagnostic}` : "";
    const hint = exitCode === 7
      ? " The bus refused the invite (already used or revoked); request a fresh one."
      : exitCode === 5
        ? " The bus could not be reached; check network and TLS fingerprint."
        : exitCode === 4
          ? " The bus rejected the credential; request a fresh invite."
          : "";
    throw new Error(
      `agent-busctl enrolment failed (exit ${exitCode}) against '${agentBusctl}'.${hint}${diagSuffix}`,
    );
  }

  const json = parseCtlJson(stdout);
  const agentId = extractAgentId(json, stdout);
  if (!agentId) {
    throw new Error(
      "Enrolment returned success but no agent id could be parsed from agent-busctl output; verify with `agent-busctl whoami`.",
    );
  }

  // Persist NON-secret metadata only. Private keys and the bearer credential
  // live in the identity store owned by agent-busctl; never here.
  const storeFile = join(root, DEFAULT_STORE_FILENAME);
  const metadata = {
    busUrl: invite.url,
    busFingerprint: invite.fingerprint,
    agentId,
    name,
    identityStore,
    enrolledAt: new Date().toISOString(),
  };
  mkdirSync(dirname(storeFile), { recursive: true });
  writeFileSync(storeFile, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
    flag: "w",
  });

  return {
    busUrl: invite.url!,
    busFingerprint: invite.fingerprint!,
    agentId,
    name,
    identityStore,
    storeFile,
  };
}
