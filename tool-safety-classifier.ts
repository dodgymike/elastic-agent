import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CompatibleResponse, MultiTurnLlmRuntime } from "./llm/multi-turn-runtime.js";
import { RunAbortError } from "./llm/run-abort.js";
import type { ToolSafetyConfig } from "./tool-safety-config.js";

/**
 * Lightweight tool-call safety classifier.
 *
 * Every tool call in the central dispatch loop is classified before its
 * exec_handler runs. This module owns:
 *
 * 1. Fast deterministic static checks for known unsafe patterns:
 *    - any tool target named data.json (including repo-root data.json and
 *      /tmp/data.json, which is the runtime's internal state file and is
 *      never a legitimate tool target);
 *    - protected files (.env, SSH keys, credential/token stores);
 *    - path traversal and absolute paths that escape the workspace;
 *    - destructive filesystem/database/host commands;
 *    - file/secret exfiltration commands;
 *    - command-injection shells;
 *    - secret material embedded in writes, commits, and HTTP requests.
 * 2. LLM classification for ambiguous calls using
 *    prompts/tool-safety-classifier.md.
 * 3. A fail-closed fallback when the LLM is unavailable or its output cannot
 *    be parsed.
 *
 * Allowed decisions produce no console output; denied or fail-closed
 * decisions are logged with the [TOOL SAFETY] prefix through the supplied
 * logger. Parameter values are never logged; the LLM prompt receives only
 * normalized and redacted parameters.
 */

/** Prompt file loaded from the repository root, matching main.ts prompt loading. */
export const TOOL_SAFETY_PROMPT_PATH = process.env.TOOL_SAFETY_PROMPT_PATH ?? "prompts/tool-safety-classifier.md";

/** Mirrors the existing review retry limit (one initial request plus two retries). */
const MAX_TOOL_SAFETY_ATTEMPTS = 3;

/** Maximum number of characters kept from any single string in the LLM prompt. */
const MAX_PROMPT_STRING_LENGTH = 400;

/** Maximum serialized size of the normalized parameters sent to the LLM. */
const MAX_PROMPT_PARAMETERS_LENGTH = 3000;

const DATA_JSON_BASENAME = /^data\.json$/i;

const PROTECTED_BASENAMES = [
  { pattern: /^\.env(?:\..+)?$/i, label: "environment file" },
  { pattern: /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i, label: "SSH private key" },
  { pattern: /\.(pem|key|p12|pfx)$/i, label: "private key or certificate store" },
  { pattern: /^\.(netrc|npmrc|pypirc|git-credentials|htpasswd)$/i, label: "credential store" },
];

const PROTECTED_STEM_PATTERN = /(^|[-_.])(token|tokens|api[_-]?key|apikey|password|passwd|secret|secrets|credential|credentials)$/i;

const SECRET_TEXT_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key block" },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/, label: "OpenAI-style API key" },
  { pattern: /\bghp_[A-Za-z0-9]{30,}\b/, label: "GitHub personal access token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key" },
  { pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, label: "Slack token" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, label: "JSON Web Token" },
  { pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"',;}{]{6,}/i, label: "embedded credential" },
];

const SECRET_QUERY_PARAMETERS = /^(token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|apikey|auth|authorization)$/i;

const SECRET_HEADER_NAMES = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|cookie|set-cookie)$/i;

const SECRET_ENVIRONMENT_VARIABLES = /(?:^|[^\w])\$?\{?(OPENAI_API_KEY|DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN|DOCKER_PASSWORD|DATABASE_URL)\}?/i;

export type ToolSafetyDecision = "safe" | "unsafe" | "ambiguous";
export type ToolSafetySource = "static" | "llm" | "fallback";

export interface ToolSafetyClassification {
  readonly safe: boolean;
  readonly reason: string;
  readonly source: ToolSafetySource;
}

export interface StaticToolSafetyVerdict {
  readonly decision: ToolSafetyDecision;
  readonly reason: string;
}

export interface ToolSafetyClassifierOptions {
  /** LLM runtime used for ambiguous calls. When omitted, ambiguous calls fail closed. */
  readonly runtime?: MultiTurnLlmRuntime;
  /** Repository/workspace root used for path checks. Defaults to process.cwd(). */
  readonly workspaceRoot?: string;
  /**
   * Additional trusted roots (absolute paths) that the classifier treats as
   * "local"/inside the workspace, in addition to `workspaceRoot`. For example
   * the canonical (symlink-resolved) path of the starting directory as
   * resolved by workspace-init, so both the logical cwd (pwd) and its real
   * target are accepted. A target is only considered "outside the workspace"
   * when it escapes *every* trusted root.
   */
  readonly allowedDirectories?: readonly string[];
  /**
   * Resolved tool-safety CLI configuration threaded from main.ts (enabled,
   * agentSourceDir, startDir, allowAgentSourceModifications). When present,
   * the classifier's edit/write policy and bypass behavior are driven by
   * these values instead of the legacy workspaceRoot-only defaults.
   */
  readonly toolSafetyConfig?: ToolSafetyConfig;
  /** Override for the classifier prompt path (default prompts/tool-safety-classifier.md). */
  readonly promptPath?: string;
  /** Optional logger so tests can silence the default console output. */
  readonly logger?: (level: "info" | "error", message: string) => void;
}

