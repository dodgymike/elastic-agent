/**
 * Structured prompt/response logging for LLM interactions.
 *
 * Every LLM generation in the application flows through
 * `MultiTurnLlmRuntime.create()` (planning, step execution, tool
 * continuations, replanning, and retries). That single choke point invokes
 * these helpers to append timestamped, structured entries to `llm.log`
 * capturing the full prompt and full response without truncation.
 *
 * Logging is best-effort: failures to open, write, or serialize never
 * propagate to the caller so they can never break the application's normal
 * LLM flow.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Resolve the llm.log location. Defaults to `llm.log` in the process working
 * directory, overridable via the `LLM_LOG_PATH` environment variable.
 */
export function resolveLlmLogPath(): string {
  return process.env.LLM_LOG_PATH || "llm.log";
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
 * A structured entry written to llm.log. `prompt` and `response` carry the
 * full (untruncated) serialized content of the request and reply so the log
 * is a faithful, complete record of the conversation.
 */
export interface LlmLogRecord {
  timestamp: string;
  requestType: string;
  model: string;
  prompt: string;
  response: string;
  usage?: unknown;
  responseId?: string;
}

/**
 * Append a formatted prompt/response record to the LLM log file, creating the
 * parent directory and file when they do not yet exist.
 *
 * The record is written in a human-readable, line-oriented form:
 *
 *   ================================================================
 *   [timestamp] requestType=<type> model=<model>
 *   responseId=<id>
 *   --- PROMPT ---
 *   <full prompt>
 *   --- RESPONSE ---
 *   <full response>
 *   --- USAGE ---
 *   <usage json or "(none)">
 *   ================================================================
 *
 * Any failure (e.g. unwritable path, out-of-space) is swallowed so logging
 * can never interfere with the primary LLM flow.
 */
export function appendLlmLog(record: LlmLogRecord): void {
  try {
    const separator = "=".repeat(64);
    const usage = record.usage === undefined ? "(none)" : serialize(record.usage);
    const lines = [
      separator,
      `[${record.timestamp}] requestType=${record.requestType} model=${record.model}`,
      ...(record.responseId ? [`responseId=${record.responseId}`] : []),
      "--- PROMPT ---",
      record.prompt,
      "--- RESPONSE ---",
      record.response,
      "--- USAGE ---",
      usage,
      separator,
      "",
    ];
    const path = resolveLlmLogPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  } catch {
    // Best-effort only: never let logging failures affect the LLM flow.
  }
}

/** The request type tag when the prompt is an initial (non-continuation) text. */
export const REQUEST_TYPE_INITIAL = "initial";
/** The request type tag when the prompt is a tool-output continuation. */
export const REQUEST_TYPE_TOOL_CONTINUATION = "tool-continuation";

/**
 * Format the full prompt side of a generation as a single serialized JSON
 * document of the complete conversation messages.
 */
export function formatPrompt(messages: readonly { role: string; content?: unknown }[]): string {
  return serialize(messages);
}

/**
 * Format the full response side of a generation as a single serialized JSON
 * document of the assistant reply (text content plus any tool calls).
 */
export function formatResponse(message: { role: string; content?: unknown; toolCalls?: unknown }): string {
  return serialize(message);
}

export { nowIso };
