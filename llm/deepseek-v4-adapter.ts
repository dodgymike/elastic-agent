import {
  type AdapterCapabilities,
  type AssistantMessage,
  type ConversationMessage,
  type FinishReason,
  type GenerateRequest,
  type GenerateResponse,
  type JsonObject,
  type JsonValue,
  LlmAdapterError,
  type LlmAdapter,
  type TextContent,
  type TokenUsage,
} from "./adapter-contract.js";
import type { AdapterOptions, LlmAdapterFactory } from "./adapter-registry.js";

const PROVIDER = "deepseek-v4";
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/** Settings accepted by the DeepSeek V4 factory. `apiKey` takes precedence over DEEPSEEK_API_KEY. */
export interface DeepSeekV4AdapterOptions {
  readonly apiKey?: string;
  /** OpenAI-compatible API root, including its version segment when required. */
  readonly baseURL?: string;
}

/** Narrow transport surface retained for isolated adapter tests and without requiring a provider SDK. */
export type DeepSeekFetch = (input: string, init: RequestInit) => PromiseLike<Response>;

interface DeepSeekChatCompletion {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly {
    readonly finish_reason?: string | null;
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly {
        readonly id?: string;
        readonly type?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
    readonly prompt_cache_hit_tokens?: number;
  };
}

export const deepSeekV4Capabilities: AdapterCapabilities = Object.freeze({
  toolCalling: true,
  systemMessages: true,
  // Chat Completions has no developer role; it is faithfully carried as labelled system text.
  developerMessages: true,
});

function configurationError(message: string): LlmAdapterError {
  return new LlmAdapterError(PROVIDER, "configuration", message);
}

function validateOptions(options: AdapterOptions): DeepSeekV4AdapterOptions {
  const allowed = new Set(["apiKey", "baseURL"]);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw configurationError(`Unsupported DeepSeek V4 adapter option '${key}'.`);
    if (typeof value !== "string") throw configurationError(`DeepSeek V4 adapter option '${key}' must be a string.`);
  }
  return options as DeepSeekV4AdapterOptions;
}

function text(content: readonly TextContent[]): string {
  return content.map((part) => part.text).join("");
}

function translateMessage(message: ConversationMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: text(message.content) };
    case "developer":
      return { role: "system", content: `Developer instructions:\n${text(message.content)}` };
    case "user":
      return { role: "user", content: text(message.content) };
    case "assistant":
      return {
        role: "assistant",
        content: text(message.content),
        ...(message.toolCalls === undefined ? {} : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: serializeDeepSeekToolResult(message.content, message.isError),
      };
  }
}