export type ToolRiskLevel = "mutating" | "readonly" | "unknown";

export interface ParsedToolSafetyClassification {
  readonly valid: true;
  readonly safe: boolean;
  readonly reason: string;
}

export interface ParsedToolSafetyFailure {
  readonly valid: false;
  readonly reason: string;
}

export type ToolSafetyParseResult = ParsedToolSafetyClassification | ParsedToolSafetyFailure;

function safe(reason: string): StaticToolSafetyVerdict {
  return { decision: "safe", reason };
}

function unsafe(reason: string): StaticToolSafetyVerdict {
  return { decision: "unsafe", reason };
}

function ambiguous(reason: string): StaticToolSafetyVerdict {
  return { decision: "ambiguous", reason };
}

function logDecision(toolName: string, classification: ToolSafetyClassification, logger: NonNullable<ToolSafetyClassifierOptions["logger"]>): void {
  if (classification.safe) return; // Allowed calls produce no [TOOL SAFETY] output.
  const message = `[TOOL SAFETY] ${toolName}: unsafe (${classification.source}): ${classification.reason}`;
  logger("error", message);
}

/** Write target for the safety logger; kept injectable so tests can capture output. */
export interface ToolSafetyLoggerTarget {
  readonly info: (line: string) => void;
  readonly error: (line: string) => void;
}

/**
 * Build a safety logger that indents every line of a [TOOL SAFETY] message
 * with the supplied prefix. main.ts passes the tool-result indentation so
 * safety messages sit under the pending `ToolName(args)` line, while tests can
 * pass their own prefix and capture the output.
 */
export function createToolSafetyLogger(
  prefix: string,
  target: ToolSafetyLoggerTarget = { info: (line) => console.log(line), error: (line) => console.error(line) },
): NonNullable<ToolSafetyClassifierOptions["logger"]> {
  return (level, message) => {
    const lines = String(message).split("\n").map((line) => `${prefix}${line}`).join("\n");
    if (level === "error") target.error(lines);
    else target.info(lines);
  };
}

const defaultLogger = createToolSafetyLogger("");

/** Return the non-string, non-null string path value or null when invalid. */
function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Split a possibly Windows-separated path into normalized /-separated segments. */
function normalizedSegments(target: string): string[] {
  return target.replace(/\\/g, "/").split("/");
}

function baseNameOf(target: string): string {
  const segments = normalizedSegments(target).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

function stemOf(base: string): string {
  return base.replace(/\.[^./]+$/, "");
}

function dataJsonTargetReason(target: string): string | null {
  const base = baseNameOf(target);
  if (DATA_JSON_BASENAME.test(base)) {
    return `Tool call targets the protected file data.json ('${target}'); data.json is never a valid tool target, including /tmp/data.json.`;
  }
  return null;
}

function protectedPathReason(target: string): string | null {
  const base = baseNameOf(target);
  if (!base) return null;
  for (const entry of PROTECTED_BASENAMES) {
    if (entry.pattern.test(base)) {
      return `Tool call targets protected ${entry.label} '${base}'.`;
    }
  }
  if (PROTECTED_STEM_PATTERN.test(stemOf(base))) {
    return `Tool call targets protected credential or secret file '${base}'.`;
  }
  return null;
}

function hasPathTraversal(target: string): boolean {
  return normalizedSegments(target).includes("..");
}

/** True when `absolute` (an absolute path) resolves outside a single root. */
function resolvesOutsideSingleRoot(absolute: string, root: string): boolean {
  const rel = relative(root, absolute);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Build the de-duplicated, absolute set of trusted roots for path checks:
 * `workspaceRoot` always first, then any additional `allowedDirectories` (the
 * canonical/real starting-directory path from workspace-init). The list is
 * never empty; an empty `allowedDirectories` simply degrades to the workspace
 * root alone, preserving the legacy single-root behavior.
 */
function trustedRoots(workspaceRoot: string, allowedDirectories: readonly string[] | undefined): string[] {
  const roots: string[] = [resolve(workspaceRoot)];
  if (allowedDirectories && allowedDirectories.length > 0) {
    for (const dir of allowedDirectories) {
      if (typeof dir === "string" && dir.trim() !== "") {
        roots.push(resolve(workspaceRoot, dir));
      }
    }
  }
  return Array.from(new Set(roots));
}

/**
 * True when `target` escapes *every* trusted root. `target` may be relative
 * (then resolved against each root in turn) or absolute. A target counts as
 * inside the workspace when it stays within at least one trusted root, so the
 * canonical starting-directory path is accepted as "local" even when it
 * differs from `workspaceRoot` (for example under a symlink).
 */
function resolvesOutsideAllTrustedRoots(target: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  const absolute = isAbsolute(target) ? resolve(target) : (() => {
    // For a relative target it is only inside if it stays under at least one
    // root; resolve against each root and keep the first result that is inside.
    for (const root of roots) {
      const candidate = resolve(root, target);
      if (!resolvesOutsideSingleRoot(candidate, root)) return candidate;
    }
    return resolve(roots[0], target);
  })();
  for (const root of roots) {
    if (!resolvesOutsideSingleRoot(absolute, root)) return false;
  }
  return true;
}

function secretTextReason(text: string): string | null {
  for (const entry of SECRET_TEXT_PATTERNS) {
    if (entry.pattern.test(text)) {
      return `Text contains a ${entry.label}, which must not be written, sent, or logged.`;
    }
  }
  return null;
}

function secretUrlReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The Http/HttpRequest tool will reject an invalid URL; treat parsing
    // failure as ambiguous rather than classifying the call itself unsafe.
    return null;
  }
  if (parsed.username || parsed.password) {
    return `URL embeds credentials in its userinfo ('${parsed.hostname}').`;
  }
  for (const [name, value] of parsed.searchParams) {
    if (SECRET_QUERY_PARAMETERS.test(name) && value.length > 0) {
      return `URL query parameter '${name}' carries a secret value.`;
    }
  }
  return null;
}

