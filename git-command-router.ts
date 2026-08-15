import { readFileSync } from "node:fs";
import type { CompatibleResponse, MultiTurnLlmRuntime } from "./llm/multi-turn-runtime.js";
import { RunAbortError } from "./llm/run-abort.js";
import { normalizeToolParameters, parseToolSafetyClassification } from "./tool-safety-classifier.js";

/**
 * Preflight router that keeps git commands out of ExecuteCommand.
 *
 * The dedicated `Git` tool owns the supported repository operations (status,
 * log, diff, ls-files, stage, commit). When a model still issues a git command
 * through `ExecuteCommand`, this module decides what should happen before the
 * general safety classifier runs:
 *
 * 1. Non-git commands are returned as `{ action: "none" }` and fall through to
 *    the normal ExecuteCommand path.
 * 2. Git commands whose subcommand maps unambiguously to a registered Git tool
 *    mode/action are refused with an actionable "use Git(...)" message.
 * 3. Git commands whose mapping is unclear (for example show, stash, worktree,
 *    tag, branch, checkout, config, check-ignore, rev-parse, push, or
 *    --version) are sent to the LLM classifier together with the available Git
 *    tool list. The classifier decides whether to allow the ExecuteCommand
 *    call; a refusal is returned verbatim and the call is blocked.
 *
 * The prompt receives only redacted command text. Decisions are logged with a
 * `[GIT ROUTER]` prefix; the module never logs raw parameter values.
 */

/** Prompt file loaded from the repository root, matching main.ts prompt loading. */
export const GIT_COMMAND_ROUTER_PROMPT_PATH =
  process.env.GIT_COMMAND_ROUTER_PROMPT_PATH ?? "prompts/git-command-router.md";

/** Mirrors the existing review/retry limits (one initial request plus two retries). */
const MAX_ROUTING_ATTEMPTS = 3;

export type GitCommandRoutingSource = "router" | "llm" | "fallback";

export type GitCommandRouting =
  | { readonly action: "none" }
  | { readonly action: "allow"; readonly reason: string; readonly source: GitCommandRoutingSource }
  | { readonly action: "refuse"; readonly reason: string; readonly source: GitCommandRoutingSource };

export interface GitCommandRouterOptions {
  /** LLM runtime used to classify unclear git commands. When omitted, unclear commands fail closed. */
  readonly runtime?: MultiTurnLlmRuntime;
  /** Override for the router prompt path (default prompts/git-command-router.md). */
  readonly promptPath?: string;
  /** Optional logger so tests can silence the default console output. */
  readonly logger?: (level: "info" | "error", message: string) => void;
}

/**
 * Global git options that consume the following token as their value. Skipping
 * these lets the router find the real subcommand in commands such as
 * `git -C /repo status` or `git -c core.pager=cat log`.
 */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
  "--config-env",
]);

const GIT_TOOL_LIST_TEXT = [
  'Git({ mode: "status" }) -> git status; params: format (short|porcelain|branch), branch (boolean), paths (string[])',
  'Git({ mode: "log" }) -> git log; params: oneline (boolean), stat (boolean), maxCount (positive integer), all (boolean), revision (string), path (string), paths (string[])',
  'Git({ mode: "diff" }) -> git diff; params: staged (boolean), stat (boolean), check (boolean), revision (string), paths (string[])',
  'Git({ mode: "ls-files" }) -> git ls-files; params: others (boolean), excludeStandard (boolean), paths (string[])',
  'Git({ action: "stage" }) -> git add; params: paths (string[]) or all (boolean)',
  'Git({ action: "commit" }) -> git commit; params: message (string)',
].join("\n");

function defaultLogger(level: "info" | "error", message: string): void {
  // Refusals are rendered through the normal tool-failure path, so only
  // classifier failures are logged by default to avoid duplicate noise.
  if (level === "error") console.error(message);
}

/**
 * Split Bash source into shell words. This is intentionally small and
 * permissive: it handles single/double quotes and backslash escapes so global
 * git options with quoted values can be skipped, without executing anything.
 */
export function tokenizeShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaped) current += "\\";
  if (current.length > 0) words.push(current);
  return words;
}

/**
 * Return the first non-option token after `git`, skipping global options that
 * take a value. Returns null for `git`, `git --version`, or an option-only
 * command, which the router treats as an unclear mapping.
 */
export function gitCommandSubcommand(command: string): string | null {
  const trimmed = command.trim();
  if (!/^git(?:\s|$)/.test(trimmed)) return null;

  const words = tokenizeShellWords(trimmed);
  if (words[0] !== "git") return null;

  for (let index = 1; index < words.length; index += 1) {
    const argument = words[index];
    if (argument === "--") {
      // `git -- <path>` has no subcommand and is not a clear tool mapping.
      return null;
    }
    if (argument.startsWith("-")) {
      if (GIT_VALUE_OPTIONS.has(argument)) {
        index += 1; // Consume the option value.
        continue;
      }
      if (/^--(?:git-dir|work-tree|exec-path|namespace|config-env)=/.test(argument)) continue;
      continue;
    }
    return argument;
  }

  return null;
}