function translateToolChoice(choice: GenerateRequest["toolChoice"]): unknown {
  if (choice === undefined || typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function tryParseObject(candidate: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

/**
 * Count the net open-brace balance of `candidate` ({ count minus } count),
 * ignoring braces that occur inside double-quoted string literals (including
 * escaped characters). A positive result means closing braces are missing.
 */
function braceBalance(candidate: string): number {
  let balance = 0;
  let inString = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (ch === "\\") {
        i++; // Skip the escaped character.
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      balance++;
    } else if (ch === "}") {
      balance--;
    }
  }
  return balance;
}

/**
 * Count the net open-bracket balance of `candidate` ([ count minus ] count),
 * ignoring brackets that occur inside double-quoted string literals (including
 * escaped characters). A positive result means closing brackets are missing.
 */
function bracketBalance(candidate: string): number {
  let balance = 0;
  let inString = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (ch === "\\") {
        i++; // Skip the escaped character.
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      balance++;
    } else if (ch === "]") {
      balance--;
    }
  }
  return balance;
}

/**
 * Scan `candidate` forward from `openAt` (the index of an opening `{`) and
 * return the index of the `}` that closes that top-level object, i.e. the
 * first point where the brace depth (measured outside string literals) returns
 * to zero. Braces embedded in double-quoted string values (and their escape
 * sequences) are ignored, so values like `"a}b"` do not prematurely close the
 * object. Returns -1 when the object is truncated (no matching closing brace),
 * in which case the caller retains everything after `openAt` and completes the
 * missing closers during repair.
 */
function outerObjectEnd(candidate: string, openAt: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openAt; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (ch === "\\") {
        i++; // Skip the escaped character.
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1; // Truncated: the top-level object is never closed.
}

/**
 * Best-effort repair of common malformations in LLM-produced JSON: incomplete
 * JSON (missing closing braces/brackets), trailing commas, unquoted and
 * single-quoted keys/strings, `undefined` and bare or Python-style identifier
 * values, and comments. Each repair is applied in sequence with a parse
 * attempt; the first that yields a JSON object wins. Returns undefined when no
 * repair succeeds.
 */
function repairJson(candidate: string): JsonObject | undefined {
  let cleaned = candidate.replace(/^\uFEFF/, "");
  // Strip /* */ block comments and // line comments (outside string literals).
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"\\])\/\/[^\n\r]*/g, "$1");
  let parsed = tryParseObject(cleaned);
  if (parsed !== undefined) return parsed;
  // Complete missing closing braces/brackets by appending the net missing
  // count for each delimiter kind. Delimiters inside string literals (for
  // example content text) are ignored so embedded curly/square braces do not
  // corrupt the balance.
  const missingBraces = braceBalance(cleaned);
  const missingBrackets = bracketBalance(cleaned);
  if (missingBraces > 0 || missingBrackets > 0) {
    // Close nested arrays/objects in a tentative reverse order so a trailing
    // `]` before the final `}` in object-argument output parses.
    const closers = `${"]".repeat(missingBrackets)}${"}".repeat(missingBraces)}`;
    parsed = tryParseObject(cleaned + closers);
    if (parsed !== undefined) return parsed;
    // Fall back to closing each delimiter kind independently; this handles
    // cases where the naive concatenation order is rejected but a simpler
    // brace/bracket-only completion yields a parsable object.
    if (missingBrackets > 0) {
      parsed = tryParseObject(cleaned + "]".repeat(missingBrackets));
      if (parsed !== undefined) return parsed;
    }
    if (missingBraces > 0) {
      parsed = tryParseObject(cleaned + "}".repeat(missingBraces));
      if (parsed !== undefined) return parsed;
    }
  }
  // Remove trailing commas before a closing bracket/brace.
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  parsed = tryParseObject(cleaned);
  if (parsed !== undefined) return parsed;
  // Quote unquoted object keys (a bare identifier immediately before a colon).
  cleaned = cleaned.replace(/([{\[,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)\s*:/g, '$1"$2":');
  parsed = tryParseObject(cleaned);
  if (parsed !== undefined) return parsed;
  // Convert single-quoted strings to double-quoted strings (outside the quoted-key step above).
  cleaned = cleaned.replace(/'(?:\\.|[^'\\])*'/g, (m) => {
    const inner = m.slice(1, -1);
    return `"${inner.replace(/"/g, '\\"')}"`;
  });
  parsed = tryParseObject(cleaned);
  if (parsed !== undefined) return parsed;
  // Normalize Python-style booleans/none and JS undefined/bare identifiers to JSON values.
  cleaned = cleaned
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b|\bundefined\b|\bNaN\b|\bInfinity\b/g, "null");
  return tryParseObject(cleaned);
}

/** Mutable ledger of the strategy names attempted while resolving tool-call arguments. */
type ParseDiagnostics = { readonly attempts: string[] };

/**
 * Try to parse a JSON object from a string. Falls back to extracting JSON from
 * a fenced code block (```json ... ```), then to the first `{` to the matching
 * closing `}` span (stripping leading prose and trailing garbage), and finally
 * to repairing common malformations of the best candidate. Returns undefined
 * when none succeed. Records each attempted fallback strategy in
 * `diagnostics` for debugging when all attempts fail.
 */
function parseJsonObjectWithDiagnostics(value: string, diagnostics: ParseDiagnostics): JsonObject | undefined {
  const direct = tryParseObject(value);
  if (direct !== undefined) return direct;

  // Fallback: extract JSON from a fenced code block (```json ... ```).
  let candidate: string | undefined;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    diagnostics.attempts.push("fenced code block extraction");
    candidate = fenced[1].trim();
    const extracted = tryParseObject(candidate);
    if (extracted !== undefined) return extracted;
  }
  // Fallback: strip leading non-JSON text before the first `{` and trailing
  // garbage after the matching `}` when the value is wrapped in prose (or a
  // model preamble). Locating the true closing brace with `outerObjectEnd`
  // (rather than `lastIndexOf("}")`) keeps braces embedded in string values
  // from corrupting the span and trims trailing prose even when it itself
  // contains braces. When the object is truncated (no closing brace found),
  // everything after the first `{` is taken and the missing closers are
  // completed by the repair stage.
  const start = value.indexOf("{");
  if (start !== -1) {
    const end = outerObjectEnd(value, start);
    diagnostics.attempts.push("first-{ to matching-} extraction");
    candidate = value.slice(start, end === -1 ? undefined : end + 1).trim();
    const extracted = tryParseObject(candidate);
    if (extracted !== undefined) return extracted;
    // The stripped span may itself be malformed (missing closing
    // braces/brackets, unescaped quotes, missing commas, unquoted keys, ...).
    // Run the full repair on the stripped span so surrounding prose cannot
    // pollute the repair (for example misbalancing brace/bracket counts or
    // corrupting quote normalization). This extends quote/violation tolerance
    // to prose-wrapped malformed output.
    diagnostics.attempts.push("malformation repair (stripped span)");
    const repaired = repairJson(candidate);
    if (repaired !== undefined) return repaired;
  }
  // Fallback: repair common malformations in the best candidate available.
  if (candidate === undefined) candidate = value.trim();
  diagnostics.attempts.push("malformation repair");
  return repairJson(candidate);
}