/** Redact secret-looking values from normalized parameters before an LLM call. */
function redactText(text: string): string {
  let redacted = text;
  for (const entry of SECRET_TEXT_PATTERNS) {
    redacted = redacted.replace(entry.pattern, `<redacted ${entry.label}>`);
  }
  return redacted;
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key/i.test(key);
}

function sanitizeForPrompt(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    let text = redactText(value);
    if (isSecretKey(key ?? "")) text = "<redacted>";
    return text.length > MAX_PROMPT_STRING_LENGTH ? `${text.slice(0, MAX_PROMPT_STRING_LENGTH)}…` : text;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeForPrompt(entry));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const entryKey of Object.keys(value).sort()) {
      output[entryKey] = sanitizeForPrompt((value as Record<string, unknown>)[entryKey], entryKey);
    }
    return output;
  }
  return value;
}

/**
 * Normalize tool parameters into stable, redacted JSON for the LLM safety
 * prompt. The output must never be written to logs or persisted.
 */
export function normalizeToolParameters(parameters: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitizeForPrompt(parameters));
  } catch {
    serialized = JSON.stringify({ error: "Tool parameters could not be serialized." });
  }
  if (serialized === undefined) serialized = "null";
  return serialized.length > MAX_PROMPT_PARAMETERS_LENGTH ? `${serialized.slice(0, MAX_PROMPT_PARAMETERS_LENGTH)}…` : serialized;
}

/** Risk level used by the dispatch loop when the classifier fails. */
export function toolRiskLevel(toolName: string): ToolRiskLevel {
  switch (toolName) {
    case "Read":
    case "FileSize":
    case "ListDirectory":
    case "Http":
      return "readonly";
    case "Write":
    case "Edit":
    case "ExecuteCommand":
    case "Git":
    case "HttpRequest":
    case "AgentBus":
    case "SpecKeeper":
    case "SpecKeeperEnroll":
      return "mutating";
    default:
      return "unknown";
  }
}

function classifyFileTool(toolName: string, parameters: Record<string, unknown>, roots: readonly string[]): StaticToolSafetyVerdict {
  const pathKey = toolName === "ListDirectory" ? "directory" : "path";
  const target = stringValue(parameters[pathKey]);
  if (target === null || target.trim() === "") {
    return ambiguous(`${toolName} has no valid '${pathKey}'; the tool itself will reject the call.`);
  }

  const dataJson = dataJsonTargetReason(target);
  if (dataJson) return unsafe(dataJson);

  const protectedReason = protectedPathReason(target);
  if (protectedReason) return unsafe(protectedReason);

  if (hasPathTraversal(target)) {
    return unsafe(`${toolName} path '${target}' contains '..' path traversal.`);
  }
  if (resolvesOutsideAllTrustedRoots(target, roots)) {
    return unsafe(`${toolName} path '${target}' resolves outside the workspace.`);
  }

  // Write/Edit content can persist credentials or secret-store material.
  if (toolName === "Write") {
    const content = stringValue(parameters.content);
    if (content !== null) {
      const secret = secretTextReason(content);
      if (secret) return unsafe(`${toolName} content is unsafe: ${secret}`);
    }
  }
  if (toolName === "Edit") {
    const editTexts: Array<{ readonly key: string; readonly value: string }> = [];
    const newString = stringValue(parameters.new_string);
    if (newString !== null) editTexts.push({ key: "new_string", value: newString });
    if (Array.isArray(parameters.edits)) {
      for (const edit of parameters.edits) {
        if (edit && typeof edit === "object" && !Array.isArray(edit)) {
          const replacement = stringValue((edit as Record<string, unknown>).new_string);
          if (replacement !== null) editTexts.push({ key: "edits[].new_string", value: replacement });
        }
      }
    }
    const lineContent = stringValue(parameters.content);
    if (lineContent !== null) editTexts.push({ key: "content", value: lineContent });
    for (const entry of editTexts) {
      const secret = secretTextReason(entry.value);
      if (secret) return unsafe(`${toolName} ${entry.key} is unsafe: ${secret}`);
    }
  }

  return safe(`${toolName} target '${target}' stays within the workspace and is not a protected file.`);
}