/** Map a clear subcommand to an actionable refusal message, or return null. */
function clearGitRoute(subcommand: string | null): string | null {
  switch (subcommand) {
    case "status":
      return 'ExecuteCommand refuses git status because it maps to the Git tool. Use Git({ mode: "status" }) instead.';
    case "log":
      return 'ExecuteCommand refuses git log because it maps to the Git tool. Use Git({ mode: "log" }) instead.';
    case "diff":
      return 'ExecuteCommand refuses git diff because it maps to the Git tool. Use Git({ mode: "diff" }) instead.';
    case "ls-files":
      return 'ExecuteCommand refuses git ls-files because it maps to the Git tool. Use Git({ mode: "ls-files" }) instead.';
    case "add":
      return 'ExecuteCommand refuses git add because it maps to the Git tool. Use Git({ action: "stage", paths: ["<path>"] }) or Git({ action: "stage", all: true }) instead.';
    case "commit":
      return 'ExecuteCommand refuses git commit because it maps to the Git tool. Use Git({ action: "commit", message: "..." }) instead.';
    default:
      return null;
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

async function llmRoutingDecision(
  command: string,
  runtime: MultiTurnLlmRuntime,
  promptPath: string,
  logger: NonNullable<GitCommandRouterOptions["logger"]>,
): Promise<GitCommandRouting> {
  let template: string;
  try {
    template = readFileSync(promptPath, "utf-8");
  } catch (error) {
    const reason = `Git command router prompt '${promptPath}' could not be read; refusing to run the git command through ExecuteCommand: ${error instanceof Error ? error.message : String(error)}`;
    logger("error", `[GIT ROUTER] ${reason}`);
    return { action: "refuse", reason, source: "fallback" };
  }

  const basePrompt = `${template}\n${normalizeToolParameters({ command })}\n${GIT_TOOL_LIST_TEXT}\n`;
  let lastFailure: string | null = null;

  for (let attempt = 1; attempt <= MAX_ROUTING_ATTEMPTS; attempt += 1) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nThe previous response was not valid JSON. Here's the error: ${lastFailure}. Please return valid JSON following this exact structure.`;

    let response: CompatibleResponse;
    try {
      response = await runtime.create({ input: prompt });
    } catch (error) {
      if (error instanceof RunAbortError) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      logger("error", `[GIT ROUTER] LLM routing request failed: ${lastFailure}`);
      break;
    }

    const parsed = parseToolSafetyClassification(responseText(response));
    if (parsed.valid) {
      if (parsed.safe) {
        logger("info", `[GIT ROUTER] allowed git command through ExecuteCommand: ${parsed.reason}`);
        return { action: "allow", reason: parsed.reason, source: "llm" };
      }
      logger("info", `[GIT ROUTER] refused git command: ${parsed.reason}`);
      return { action: "refuse", reason: parsed.reason, source: "llm" };
    }
    lastFailure = parsed.reason;
    logger("error", `[GIT ROUTER] routing response was not valid JSON on attempt ${attempt}/${MAX_ROUTING_ATTEMPTS}: ${lastFailure}`);
  }

  const reason = `Git command router could not classify the git command (${lastFailure ?? "no valid response was produced"}); refusing to run it through ExecuteCommand. Use the Git tool when possible.`;
  return { action: "refuse", reason, source: "fallback" };
}

/**
 * Decide whether an ExecuteCommand call that starts with `git` should be
 * refused, allowed, or ignored. Clear mappings to the dedicated Git tool are
 * refused directly; unclear mappings are sent to the LLM router and fail
 * closed when no safe decision is produced.
 */
export async function routeGitExecuteCommand(
  command: unknown,
  options: GitCommandRouterOptions = {},
): Promise<GitCommandRouting> {
  const logger = options.logger ?? defaultLogger;

  if (typeof command !== "string" || command.trim() === "") return { action: "none" };
  const trimmed = command.trim();
  if (!/^git(?:\s|$)/.test(trimmed)) return { action: "none" };

  const words = tokenizeShellWords(trimmed);
  if (words[0] !== "git") return { action: "none" };

  const subcommand = gitCommandSubcommand(trimmed);
  const clearMessage = clearGitRoute(subcommand);
  if (clearMessage !== null) {
    return { action: "refuse", reason: clearMessage, source: "router" };
  }

  const promptPath = options.promptPath ?? GIT_COMMAND_ROUTER_PROMPT_PATH;
  if (!options.runtime) {
    const label = subcommand === null ? "git" : `git ${subcommand}`;
    const reason = `Git command router LLM is unavailable for ${label}; refusing to run it through ExecuteCommand. Use the Git tool when possible.`;
    logger("error", `[GIT ROUTER] ${reason}`);
    return { action: "refuse", reason, source: "fallback" };
  }

  return llmRoutingDecision(command, options.runtime, promptPath, logger);
}