function parseJsonObject(value: string): JsonObject | undefined {
  return parseJsonObjectWithDiagnostics(value, { attempts: [] });
}

function parseArguments(value: string | undefined, name: string): JsonObject {
  if (value === undefined) {
    throw new LlmAdapterError(PROVIDER, "provider", `DeepSeek returned function call '${name}' without arguments.`);
  }
  const diagnostics: ParseDiagnostics = { attempts: [] };
  const parsed = parseJsonObjectWithDiagnostics(value, diagnostics);
  if (parsed === undefined) {
    const attempts = diagnostics.attempts.length > 0 ? diagnostics.attempts.join(", ") : "direct JSON parse";
    throw new LlmAdapterError(
      PROVIDER,
      "provider",
      `DeepSeek returned invalid JSON arguments for function call '${name}'. ` +
      `All parsing strategies failed (${attempts}). Raw arguments for debugging: ${value}`,
    );
  }
  return parsed;
}

function responseMessage(response: DeepSeekChatCompletion): AssistantMessage {
  const choice = response.choices?.[0];
  if (!choice?.message) throw new LlmAdapterError(PROVIDER, "provider", "DeepSeek returned no completion choice.");
  const content = choice.message.content === null || choice.message.content === undefined
    ? []
    : [{ type: "text" as const, text: choice.message.content }];
  const toolCalls: Array<{ id: string; name: string; arguments: JsonObject }> = [];
  for (const call of choice.message.tool_calls ?? []) {
    const name = call.function?.name;
    if (call.type !== "function" || !call.id || !name) {
      throw new LlmAdapterError(PROVIDER, "provider", "DeepSeek returned a function call without an ID or name.");
    }
    toolCalls.push({ id: call.id, name, arguments: parseArguments(call.function?.arguments, name) });
  }
  return toolCalls.length === 0 ? { role: "assistant", content } : { role: "assistant", content, toolCalls };
}

function finishReason(reason: string | null | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls || reason === "tool_calls") return "tool_calls";
  switch (reason) {
    case "stop": return "stop";
    case "length": return "length";
    case "content_filter": return "content_filter";
    default: return "unknown";
  }
}

function usage(response: DeepSeekChatCompletion): TokenUsage | undefined {
  const value = response.usage;
  if (!value) return undefined;
  return {
    ...(value.prompt_tokens === undefined ? {} : { inputTokens: value.prompt_tokens }),
    ...(value.completion_tokens === undefined ? {} : { outputTokens: value.completion_tokens }),
    ...(value.total_tokens === undefined ? {} : { totalTokens: value.total_tokens }),
    ...(value.prompt_cache_hit_tokens === undefined ? {} : { cachedInputTokens: value.prompt_cache_hit_tokens }),
  };
}

function endpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}