function classifyExecuteCommand(parameters: Record<string, unknown>, roots: readonly string[]): StaticToolSafetyVerdict {
  const command = stringValue(parameters.command);
  if (command === null || command.trim() === "") {
    return ambiguous("ExecuteCommand has no non-empty command; the tool itself will reject the call.");
  }
  const positional: string[] = Array.isArray(parameters.parameters)
    ? parameters.parameters.filter((parameter): parameter is string => typeof parameter === "string")
    : [];
  const allText = [command, ...positional].join("\n");

  if (/data\.json/i.test(allText)) {
    return unsafe("ExecuteCommand references the protected file data.json; data.json is never a valid tool target, including /tmp/data.json.");
  }

  const commandSecret = secretTextReason(allText);
  if (commandSecret) {
    return unsafe(`ExecuteCommand is unsafe: ${commandSecret}`);
  }
  if (SECRET_ENVIRONMENT_VARIABLES.test(command) && /\b(echo|printf|printenv|cat|curl|wget|nc|netcat|base64|git|scp|rsync|sftp)\b/i.test(command)) {
    return unsafe("ExecuteCommand prints or transmits a secret environment variable.");
  }
  if (/^\s*printenv\b/.test(command) || /^\s*env\s*([|>]|$)/.test(command)) {
    return unsafe("ExecuteCommand prints environment variables, which can expose secrets.");
  }
  if (/\b(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.env|\.netrc|\.npmrc|\.pypirc|\.git-credentials)\b/i.test(command) && /\b(cat|head|tail|less|more|sed|awk|grep|rg|wc|file|cp|scp|rsync|base64|curl|wget|nc|netcat)\b/i.test(command)) {
    return unsafe("ExecuteCommand accesses a protected credential file.");
  }

  const destructiveCheck = destructiveCommandCheck(command, roots);
  if (destructiveCheck?.severity === "unsafe") return unsafe(`ExecuteCommand is destructive: ${destructiveCheck.reason}`);
  if (destructiveCheck?.severity === "ambiguous") return ambiguous(`ExecuteCommand may delete data: ${destructiveCheck.reason}`);

  const exfiltrationReason = exfiltrationCommandReason(command);
  if (exfiltrationReason) return unsafe(`ExecuteCommand exfiltrates data: ${exfiltrationReason}`);

  if (/\beval\b/.test(command)) {
    return unsafe("ExecuteCommand uses 'eval', which is a command-injection vector.");
  }
  if (/\b(bash|sh|zsh)\s+-c\b/i.test(command) || /\bcmd\s+\/c\b/i.test(command) || /\b(powershell|pwsh)\s+-command\b/i.test(command)) {
    return unsafe("ExecuteCommand nests another shell interpreter, which is a command-injection vector.");
  }

  const outsideReason = absolutePathEscapeReason(command, roots);
  if (outsideReason) return unsafe(`ExecuteCommand accesses a path outside the workspace: ${outsideReason}`);

  if (isHarmlessNoOp(command)) {
    return safe("ExecuteCommand is a harmless no-op that reads or writes nothing outside /dev/null.");
  }

  if (isKnownSafeCommand(command)) {
    return safe("ExecuteCommand is a known-safe, read-only or standard verification command.");
  }

  return ambiguous(`ExecuteCommand command '${truncateForReason(command)}' needs LLM safety review.`);
}

function truncateForReason(value: string, limit = 120): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

interface DestructiveCommandCheck {
  readonly severity: "unsafe" | "ambiguous";
  readonly reason: string;
}

