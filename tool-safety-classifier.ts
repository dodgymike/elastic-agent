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
 *    - path traversal and absolute paths that escape the workspace (the
 *      workspace boundary is relaxed in Docker mode, where container-local
 *      filesystem access outside the startup directory is permitted);
 *    - destructive filesystem/database/host commands;
 *    - file/secret exfiltration commands;
 *    - command-injection shells;
 *    - secret material embedded in writes, commits, and HTTP requests.
 * 2. LLM classification for ambiguous calls using the shared base classifier
 *    prompt composed with the Docker or non-Docker filesystem-policy addendum
 *    selected from the runtime's isDocker flag (or AGENT_IN_DOCKER).
 * 3. A fail-closed fallback when the LLM is unavailable or its output cannot
 *    be parsed.
 *
 * Allowed decisions produce no console output; denied or fail-closed
 * decisions are logged with the [TOOL SAFETY] prefix through the supplied
 * logger. Parameter values are never logged; the LLM prompt receives only
 * normalized and redacted parameters.
 */

/**
 * Legacy/custom full classifier prompt. When TOOL_SAFETY_PROMPT_PATH is set
 * in the environment, that single file is used verbatim as the full classifier
 * prompt. When it is not set, classifyToolCall() composes the shared base
 * prompt with the Docker or non-Docker filesystem-policy addendum selected
 * from the runtime's isDocker flag (or AGENT_IN_DOCKER).
 */
export const TOOL_SAFETY_PROMPT_PATH = process.env.TOOL_SAFETY_PROMPT_PATH ?? "prompts/tool-safety-classifier.md";

/** Default shared classifier-policy body (no filesystem-policy addendum). */
export const TOOL_SAFETY_PROMPT_BASE_DEFAULT_PATH = "prompts/tool-safety-classifier.base.md";

/** Default Docker (relaxed) filesystem-policy addendum. */
export const TOOL_SAFETY_PROMPT_DOCKER_DEFAULT_PATH = "prompts/tool-safety-classifier.docker.md";

/** Default non-Docker (strict) filesystem-policy addendum. */
export const TOOL_SAFETY_PROMPT_NON_DOCKER_DEFAULT_PATH = "prompts/tool-safety-classifier.non-docker.md";

/** Which filesystem-policy addendum the classifier prompt composes. */
export type ToolSafetyPromptVariant = "docker" | "non-docker";

/** A resolved classifier-prompt source: one full file, or base + addendum. */
export type ResolvedToolSafetyPrompt =
  | { readonly kind: "full"; readonly path: string }
  | {
      readonly kind: "composed";
      readonly variant: ToolSafetyPromptVariant;
      readonly basePath: string;
      readonly addendumPath: string;
    };

/** Select the classifier-prompt variant for a runtime's Docker detection. */
export function resolveToolSafetyPromptVariant(isDocker: boolean): ToolSafetyPromptVariant {
  return isDocker ? "docker" : "non-docker";
}

/**
 * True when the AGENT_IN_DOCKER environment variable opts into the Docker
 * classifier prompt variant (accepted values: "1" or "true"). Callers with an
 * explicit runtimeConfig.isDocker should pass `isDocker` to classifyToolCall
 * instead of relying on this fallback.
 */
export function isDockerFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_IN_DOCKER === "1" || env.AGENT_IN_DOCKER === "true";
}

function absolutePromptPath(path: string, promptDirectory: string): string {
  return isAbsolute(path) ? path : resolve(promptDirectory, path);
}

/**
 * Resolve which classifier-prompt files to load for a Docker/non-Docker
 * runtime. An explicit TOOL_SAFETY_PROMPT_PATH environment variable always
 * wins and is used as a single full template; otherwise the shared base prompt
 * is composed with the selected Docker or non-Docker filesystem addendum.
 */