function classifyError(error: unknown): LlmAdapterError {
  if (error instanceof LlmAdapterError) return error;
  const candidate = error as { status?: unknown; name?: unknown; message?: unknown };
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const detail = typeof candidate?.message === "string" && candidate.message.trim() ? `: ${candidate.message}` : "";
  const message = `DeepSeek V4 request failed${detail}`;
  if (status === 401 || status === 403) return new LlmAdapterError(PROVIDER, "authentication", message);
  if (status === 400 || status === 404 || status === 422) return new LlmAdapterError(PROVIDER, "invalid_request", message);
  if (status === 429) return new LlmAdapterError(PROVIDER, "rate_limited", message, true);
  if ((status !== undefined && status >= 500) || candidate?.name === "AbortError" || candidate?.name === "TypeError") {
    return new LlmAdapterError(PROVIDER, "unavailable", message, true);
  }
  return new LlmAdapterError(PROVIDER, "provider", message);
}

function providerFailure(status: number, statusText: string): LlmAdapterError {
  const message = `DeepSeek V4 request failed (${status} ${statusText || "unknown status"}).`;
  if (status === 401 || status === 403) return new LlmAdapterError(PROVIDER, "authentication", message);
  if (status === 400 || status === 404 || status === 422) return new LlmAdapterError(PROVIDER, "invalid_request", message);
  if (status === 429) return new LlmAdapterError(PROVIDER, "rate_limited", message, true);
  if (status >= 500) return new LlmAdapterError(PROVIDER, "unavailable", message, true);
  return new LlmAdapterError(PROVIDER, "provider", message);
}

/** Stateless adapter over DeepSeek's non-streaming OpenAI-compatible Chat Completions API. */
export class DeepSeekV4Adapter implements LlmAdapter {
  readonly provider = PROVIDER;
  readonly capabilities = deepSeekV4Capabilities;

  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string = DEFAULT_BASE_URL,
    private readonly fetcher: DeepSeekFetch = fetch,
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(translateMessage),
      stream: false,
      ...(request.tools === undefined ? {} : {
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parameters: tool.parameters,
          },
        })),
      }),
      ...(request.toolChoice === undefined ? {} : { tool_choice: translateToolChoice(request.toolChoice) }),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };
    try {
      const response = await this.fetcher(endpoint(this.baseURL), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: request.signal,
      });
      if (!response.ok) throw providerFailure(response.status, response.statusText);
      let completion: unknown;
      try {
        completion = await response.json();
      } catch (error) {
        throw new LlmAdapterError(PROVIDER, "provider", "DeepSeek returned an invalid JSON response.", false, { cause: error });
      }
      if (!completion || typeof completion !== "object" || Array.isArray(completion)) {
        throw new LlmAdapterError(PROVIDER, "provider", "DeepSeek returned an invalid completion response.");
      }
      const decoded = completion as DeepSeekChatCompletion;
      const message = responseMessage(decoded);
      const tokenUsage = usage(decoded);
      return {
        ...(decoded.id === undefined ? {} : { id: decoded.id }),
        model: decoded.model ?? request.model,
        message,
        finishReason: finishReason(decoded.choices?.[0]?.finish_reason, message.toolCalls !== undefined && message.toolCalls.length > 0),
        ...(tokenUsage === undefined ? {} : { usage: tokenUsage }),
      };
    } catch (error) {
      throw classifyError(error);
    }
  }
}

/** Build the DeepSeek V4 adapter from explicit options, then DEEPSEEK_API_KEY when not supplied. */
export function createDeepSeekV4Adapter(options: AdapterOptions = {}): DeepSeekV4Adapter {
  const settings = validateOptions(options);
  const environment = globalThis as { readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> } };
  const apiKey = settings.apiKey ?? environment.process?.env?.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw configurationError("DeepSeek V4 requires apiKey or DEEPSEEK_API_KEY.");
  const baseURL = settings.baseURL ?? DEFAULT_BASE_URL;
  if (!baseURL.trim()) throw configurationError("DeepSeek V4 baseURL must not be empty.");
  return new DeepSeekV4Adapter(apiKey, baseURL);
}

/** Factory suitable for explicit registration in LlmAdapterRegistry. */
export const deepSeekV4AdapterFactory: LlmAdapterFactory = Object.freeze({
  provider: PROVIDER,
  create: createDeepSeekV4Adapter,
});

/** Serialize a portable JSON value for a DeepSeek tool-result message. */
export function serializeDeepSeekToolResult(value: JsonValue, isError = false): string {
  return isError ? JSON.stringify({ error: value }) : JSON.stringify(value);
}