function destructiveCommandCheck(command: string, roots: readonly string[]): DestructiveCommandCheck | null {
  const lower = command.toLowerCase();

  if (/\bmkfs(\.[a-z]+)?\b/.test(lower)) return { severity: "unsafe", reason: "mkfs creates a filesystem and destroys existing data." };
  if (/\bdd\b[^\n;|&]*\bof=\/dev\//i.test(command)) return { severity: "unsafe", reason: "dd writes directly to a raw device." };
  if (/\bshred\b/.test(lower)) return { severity: "unsafe", reason: "shred securely deletes files." };
  if (/\b(format|del|rd)\s+\/[sq]\b/i.test(command)) return { severity: "unsafe", reason: "destructive Windows delete or format command." };
  if (/\bgit\s+clean\s+-[a-z]*(f[a-z]*d|d[a-z]*f)[a-z]*\b/i.test(command)) return { severity: "unsafe", reason: "git clean with force and directory flags deletes untracked files." };
  if (/\bgit\s+reset\s+--hard\b/.test(command)) return { severity: "unsafe", reason: "git reset --hard discards committed work." };
  if (/\bgit\s+push\s+(-f|--force|--force-with-lease)\b/.test(command)) return { severity: "unsafe", reason: "force-pushing to a shared branch." };
  if (/\bgit\s+checkout\s+--\b/.test(command)) return { severity: "unsafe", reason: "git checkout -- discards working-tree changes." };
  if (/\bDROP\s+(TABLE|DATABASE|INDEX)\b/i.test(command)) return { severity: "unsafe", reason: "SQL DROP statement destroys database objects." };
  if (/\bTRUNCATE\s+TABLE\b/i.test(command)) return { severity: "unsafe", reason: "SQL TRUNCATE TABLE destroys table contents." };
  if (/\b(shutdown|reboot|halt|poweroff)\b/.test(command)) return { severity: "unsafe", reason: "host shutdown or restart command." };
  if (/:\(\)\s*\{/.test(command)) return { severity: "unsafe", reason: "shell fork bomb." };

  const rmTargets = recursiveRmTargets(command);
  if (rmTargets !== null) {
    for (const target of rmTargets) {
      if (target === "/" || target === "/*" || target === "." || target === ".*" || target === ".." || target === "~" || target === "~/") {
        return { severity: "unsafe", reason: `rm -rf target '${target}' would delete the filesystem root, home, or the workspace itself.` };
      }
      if (/^[A-Za-z]:[\\/]/.test(target)) return { severity: "unsafe", reason: `rm -rf target '${target}' is an absolute Windows path.` };
      if (hasPathTraversal(target) || resolvesOutsideAllTrustedRoots(target, roots)) {
        return { severity: "unsafe", reason: `rm -rf target '${target}' resolves outside the workspace.` };
      }
    }
    return { severity: "ambiguous", reason: `rm -rf target '${rmTargets.join(" ")}' needs LLM review for data loss.` };
  }

  return null;
}

function recursiveRmTargets(command: string): string[] | null {
  const match = command.match(/\brm\s+((?:-[A-Za-z]+\s*)+|(?:--[a-z-]+\s*)+)(.*)$/i);
  if (!match) return null;
  const flags = match[1] ?? "";
  const flagText = flags.toLowerCase();
  const recursive = /(?:^|\s)-[a-z]*r/.test(flags) || flagText.includes("--recursive");
  const force = /(?:^|\s)-[a-z]*f/.test(flags) || flagText.includes("--force");
  if (!recursive || !force) return null;
  const tail = (match[2] ?? "").split(/[;|&><]/)[0] ?? "";
  const targets = tail.split(/\s+/).filter((token) => token.length > 0 && token !== "--");
  return targets.length > 0 ? targets : null;
}

function exfiltrationCommandReason(command: string): string | null {
  const lower = command.toLowerCase();

  if (/\bscp\b/.test(lower) || /\bsftp\b/.test(lower) || /\bftp\b/.test(lower)) {
    return "file transfer to a remote host.";
  }
  if (/\brsync\b/.test(lower) && /[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(command)) {
    return "rsync transfers files to a remote host.";
  }
  if (/\bcurl\b/.test(lower) && /(?:-T|--upload-file)\b/i.test(command)) {
    return "curl uploads a file to a remote host.";
  }
  if (/\bcurl\b/.test(lower) && /(?:-d|--data|--data-binary|--data-urlencode|-F|--form)\s+@/.test(command)) {
    return "curl sends local file contents to a remote host.";
  }
  if (/\bcurl\b/.test(lower) && /(?:-F|--form)\s+[A-Za-z0-9_.-]+=@/.test(command)) {
    return "curl uploads a local file as a form field to a remote host.";
  }
  if (/\bwget\b/.test(lower) && /--post-file/.test(lower)) {
    return "wget uploads a local file to a remote host.";
  }
  if (/\b(nc|netcat)\b/.test(lower) && (/<\s*[^\s|;]+/.test(command) || /--send-only/.test(lower))) {
    return "netcat pipes local data to a network endpoint.";
  }
  if (/\b(curl|wget|nc|netcat)\b/.test(lower) && (/\$\(/.test(command) || /`/.test(command))) {
    return "network command embeds shell output, which can transmit local data.";
  }
  if (/\b(curl|wget|nc|netcat)\b/.test(lower) && /\b(cat|env|printenv|head|tail)\b[^;|&]*[|]/.test(command)) {
    return "command pipes local file or environment data to a network endpoint.";
  }

  return null;
}

function absolutePathEscapeReason(command: string, roots: readonly string[]): string | null {
  const fileAccess = /\b(cat|head|tail|grep|rg|sed|awk|less|more|wc|ls|find|file|stat|cp|mv|rm|touch|mkdir|node|python3?|open|source)\b/i.test(command);
  if (!fileAccess) return null;
  const absolutePaths = command.match(/(?<![\w./-])\/[A-Za-z0-9._-][^\s"'`;|&<>]*/g) ?? [];
  for (const candidate of absolutePaths) {
    const cleaned = candidate.replace(/[,;)]+$/, "");
    if (!cleaned) continue;
    if (resolvesOutsideAllTrustedRoots(cleaned, roots)) return cleaned;
  }
  return null;
}

/** True when the command is only redirections whose every target is /dev/null. */
function isDevNullRedirectOnly(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const parts = trimmed.split(/\s+/);
  let index = 0;
  let sawRedirect = false;
  while (index < parts.length) {
    const part = parts[index];
    if (/^(?:[12]?|&)?>>?\/dev\/null$/.test(part)) {
      sawRedirect = true;
      index += 1;
      continue;
    }
    if (/^(?:[12]?|&)?>>?$/.test(part) && parts[index + 1] === "/dev/null") {
      sawRedirect = true;
      index += 2;
      continue;
    }
    return false;
  }
  return sawRedirect;
}

/** True for shell no-ops that read or write nothing outside /dev/null. */
function isHarmlessNoOp(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "true" || trimmed === ":") return true;
  if (/^true(?:\s+[A-Za-z0-9_./-]+)+$/.test(trimmed)) return true;
  if (/^:(?:\s+[A-Za-z0-9_./-]+)+$/.test(trimmed)) return true;
  return isDevNullRedirectOnly(trimmed);
}

function isKnownSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  return /^git\s+(diff|status|log|show|branch|rev-parse|grep|ls-files)\b/.test(trimmed)
    || /^(ls|find|grep|rg|cat|head|tail|wc|file|sort|uniq|diff|printf|echo|pwd|whoami|uname|date|which|command\s+-v)\b/.test(trimmed)
    || /^(node\s+test\/[\w./-]+|npm\s+(run\s+)?(test|build)(:[\w:-]*)?(\s|$)|npx\s+tsc\b|tsc\b)/.test(trimmed);
}

function classifyHttp(parameters: Record<string, unknown>): StaticToolSafetyVerdict {
  const url = stringValue(parameters.url);
  if (url === null || url.trim() === "") {
    return ambiguous("Http has no valid URL; the tool itself will reject the call.");
  }
  const secret = secretUrlReason(url);
  if (secret) return unsafe(`Http URL is unsafe: ${secret}`);
  return safe("Http performs a read-only GET against a URL with no embedded secret.");
}

function classifyHttpRequest(parameters: Record<string, unknown>): StaticToolSafetyVerdict {
  const url = stringValue(parameters.url);
  if (url === null || url.trim() === "") {
    return ambiguous("HttpRequest has no valid URL; the tool itself will reject the call.");
  }
  const urlSecret = secretUrlReason(url);
  if (urlSecret) return unsafe(`HttpRequest URL is unsafe: ${urlSecret}`);

  const method = typeof parameters.method === "string" && parameters.method.trim() !== "" ? parameters.method.toUpperCase() : "GET";

  const headers = parameters.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (SECRET_HEADER_NAMES.test(name)) {
        return unsafe(`HttpRequest header '${name}' carries a secret or credential.`);
      }
      if (typeof value === "string") {
        const secret = secretTextReason(value);
        if (secret) return unsafe(`HttpRequest header '${name}' is unsafe: ${secret}`);
      }
    }
  }

  if (typeof parameters.body === "string") {
    const bodySecret = secretTextReason(parameters.body);
    if (bodySecret) return unsafe(`HttpRequest body is unsafe: ${bodySecret}`);
    if (/data\.json/i.test(parameters.body)) {
      return unsafe("HttpRequest body references the protected file data.json.");
    }
  }

  if (method !== "GET") {
    return ambiguous(`HttpRequest ${method} is mutating and needs LLM safety review.`);
  }
  return safe("HttpRequest performs a read-only GET with no secret-bearing headers or body.");
}

