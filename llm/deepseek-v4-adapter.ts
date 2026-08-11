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

function parseArguments(value: string | undefined, name: string): JsonObject {
  if (value === undefined) {
    throw new LlmAdapterError(PROVIDER, "provider", `DeepSeek returned function call '${name}' without arguments.`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as JsonObject;
  } catch {
    throw new LlmAdapterError(PROVIDER, "provider", `DeepSeek returned invalid JSON arguments for function call '${name}'.`);
  }
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
