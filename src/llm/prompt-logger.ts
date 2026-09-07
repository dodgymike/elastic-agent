/**
 * Optional prompt logging for LLM interactions.
 *
 * When the `--log-prompts` flag is enabled, every LLM generation in the
 * application (planning, step execution, tool continuations, replanning, and
 * retries) funnels through `MultiTurnLlmRuntime.create()`, which invokes
 * `appendPromptLog()` here to append the finalized `messages` array (including
 * any injected session-memory context) to `prompt.log`.
 *
 * This is a *prompt-only* log: it records what was sent to the model, without
 * the response, so it is useful for auditing exactly what the model saw. The
 * general `llm.log` (see llm-log.ts) captures both prompt and response.
 *
 * Logging is best-effort: failures to open, write, or serialize never
 * propagate to the caller so they can never break the application's normal
 * LLM flow.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Resolve the prompt.log location. Defaults to `prompt.log` in the process
 * working directory, overridable via the `PROMPT_LOG_PATH` environment
 * variable.
 */
export function resolvePromptLogPath(): string {
  return process.env.PROMPT_LOG_PATH || "prompt.log";
}

function serialize(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A prompt-only record written to prompt.log. `prompt` carries the full
 * (untruncated) serialized `messages` array that was sent to the model,
 * including any memory-injected context.
 */
export interface PromptLogRecord {
  timestamp: string;
  requestType: string;
  model: string;
  prompt: string;
}

/**
 * Append a formatted prompt record to the prompt log file, creating the
 * parent directory and file when they do not yet exist.
 *
 * The record is written in a human-readable, line-oriented form:
 *
 *   ================================================================
 *   [timestamp] requestType=<type> model=<model>
 *   --- PROMPT ---
 *   <full prompt messages>
 *   ================================================================
 *
 * Any failure (e.g. unwritable path, out-of-space) is swallowed so logging
 * can never interfere with the primary LLM flow.
 */
export function appendPromptLog(record: PromptLogRecord): void {
  try {
    const separator = "=".repeat(64);
    const lines = [
      separator,
      `[${record.timestamp}] requestType=${record.requestType} model=${record.model}`,
      "--- PROMPT ---",
      record.prompt,
      separator,
      "",
    ];
    const path = resolvePromptLogPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  } catch {
    // Best-effort only: never let logging failures affect the LLM flow.
  }
}

/** The request type tag when the prompt is an initial (non-continuation) text. */
export const PROMPT_REQUEST_TYPE_INITIAL = "initial";
/** The request type tag when the prompt is a tool-output continuation. */
export const PROMPT_REQUEST_TYPE_TOOL_CONTINUATION = "tool-continuation";

/**
 * Format the full prompt side of a generation as a single serialized JSON
 * document of the complete conversation messages.
 */
export function formatPrompt(messages: readonly { role: string; content?: unknown }[]): string {
  return serialize(messages);
}