function classifyGit(parameters: Record<string, unknown>, roots: readonly string[]): StaticToolSafetyVerdict {
  const cwd = stringValue(parameters.cwd);
  if (cwd !== null && cwd.trim() !== "") {
    if (hasPathTraversal(cwd) || resolvesOutsideAllTrustedRoots(cwd, roots)) {
      return unsafe(`Git cwd '${cwd}' resolves outside the workspace.`);
    }
  }

  const action = parameters.action;
  if (action === "list") return safe("Git list is a read-only status operation.");
  if (action === "stage") {
    const all = parameters.all === true;
    const paths = Array.isArray(parameters.paths) ? parameters.paths : [];
    if (all && paths.length > 0) return ambiguous("Git stage specifies both paths and all:true; the tool itself will reject the call.");
    if (all) return ambiguous("Git stage all:true can stage protected or secret files and needs LLM safety review.");
    if (paths.length === 0) return ambiguous("Git stage requires at least one path or all:true; the tool itself will reject the call.");
    for (const entry of paths) {
      const path = stringValue(entry);
      if (path === null) return ambiguous("Git stage contains a non-string path; the tool itself will reject the call.");
      const dataJson = dataJsonTargetReason(path);
      if (dataJson) return unsafe(dataJson);
      const protectedReason = protectedPathReason(path);
      if (protectedReason) return unsafe(`Git stage targets a protected file: ${protectedReason}`);
      if (hasPathTraversal(path) || resolvesOutsideAllTrustedRoots(path, roots)) {
        return unsafe(`Git stage path '${path}' resolves outside the workspace.`);
      }
    }
    return safe("Git stage paths stay within the workspace and target no protected files.");
  }
  if (action === "commit") {
    const message = stringValue(parameters.message);
    if (message === null || message.trim() === "") return ambiguous("Git commit has no non-empty message; the tool itself will reject the call.");
    const secret = secretTextReason(message);
    if (secret) return unsafe(`Git commit message is unsafe: ${secret}`);
    return safe("Git commit carries a non-sensitive message.");
  }
  return ambiguous(`Git action '${String(action)}' is not recognized; the tool itself will reject the call.`);
}