export function resolveToolSafetyPrompt(
  isDocker: boolean,
  promptDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedToolSafetyPrompt {
  if (env.TOOL_SAFETY_PROMPT_PATH) {
    return { kind: "full", path: absolutePromptPath(env.TOOL_SAFETY_PROMPT_PATH, promptDirectory) };
  }
  const variant = resolveToolSafetyPromptVariant(isDocker);
  const basePath = env.TOOL_SAFETY_PROMPT_BASE_PATH ?? TOOL_SAFETY_PROMPT_BASE_DEFAULT_PATH;
  const addendumPath = variant === "docker"
    ? (env.TOOL_SAFETY_PROMPT_DOCKER_PATH ?? TOOL_SAFETY_PROMPT_DOCKER_DEFAULT_PATH)
    : (env.TOOL_SAFETY_PROMPT_NON_DOCKER_PATH ?? TOOL_SAFETY_PROMPT_NON_DOCKER_DEFAULT_PATH);
  return {
    kind: "composed",
    variant,
    basePath: absolutePromptPath(basePath, promptDirectory),
    addendumPath: absolutePromptPath(addendumPath, promptDirectory),
  };
}

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

/**
 * Protected credential basenames as path tokens (not substrings), so `cat .env`
 * and `cat path/.env` are denied while `process.env` inside a grep pattern is
 * not mistaken for the `.env` file.
 */
const PROTECTED_FILE_PATH = /(?:^|[\s"'`/])(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|\.env|\.netrc|\.npmrc|\.pypirc|\.git-credentials)(?=[\s"'`/]|$)/i;

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
  /**
   * Docker/container detection result. When true (and no promptPath is
   * supplied), the classifier composes the Docker (relaxed) filesystem-policy
   * addendum with the shared base prompt; when false it uses the strict
   * non-Docker addendum. Defaults to AGENT_IN_DOCKER=1/true.
   */
  readonly isDocker?: boolean;
  /**
   * Directory against which relative classifier prompt paths are resolved.
   * Defaults to process.cwd(). Pass the startup working directory so prompt
   * resolution stays stable across later process.chdir() calls.
   */
  readonly promptDirectory?: string;
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

/**
 * Boundary-safe prefix check between two absolute paths. Returns true when
 * `candidate` is equal to `dir` or is a descendant of `dir`. The check uses
 * path.resolve plus path.relative, so a target such as `../outside` or an
 * absolute path cannot escape the configured boundary through traversal.
 */
function isInsideBoundary(candidate: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * True when `target` resolves inside at least one configured editable
 * directory. Relative targets are resolved against each directory in turn,
 * mirroring how tool paths are resolved relative to the runtime working
 * directory.
 */
function isInsideAnyBoundary(target: string, dirs: readonly string[]): boolean {
  if (dirs.length === 0) return false;
  const absoluteTarget = isAbsolute(target) ? resolve(target) : null;
  for (const dir of dirs) {
    const resolvedDir = resolve(dir);
    const candidate = absoluteTarget ?? resolve(resolvedDir, target);
    if (isInsideBoundary(candidate, resolvedDir)) return true;
  }
  return false;
}

/** De-duplicated absolute editable roots derived from the tool-safety config. */
function editableRoots(config: ToolSafetyConfig): string[] {
  return Array.from(new Set([resolve(config.agentSourceDir), resolve(config.startDir)]));
}

/**
 * Apply the configured edit/write policy to a file-mutating tool
 * (Write/Edit/Delete).
 * Returns a denial verdict when the policy forbids the edit, or null when the
 * call may continue through the normal file checks. A missing path yields null
 * so the existing tool-shape checks still produce the correct ambiguity error.
 */
function fileEditPolicyVerdict(
  toolName: string,
  target: string | null,
  config: ToolSafetyConfig,
  roots: readonly string[],
  allowOutsideWorkspace: boolean,
): StaticToolSafetyVerdict | null {
  if (target === null || target.trim() === "") return null;
  if (!config.allowAgentSourceModifications) {
    return unsafe(`${toolName} modifies files, which is denied because --allow-agent-source-modifications is not set.`);
  }
  // Docker mode relaxes the editable-directory boundary: writes are permitted
  // anywhere in the running container session. The edit/write gate above and
  // the protected-file checks in classifyFileTool still apply.
  if (!allowOutsideWorkspace && !isInsideAnyBoundary(target, roots)) {
    return unsafe(`${toolName} target '${target}' resolves outside the configured editable directories (--agent-source-dir and --start-dir).`);
  }
  return null;
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
    case "Delete":
    case "ExecuteCommand":
    case "Git":
    case "HttpRequest":
    case "AgentBus":
    case "AgentBusEnrol":
    case "SpecKeeper":
    case "SpecKeeperEnroll":
      return "mutating";
    default:
      return "unknown";
  }
}

function classifyFileTool(
  toolName: string,
  parameters: Record<string, unknown>,
  roots: readonly string[],
  allowOutsideWorkspace: boolean,
): StaticToolSafetyVerdict {
  const pathKey = toolName === "ListDirectory" ? "directory" : "path";
  const target = stringValue(parameters[pathKey]);
  if (target === null || target.trim() === "") {
    return ambiguous(`${toolName} has no valid '${pathKey}'; the tool itself will reject the call.`);
  }

  const dataJson = dataJsonTargetReason(target);
  if (dataJson) return unsafe(dataJson);

  const protectedReason = protectedPathReason(target);
  if (protectedReason) return unsafe(protectedReason);

  // Docker mode relaxes the workspace boundary and traversal to the container
  // boundary: container-local reads/writes outside the startup directory are
  // permitted for the running container session. The protected-file and
  // data.json checks above still apply in both modes.
  if (!allowOutsideWorkspace) {
    if (hasPathTraversal(target)) {
      return unsafe(`${toolName} path '${target}' contains '..' path traversal.`);
    }
    if (resolvesOutsideAllTrustedRoots(target, roots)) {
      return unsafe(`${toolName} path '${target}' resolves outside the workspace.`);
    }
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

  return safe(
    allowOutsideWorkspace
      ? `${toolName} target '${target}' is permitted for this container session and is not a protected file.`
      : `${toolName} target '${target}' stays within the workspace and is not a protected file.`,
  );
}

/** Split a shell command into words while separating redirection operators. */
function shellWords(command: string): string[] {
  return command
    .replace(/(>>|<<|<>|[<>])/g, " $1 ")
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

/** True when a path is the null device; the null device is never a real file target. */
function isNullDevicePath(target: string): boolean {
  const cleaned = target.replace(/[,;)]+$/, "");
  return cleaned === "/dev/null" || cleaned === "dev/null";
}

/** Return redirection targets that write to a real file (not an fd or /dev/null). */
function redirectionTargets(command: string): string[] {
  const words = shellWords(command);
  const targets: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const part = words[index];
    const isRedirect = [">", ">>", ">|"].includes(part)
      || /^[0-9]+>>?$/.test(part)
      || /^&>>?$/.test(part);
    if (!isRedirect) continue;
    const next = words[index + 1];
    if (!next || next.startsWith("&") || isNullDevicePath(next)) continue;
    targets.push(next.replace(/[,;)]+$/, ""));
  }
  return targets;
}

/** True when an ExecuteCommand invocation has a pattern that modifies files. */
function isFileModifyingCommand(command: string): boolean {
  const lower = command.toLowerCase();
  if (redirectionTargets(command).length > 0) return true;
  if (/^(touch|mkdir|rmdir|rm|unlink|cp|mv|ln|install|tee|chmod|chown|chgrp|truncate)\b/.test(lower)) return true;
  if (/\b(sed|perl|awk)\b[^\n;|&]*\s-i\b/.test(lower)) return true;
  if (/\bdd\b[^\n;|&]*\bof=/.test(lower)) return true;
  if (/\bgit\s+(add|mv|rm|restore|checkout|apply|stash)\b/.test(lower)) return true;
  return false;
}

/** Extract candidate paths that a file-modifying command may create or modify. */
function fileModificationTargets(command: string): string[] {
  const targets = redirectionTargets(command);
  const words = shellWords(command);
  const executable = (words[0] ?? "").toLowerCase();
  const lower = command.toLowerCase();
  const args = words.slice(1).filter((part) => ![">", ">>", ">|"].includes(part));
  const positional = args.filter((part) => !/^--?[A-Za-z]/.test(part));

  switch (executable) {
    case "touch":
    case "mkdir":
    case "rmdir":
    case "rm":
    case "unlink":
    case "chmod":
    case "chown":
    case "chgrp":
    case "truncate":
      targets.push(...positional);
      break;
    case "cp":
    case "mv":
    case "ln":
    case "install":
      if (positional.length > 0) targets.push(positional[positional.length - 1]);
      break;
    case "tee":
      targets.push(...positional);
      break;
    default:
      break;
  }

  if (/^sed\b/.test(executable) && /\s-i(?:\.\S+)?\b/.test(lower)) targets.push(...positional);
  if (/^(perl|awk)\b/.test(executable) && /\s-i(?:\.\S+)?\b/.test(lower)) targets.push(...positional);
  if (/^dd\b/.test(executable)) {
    const of = lower.match(/\bof=([^\s;&|<>]+)/);
    if (of) targets.push(of[1]);
  }
  if (/^git\b/.test(executable)) targets.push(...positional);

  return Array.from(new Set(targets.filter((part) => part.length > 0 && !isNullDevicePath(part))));
}

/**
 * Apply the configured edit/write policy to a file-modifying ExecuteCommand.
 * Returns a denial when modifications are disallowed, when the target paths
 * cannot be determined, or when a target escapes both editable directories.
 * Returns null when the command is not file-modifying or stays inside the
 * configured boundaries (the command may still be ambiguous for the LLM).
 */
function executeCommandEditPolicyVerdict(
  command: string,
  config: ToolSafetyConfig,
  roots: readonly string[],
  allowOutsideWorkspace: boolean,
): StaticToolSafetyVerdict | null {
  if (!isFileModifyingCommand(command)) return null;
  if (!config.allowAgentSourceModifications) {
    return unsafe("ExecuteCommand modifies files, which is denied because --allow-agent-source-modifications is not set.");
  }
  // Docker mode relaxes the editable-directory boundary; the remaining static
  // checks (destructive commands, exfiltration, injection, protected files)
  // still run after this policy gate.
  if (allowOutsideWorkspace) return null;
  const targets = fileModificationTargets(command);
  if (targets.length === 0) {
    return unsafe("ExecuteCommand modifies files but its target paths could not be determined for the configured editable directories.");
  }
  for (const target of targets) {
    if (!isInsideAnyBoundary(target, roots)) {
      return unsafe(`ExecuteCommand file target '${target}' resolves outside the configured editable directories (--agent-source-dir and --start-dir).`);
    }
  }
  return null;
}

function classifyExecuteCommand(
  parameters: Record<string, unknown>,
  roots: readonly string[],
  allowOutsideWorkspace: boolean,
  config?: ToolSafetyConfig,
  editRoots?: readonly string[],
): StaticToolSafetyVerdict {
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
  if (/(?:--include|--glob|-g)[= ]+["']?\*\.json["']?/i.test(allText)) {
    return unsafe("ExecuteCommand recursively includes *.json files, which would read the protected file data.json; data.json is never a valid tool target.");
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
  if (PROTECTED_FILE_PATH.test(command) && /\b(cat|head|tail|less|more|sed|awk|grep|rg|wc|file|cp|scp|rsync|base64|curl|wget|nc|netcat)\b/i.test(command)) {
    return unsafe("ExecuteCommand accesses a protected credential file.");
  }

  const destructiveCheck = destructiveCommandCheck(command, roots, allowOutsideWorkspace);
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

  if (config) {
    const policyVerdict = executeCommandEditPolicyVerdict(command, config, editRoots ?? editableRoots(config), allowOutsideWorkspace);
    if (policyVerdict) return policyVerdict;
  }

  if (!allowOutsideWorkspace) {
    const outsideReason = absolutePathEscapeReason(command, roots);
    if (outsideReason) return unsafe(`ExecuteCommand accesses a path outside the workspace: ${outsideReason}`);
  }

  if (isHarmlessNoOp(command)) {
    return safe("ExecuteCommand is a harmless no-op that reads or writes nothing outside /dev/null.");
  }

  if (isKnownSafeShell(command, roots)) {
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

function destructiveCommandCheck(
  command: string,
  roots: readonly string[],
  allowOutsideWorkspace: boolean,
): DestructiveCommandCheck | null {
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

  // In-workspace recursive deletes (for example `rm -rf test/.x-build` used by
  // build/test cleanup) are intentionally kept ambiguous rather than added to
  // the static allow-list: recursive deletion is irreversible and a mistyped
  // path could remove source. Build/test cleanup is already permitted when it
  // runs through `npm run test:*` or `npm run build`, because the classifier
  // then sees the npm script rather than the inner rm. Raw `rm -rf` stays
  // LLM-reviewed (fail-closed when the LLM is unavailable).
  const rmTargets = recursiveRmTargets(command);
  if (rmTargets !== null) {
    for (const target of rmTargets) {
      if (target === "/" || target === "/*" || target === "." || target === ".*" || target === ".." || target === "~" || target === "~/") {
        return { severity: "unsafe", reason: `rm -rf target '${target}' would delete the filesystem root, home, or the workspace itself.` };
      }
      if (/^[A-Za-z]:[\\/]/.test(target)) return { severity: "unsafe", reason: `rm -rf target '${target}' is an absolute Windows path.` };
      // Path traversal stays unsafe in both modes: a '..' rm target cannot be
      // safely distinguished from deleting the workspace or container root.
      // Docker mode relaxes only the absolute outside-workspace denial, so a
      // container-local absolute rm target falls through to LLM review rather
      // than being statically allowed.
      if (hasPathTraversal(target) || (!allowOutsideWorkspace && resolvesOutsideAllTrustedRoots(target, roots))) {
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

/** Quote-aware shell token used by the absolute-path scanner. */
interface ShellCommandToken {
  readonly text: string;
  readonly quoted: boolean;
  readonly start: number;
  readonly end: number;
}

/** Tokenize a shell command into words, quotes, and operators. */
function shellCommandTokens(command: string): ShellCommandToken[] {
  const tokens: ShellCommandToken[] = [];
  let index = 0;
  while (index < command.length) {
    const ch = command[index];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      const quote = ch;
      const start = index;
      index += 1;
      while (index < command.length) {
        if (quote === "\"" && command[index] === "\\" && index + 1 < command.length && (command[index + 1] === "\"" || command[index + 1] === "\\")) {
          index += 2;
          continue;
        }
        if (command[index] === quote) break;
        index += 1;
      }
      index += 1;
      tokens.push({ text: command.slice(start, index), quoted: true, start, end: index });
      continue;
    }
    if (";&|<>".includes(ch)) {
      const start = index;
      let operator = ch;
      if (index + 1 < command.length && command[index + 1] === ch) {
        operator += ch;
        index += 2;
      } else {
        index += 1;
      }
      tokens.push({ text: operator, quoted: false, start, end: index });
      continue;
    }
    const start = index;
    while (index < command.length && !/\s/.test(command[index]) && !"\"';|&<>".includes(command[index])) index += 1;
    tokens.push({ text: command.slice(start, index), quoted: false, start, end: index });
  }
  return tokens;
}

/** grep/rg flags whose next argument is a pattern, not a file path. */
const GREP_PATTERN_FLAGS = new Set([
  "-e", "--regexp", "-v", "--invert-match", "-E", "-F", "-G", "-P", "-w", "-x",
  "--include", "--exclude", "--exclude-dir", "--exclude-from", "--include-from",
]);

const GREP_INLINE_PATTERN_FLAGS = /^(?:--include|--exclude|--exclude-dir|--exclude-from|--include-from|--regexp)=/;

function blankToken(target: string[], item: ShellCommandToken): void {
  for (let index = item.start; index < item.end; index += 1) target[index] = " ";
}

/**
 * Blank shell regions that are not real file operands so the absolute-path
 * scanner does not mistake pattern text or an embedded script for a file
 * read:
 * - `node -e`/`--eval` script bodies (opaque to the shell and reviewed
 *   separately by the LLM classifier); and
 * - grep/rg pattern arguments (`-e`, `-v`, `--include`, `--exclude`, ...),
 *   whose values are patterns rather than paths.
 */
function maskNonFileOperandRegions(command: string): string {
  const tokens = shellCommandTokens(command);
  const masked = command.split("");
  let executable: string | null = null;
  let previousWord: ShellCommandToken | null = null;
  for (const token of tokens) {
    if (token.text === "&&" || token.text === "||" || token.text === ";" || token.text === "|" || token.text === "&") {
      executable = null;
      previousWord = null;
      continue;
    }
    if (token.text === ">" || token.text === ">>" || token.text === ">|" || token.text === "<" || token.text === "<<") {
      previousWord = null;
      continue;
    }
    if (executable === null && !token.text.startsWith("-")) {
      executable = token.text.toLowerCase().replace(/^["']+|["']+$/g, "");
      previousWord = token;
      continue;
    }
    const isNode = executable === "node" || executable === "node.exe";
    if (isNode && previousWord !== null && /^(?:-e|--eval)$/.test(previousWord.text)) {
      blankToken(masked, token);
      previousWord = token;
      continue;
    }
    const isGrep = executable === "grep" || executable === "rg";
    if (isGrep) {
      if (previousWord !== null && GREP_PATTERN_FLAGS.has(previousWord.text)) {
        blankToken(masked, token);
        previousWord = token;
        continue;
      }
      if (GREP_INLINE_PATTERN_FLAGS.test(token.text)) {
        blankToken(masked, token);
        previousWord = token;
        continue;
      }
    }
    previousWord = token;
  }
  return masked.join("");
}

function absolutePathEscapeReason(command: string, roots: readonly string[]): string | null {
  const fileAccess = /\b(cat|head|tail|grep|rg|sed|awk|less|more|wc|ls|find|file|stat|cp|mv|rm|touch|mkdir|node|python3?|open|source)\b/i.test(command);
  if (!fileAccess) return null;
  const scanSource = maskNonFileOperandRegions(command);
  const absolutePaths = scanSource.match(/(?<![\w./-])\/[A-Za-z0-9._-][^\s"'`;|&<>]*/g) ?? [];
  for (const candidate of absolutePaths) {
    const cleaned = candidate.replace(/[,;)]+$/, "");
    if (!cleaned || isNullDevicePath(cleaned)) continue;
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
  // Compound commands are reviewed segment-by-segment by isKnownSafeShell;
  // a bare prefix match here would let `npx tsc && <arbitrary>` hide a
  // trailing write or read.
  if (/&&|\|\||;/.test(trimmed)) return false;
  return /^git\s+(diff|status|log|show|branch|rev-parse|grep|ls-files)\b/.test(trimmed)
    || /^(ls|find|grep|rg|cat|head|tail|wc|file|sort|uniq|diff|printf|echo|pwd|whoami|uname|date|which|command\s+-v)\b/.test(trimmed)
    || /^(node\s+test\/[\w./-]+|npm\s+(run\s+)?(test|build)(:[\w:-]*)?(\s|$)|npx\s+tsc\b|tsc\b)/.test(trimmed);
}

/** Split a shell command on unquoted `&&`, `||`, and `;` operators. */
function splitShellSegments(command: string): string[] {
  const tokens = shellCommandTokens(command);
  const segments: string[] = [];
  let segmentStart = 0;
  for (const token of tokens) {
    if (token.text === "&&" || token.text === "||" || token.text === ";") {
      const segment = command.slice(segmentStart, token.start).trim();
      if (segment) segments.push(segment);
      segmentStart = token.end;
    }
  }
  const tail = command.slice(segmentStart).trim();
  if (tail) segments.push(tail);
  return segments;
}

/**
 * True when a shell command only changes into an allowed directory and then
 * runs known-safe read-only/verification commands. `cd <allowed-dir> && ...`
 * chains are validated recursively so a cwd change into the configured
 * start-dir (for example `cd /elastic-agent && git status`) is accepted as the
 * safe directory change it is, while a cwd change outside the trusted roots is
 * not.
 */
function isKnownSafeShell(command: string, roots: readonly string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const cdMatch = trimmed.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&\s*([\s\S]*)$/i);
  if (cdMatch) {
    const target = (cdMatch[1] ?? cdMatch[2] ?? cdMatch[3] ?? "").trim();
    if (target && !hasPathTraversal(target) && !resolvesOutsideAllTrustedRoots(target, roots)) {
      return isKnownSafeShell(cdMatch[4], roots);
    }
    return false;
  }

  const segments = splitShellSegments(trimmed);
  if (segments.length > 1) return segments.every((segment) => isKnownSafeShell(segment, roots));
  return isKnownSafeCommand(trimmed);
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

  // Normalize Git's read-only `mode` values into the read-only action space.
  // `mode: "status" | "log" | "diff" | "ls-files"` selects a read-only git
  // subcommand, and `action: "list"` remains the legacy read-only status alias.
  // The Git tool has no `command` parameter, so only `mode` is available as a
  // fallback when `action` is missing. Empty strings count as missing so a
  // malformed selector still falls back deterministically.
  const requestedAction = stringValue(parameters.action);
  const requestedMode = stringValue(parameters.mode);
  const action = requestedAction !== null && requestedAction.trim() !== ""
    ? requestedAction
    : requestedMode !== null && requestedMode.trim() !== ""
      ? requestedMode
      : null;
  if (action === "list") return safe("Git list is a read-only status operation.");
  if (action === "status" || action === "log" || action === "diff" || action === "ls-files") {
    return safe(`Git ${action} is a read-only operation.`);
  }
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
  if (action === null) {
    return unsafe("Git call has neither a recognized action nor a recognized mode; the tool itself will reject the call.");
  }
  return unsafe(`Git selector '${action}' is not a recognized action or mode; the tool itself will reject the call.`);
}

function classifyIntegrationTool(toolName: string, parameters: Record<string, unknown>, roots: readonly string[]): StaticToolSafetyVerdict {
  if (toolName === "SpecKeeperEnroll") {
    return safe("SpecKeeperEnroll redeems a one-time enrollment token for its intended purpose.");
  }
  if (toolName === "AgentBus") {
    return classifyAgentBus(parameters, roots);
  }
  if (toolName === "AgentBusEnrol") {
    return classifyAgentBusEnrol(parameters, roots);
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
 * Static classification for `AgentBus`, which talks to the bus through the
 * local `agent-busctl` CLI as an explicit inter-agent communication channel.
 * It whitelists the `whoami`, `watch` (long-poll wait), and `send` actions,
 * along with the `--identity`, `--persist-session`, `--for`, `--count`,
 * `--json`, `--verify`, and `--bus` flags. Messages sent between agents are
 * agent-to-agent coordination traffic, never store exfiltration: a `send`
 * message that embeds protected store contents is refused.
 */
function classifyAgentBus(parameters: Record<string, unknown>, roots: readonly string[]): StaticToolSafetyVerdict {
  const actionParam = stringValue(parameters.action);
  let action: string;
  if (actionParam !== null && actionParam.trim() !== "") {
    action = actionParam.trim().toLowerCase();
  } else if (typeof parameters.to === "string" && parameters.to.trim() !== "") {
    action = "send";
  } else if (
    (typeof parameters.forDuration === "string" && parameters.forDuration.trim() !== "") ||
    typeof parameters.count === "number"
  ) {
    action = "watch";
  } else {
    action = "whoami";
  }

  if (action !== "whoami" && action !== "watch" && action !== "send") {
    return unsafe(
      `AgentBus action '${action}' is not a supported agent-busctl subcommand (whoami, watch, send); refusing to execute.`,
    );
  }

  for (const key of ["identity", "binary", "root"]) {
    const value = stringValue(parameters[key]);
    if (value === null || value === undefined || value.trim() === "") continue;
    if (/[\r\n\0]/.test(value)) return unsafe(`AgentBus ${key} must not contain control characters.`);
    const dataJson = dataJsonTargetReason(value);
    if (dataJson) return unsafe(`AgentBus ${key} is unsafe: ${dataJson}`);
    const protectedReason = protectedPathReason(value);
    if (protectedReason) return unsafe(`AgentBus ${key} is unsafe: ${protectedReason}`);
    if (hasPathTraversal(value)) return unsafe(`AgentBus ${key} '${value}' contains '..' path traversal.`);
    if (resolvesOutsideAllTrustedRoots(value, roots)) {
      return unsafe(`AgentBus ${key} '${value}' resolves outside the workspace.`);
    }
  }

  const toValue = stringValue(parameters.to);
  if (toValue !== null && /[\r\n\0]/.test(toValue)) {
    return unsafe("AgentBus recipient 'to' must not contain control characters.");
  }

  if (action === "send") {
    const message = stringValue(parameters.message);
    if (message !== null && /data\.json/i.test(message)) {
      return unsafe("AgentBus send message references the protected file data.json.");
    }
    if (message !== null) {
      const flagged = secretTextReason(message);
      if (flagged) return unsafe(`AgentBus send message is unsafe: ${flagged}`);
    }
  }

  return safe(
    action === "send"
      ? "AgentBus send is agent-to-agent communication and carries no protected store contents."
      : `AgentBus ${action} is inter-agent communication over agent-busctl and carries no protected store contents.`,
  );
}

/**
 * Static classification for `AgentBusEnrol`. The tool redeems an agent-bus
 * invite through the local `agent-busctl` and writes only non-credential
 * roster metadata to `.agent-bus.local` (mode 0600) plus the identity key to
 * an in-workspace identity store. It rigorously validates the invite itself
 * (rejects `data.json`, refuses paths outside the workspace, and refuses
 * `.agent-bus.local`). Mirror the `SpecKeeperEnroll` treatment (safe for its
 * intended purpose) while refusing obviously hostile / unprotected parameter
 * values (control characters, embedded secrets, an invite file outside the
 * workspace, or the runtime's protected data store).
 */
function classifyAgentBusEnrol(parameters: Record<string, unknown>, roots: readonly string[]): StaticToolSafetyVerdict {
  const pathValues: Array<{ readonly key: string; readonly value: string }> = [];
  for (const key of ["inviteFile", "identity", "rootDir"]) {
    const value = stringValue(parameters[key]);
    if (value !== null && value !== undefined && value.trim() !== "") {
      pathValues.push({ key, value });
    }
  }
  const agentName = stringValue(parameters.name);

  if (agentName !== null && /[\r\n\0]/.test(agentName)) {
    return unsafe("AgentBusEnrol name must not contain control characters.");
  }
  for (const entry of pathValues) {
    if (/[\r\n\0]/.test(entry.value)) {
      return unsafe(`AgentBusEnrol ${entry.key} must not contain control characters.`);
    }
    const flagged = secretTextReason(entry.value);
    if (flagged) return unsafe(`AgentBusEnrol ${entry.key} is unsafe: ${flagged}`);

    // The invite (and identity/root dirs) must stay inside the workspace and
    // must not name the protected data store or the roster itself.
    if (entry.key === "inviteFile") {
      const base = baseNameOf(entry.value);
      if (base === "data.json" || base === ".agent-bus.local") {
        return unsafe(`AgentBusEnrol refuses to read '${base}' as an invite file.`);
      }
    }
    if (hasPathTraversal(entry.value)) {
      return unsafe(`AgentBusEnrol ${entry.key} '${entry.value}' contains '..' path traversal.`);
    }
    if (resolvesOutsideAllTrustedRoots(entry.value, roots)) {
      return unsafe(`AgentBusEnrol ${entry.key} '${entry.value}' resolves outside the workspace.`);
    }
  }
  return safe("AgentBusEnrol redeems an in-workspace agent-bus invite for its intended purpose.");
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
    /**
     * Docker/container detection result. When true, filesystem reads and
     * writes outside the workspace/startup directory are permitted for the
     * running container session, while data.json, credential/secret files, and
     * unsafe commands remain protected. Defaults to false (strict boundary)
     * so callers opt in with the same flag that selects the Docker prompt.
     */
    readonly isDocker?: boolean;
  } = {},
): StaticToolSafetyVerdict {
  if (typeof toolName !== "string" || toolName.trim() === "") {
    return unsafe("Tool name is missing or invalid; refusing to execute an unknown tool call.");
  }
  const record = parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? (parameters as Record<string, unknown>)
    : {};
  const roots = trustedRoots(options.workspaceRoot ?? process.cwd(), options.allowedDirectories);
  const config = options.toolSafetyConfig;
  const allowOutsideWorkspace = options.isDocker === true;

  // --disable-classifier bypasses all safety classification. The returned
  // safe verdict is silent by contract, so no safety response is rendered.
  if (config && !config.enabled) {
    return safe("Tool safety classifier is disabled by --disable-classifier; call allowed without a safety review.");
  }

  const policyRoots = config ? editableRoots(config) : roots;
  const combinedRoots = config ? Array.from(new Set([...roots, ...policyRoots])) : roots;

  switch (toolName) {
    case "Read":
    case "FileSize":
    case "ListDirectory":
      return classifyFileTool(toolName, record, roots, allowOutsideWorkspace);
    case "Write":
    case "Edit":
    case "Delete": {
      if (config) {
        const target = stringValue(record.path);
        const policyVerdict = fileEditPolicyVerdict(toolName, target, config, policyRoots, allowOutsideWorkspace);
        if (policyVerdict) return policyVerdict;
        return classifyFileTool(toolName, record, policyRoots, allowOutsideWorkspace);
      }
      return classifyFileTool(toolName, record, roots, allowOutsideWorkspace);
    }
    case "ExecuteCommand":
      return classifyExecuteCommand(record, combinedRoots, allowOutsideWorkspace, config, policyRoots);
    case "Http":
      return classifyHttp(record);
    case "HttpRequest":
      return classifyHttpRequest(record);
    case "Git":
      return classifyGit(record, roots);
    case "AgentBus":
    case "AgentBusEnrol":
    case "SpecKeeper":
    case "SpecKeeperEnroll":
      return classifyIntegrationTool(toolName, record, roots);
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
 * Parse and validate the strict JSON object described in the composed
 * tool-safety classifier prompt: `{ "safe": boolean, "reason": string }`.
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

function readClassifierPromptFile(path: string, logger: NonNullable<ToolSafetyClassifierOptions["logger"]>): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    logger("error", `[TOOL SAFETY] Could not read classifier prompt '${path}': ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function describeResolvedToolSafetyPrompt(prompt: ResolvedToolSafetyPrompt): string {
  return prompt.kind === "full"
    ? prompt.path
    : `${prompt.basePath} + ${prompt.addendumPath} (${prompt.variant} filesystem policy)`;
}

function readClassifierPromptTemplate(
  prompt: ResolvedToolSafetyPrompt,
  logger: NonNullable<ToolSafetyClassifierOptions["logger"]>,
): string | null {
  if (prompt.kind === "full") {
    return readClassifierPromptFile(prompt.path, logger);
  }
  const base = readClassifierPromptFile(prompt.basePath, logger);
  if (base === null) return null;
  const addendum = readClassifierPromptFile(prompt.addendumPath, logger);
  if (addendum === null) return null;
  return `${base.replace(/\s+$/, "")}\n\n${addendum.replace(/^\s+/, "")}`;
}

async function llmClassification(
  toolName: string,
  normalizedParameters: string,
  runtime: MultiTurnLlmRuntime,
  prompt: ResolvedToolSafetyPrompt,
  logger: NonNullable<ToolSafetyClassifierOptions["logger"]>,
): Promise<ToolSafetyClassification> {
  const template = readClassifierPromptTemplate(prompt, logger);
  if (template === null) {
    return fallbackClassification(`Safety classifier prompt '${describeResolvedToolSafetyPrompt(prompt)}' could not be read; refusing to execute ambiguous call.`);
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
  const promptDirectory = options.promptDirectory ?? process.cwd();
  const resolvedPrompt: ResolvedToolSafetyPrompt = options.promptPath
    ? { kind: "full", path: absolutePromptPath(options.promptPath, promptDirectory) }
    : resolveToolSafetyPrompt(options.isDocker ?? isDockerFromEnvironment(process.env), promptDirectory, process.env);
  const staticVerdict = classifyToolCallStatically(toolName, parameters, {
    workspaceRoot: options.workspaceRoot,
    allowedDirectories: options.allowedDirectories,
    toolSafetyConfig: options.toolSafetyConfig,
    isDocker: options.isDocker ?? isDockerFromEnvironment(process.env),
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
  const classification = await llmClassification(toolName, normalizedParameters, options.runtime, resolvedPrompt, logger);
  logDecision(toolName, classification, logger);
  return classification;
}