function classifyIntegrationTool(toolName: string, parameters: Record<string, unknown>): StaticToolSafetyVerdict {
  if (toolName === "SpecKeeperEnroll") {
    return safe("SpecKeeperEnroll redeems a one-time enrollment token for its intended purpose.");
  }

  const body = parameters.body;
  let bodyText = "";
  if (typeof body === "string") bodyText = body;
  else if (body && typeof body === "object") {
    try {
      bodyText = JSON.stringify(body);
    } catch {
      bodyText = "";
    }
  }
  if (bodyText) {
    if (/data\.json/i.test(bodyText)) {
      return unsafe(`${toolName} body references the protected file data.json.`);
    }
    const secret = secretTextReason(bodyText);
    if (secret) return unsafe(`${toolName} body is unsafe: ${secret}`);
  }

  const method = typeof parameters.method === "string" && parameters.method.trim() !== "" ? parameters.method.toUpperCase() : undefined;
  if (!method || method === "GET") {
    return safe(`${toolName} ${method ?? "request"} is read-only and carries no protected file content.`);
  }
  return ambiguous(`${toolName} ${method} is mutating and needs LLM safety review.`);
}

/**
 * Fast deterministic safety verdict for a tool name plus decoded parameters.
 * The returned decision is "safe", "unsafe", or "ambiguous". Ambiguous calls
 * are deferred to the LLM classifier by classifyToolCall().
 */
export function classifyToolCallStatically(
  toolName: string,
  parameters: unknown,
  options: {
    readonly workspaceRoot?: string;
    readonly allowedDirectories?: readonly string[];
    readonly toolSafetyConfig?: ToolSafetyConfig;
  } = {},
): StaticToolSafetyVerdict {
  if (typeof toolName !== "string" || toolName.trim() === "") {
    return unsafe("Tool name is missing or invalid; refusing to execute an unknown tool call.");
  }
  const record = parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? (parameters as Record<string, unknown>)
    : {};
  const roots = trustedRoots(options.workspaceRoot ?? process.cwd(), options.allowedDirectories);

  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "FileSize":
    case "ListDirectory":
      return classifyFileTool(toolName, record, roots);
    case "ExecuteCommand":
      return classifyExecuteCommand(record, roots);
    case "Http":
      return classifyHttp(record);
    case "HttpRequest":
      return classifyHttpRequest(record);
    case "Git":
      return classifyGit(record, roots);
    case "AgentBus":
    case "SpecKeeper":
    case "SpecKeeperEnroll":
      return classifyIntegrationTool(toolName, record);
    default:
      return unsafe(`Unknown tool '${toolName}' cannot be safety-classified; refusing to execute.`);
  }
}

function responseText(response: CompatibleResponse): string {
  return (response.output ?? [])
    .filter((output) => output.type === "message")
    .flatMap((output) => output.content ?? [])
    .filter((item) => item.type === "output_text" || item.type === "text")
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/**
 * Parse and validate the strict JSON object described in
 * prompts/tool-safety-classifier.md: `{ "safe": boolean, "reason": string }`.
 */
export function parseToolSafetyClassification(text: string): ToolSafetyParseResult {
  if (!text) return { valid: false, reason: "Tool safety response was empty." };
  const candidate = extractJsonCandidate(text);
  if (!candidate) return { valid: false, reason: "Tool safety response did not contain a JSON object." };
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    return { valid: false, reason: `Tool safety JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "Tool safety response must be a JSON object." };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.safe !== "boolean") return { valid: false, reason: "safe must be a boolean." };
  if (typeof record.reason !== "string" || !record.reason.trim()) return { valid: false, reason: "reason must be a non-empty string." };
  return { valid: true, safe: record.safe, reason: record.reason.trim() };
}

function fallbackClassification(reason: string): ToolSafetyClassification {
  return { safe: false, reason, source: "fallback" };
}

function readClassifierPrompt(promptPath: string, logger: NonNullable<ToolSafetyClassifierOptions["logger"]>): string | null {
  try {
    return readFileSync(promptPath, "utf-8");
  } catch (error) {
    logger("error", `[TOOL SAFETY] Could not read classifier prompt '${promptPath}': ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function llmClassification(
  toolName: string,
  normalizedParameters: string,
  runtime: MultiTurnLlmRuntime,
  promptPath: string,
  logger: NonNullable<ToolSafetyClassifierOptions["logger"]>,
): Promise<ToolSafetyClassification> {
  const template = readClassifierPrompt(promptPath, logger);
  if (template === null) {
    return fallbackClassification(`Safety classifier prompt '${promptPath}' could not be read; refusing to execute ambiguous call.`);
  }
  const basePrompt = `${template}\n${toolName}\n${normalizedParameters}\n`;
  let lastFailure: string | null = null;

  for (let attempt = 1; attempt <= MAX_TOOL_SAFETY_ATTEMPTS; attempt += 1) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nThe previous response was not valid JSON. Here's the error: ${lastFailure}. Please return valid JSON following this exact structure.`;

    let response: CompatibleResponse;
    try {
      response = await runtime.create({ input: prompt });
    } catch (error) {
      if (error instanceof RunAbortError) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      logger("error", `[TOOL SAFETY] LLM classification request failed for ${toolName}: ${lastFailure}`);
      break;
    }

    const parsed = parseToolSafetyClassification(responseText(response));
    if (parsed.valid) {
      return { safe: parsed.safe, reason: parsed.reason, source: "llm" };
    }
    lastFailure = parsed.reason;
    logger("error", `[TOOL SAFETY] ${toolName} classification response was not valid JSON on attempt ${attempt}/${MAX_TOOL_SAFETY_ATTEMPTS}: ${lastFailure}`);
  }

  return fallbackClassification(`Safety classifier failed for ambiguous ${toolName} call: ${lastFailure ?? "no valid response was produced"}; refusing to execute.`);
}

/**
 * Classify a proposed tool call. Fast static checks run first; ambiguous calls
 * are sent to the LLM classifier. If the LLM is unavailable or fails, the call
 * fails closed with source "fallback" rather than bypassing the safety check.
 */
export async function classifyToolCall(
  toolName: string,
  parameters: unknown,
  options: ToolSafetyClassifierOptions = {},
): Promise<ToolSafetyClassification> {
  const logger = options.logger ?? defaultLogger;
  const promptPath = options.promptPath ?? TOOL_SAFETY_PROMPT_PATH;
  const staticVerdict = classifyToolCallStatically(toolName, parameters, {
    workspaceRoot: options.workspaceRoot,
    allowedDirectories: options.allowedDirectories,
    toolSafetyConfig: options.toolSafetyConfig,
  });

  if (staticVerdict.decision === "safe") {
    const classification: ToolSafetyClassification = { safe: true, reason: staticVerdict.reason, source: "static" };
    logDecision(toolName, classification, logger);
    return classification;
  }
  if (staticVerdict.decision === "unsafe") {
    const classification: ToolSafetyClassification = { safe: false, reason: staticVerdict.reason, source: "static" };
    logDecision(toolName, classification, logger);
    return classification;
  }

  logger("info", `[TOOL SAFETY] ${toolName}: ambiguous static verdict (${staticVerdict.reason}); asking LLM classifier.`);
  if (!options.runtime) {
    const classification = fallbackClassification(`Safety classifier LLM is unavailable and ${toolName} call is ambiguous (${staticVerdict.reason}); refusing to execute.`);
    logDecision(toolName, classification, logger);
    return classification;
  }

  const normalizedParameters = normalizeToolParameters(parameters);
  const classification = await llmClassification(toolName, normalizedParameters, options.runtime, promptPath, logger);
  logDecision(toolName, classification, logger);
  return classification;
}
