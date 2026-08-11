import OpenAI from "openai";
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

const PROVIDER = "openai";

/** Settings accepted by the OpenAI factory. `apiKey` takes precedence over OPENAI_API_KEY. */
export interface OpenAiAdapterOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly organization?: string;
  readonly project?: string;
}

/** The small SDK surface used by this adapter, retained to permit isolated client injection in tests. */
export interface OpenAiResponsesClient {
  readonly responses: {
    create(request: Record<string, unknown>, options?: { signal?: AbortSignal }): PromiseLike<OpenAiResponse>;
  };
}

interface OpenAiResponse {
  readonly id?: string;
  readonly model?: string;
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string | null } | null;
  readonly output?: readonly OpenAiOutputItem[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
  } | null;
}

interface OpenAiOutputItem {
  readonly type: string;
  readonly id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}

export const openAiCapabilities: AdapterCapabilities = Object.freeze({
  toolCalling: true,
  systemMessages: true,
  developerMessages: true,
});

function configurationError(message: string): LlmAdapterError {
  return new LlmAdapterError(PROVIDER, "configuration", message);
}

function validateOptions(options: AdapterOptions): OpenAiAdapterOptions {
  const allowed = new Set(["apiKey", "baseURL", "organization", "project"]);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw configurationError(`Unsupported OpenAI adapter option '${key}'.`);
    if (typeof value !== "string") throw configurationError(`OpenAI adapter option '${key}' must be a string.`);
  }
  return options as OpenAiAdapterOptions;
}

function text(content: readonly TextContent[]): string {
  return content.map((part) => part.text).join("");
}

function translateMessage(message: ConversationMessage): Record<string, unknown>[] {
  switch (message.role) {
    case "system":
    case "developer":
    case "user":
      return [{
        role: message.role,
        content: [{ type: "input_text", text: text(message.content) }],
      }];
    case "assistant": {
      const items: Record<string, unknown>[] = [{
        role: "assistant",
        content: [{ type: "output_text", text: text(message.content) }],
      }];
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      return items;
    }
    case "tool":
      return [{
        type: "function_call_output",
        call_id: message.toolCallId,
        output: serializeOpenAiToolResult(message.content),
      }];
  }
}

function translateToolChoice(choice: GenerateRequest["toolChoice"]): unknown {
  if (!choice || typeof choice === "string") return choice;
  return { type: "function", name: choice.name };
}

function parseArguments(value: string | undefined, callName: string): JsonObject {
  if (value === undefined) {
    throw new LlmAdapterError(PROVIDER, "provider", `OpenAI returned function call '${callName}' without arguments.`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JsonObject;
  } catch {
    throw new LlmAdapterError(PROVIDER, "provider", `OpenAI returned invalid JSON arguments for function call '${callName}'.`);
  }
}

function responseMessage(response: OpenAiResponse): AssistantMessage {
  const content: TextContent[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: JsonObject }> = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
      }
    }
    if (item.type === "function_call") {
      if (!item.call_id || !item.name) {
        throw new LlmAdapterError(PROVIDER, "provider", "OpenAI returned a function call without an ID or name.");
      }
      toolCalls.push({ id: item.call_id, name: item.name, arguments: parseArguments(item.arguments, item.name) });
    }
  }
  return toolCalls.length === 0 ? { role: "assistant", content } : { role: "assistant", content, toolCalls };
}

function finishReason(response: OpenAiResponse, hasToolCalls: boolean): FinishReason {
  if (response.status === "cancelled") return "cancelled";
  if (response.incomplete_details?.reason === "max_output_tokens") return "length";
  if (response.incomplete_details?.reason === "content_filter") return "content_filter";
  if (hasToolCalls) return "tool_calls";
  return response.status === "completed" || response.status === undefined ? "stop" : "unknown";
}

function usage(response: OpenAiResponse): TokenUsage | undefined {
  if (!response.usage) return undefined;
  const { input_tokens, output_tokens, total_tokens, input_tokens_details } = response.usage;
  return {
    ...(input_tokens === undefined ? {} : { inputTokens: input_tokens }),
    ...(output_tokens === undefined ? {} : { outputTokens: output_tokens }),
    ...(total_tokens === undefined ? {} : { totalTokens: total_tokens }),
    ...(input_tokens_details?.cached_tokens === undefined ? {} : { cachedInputTokens: input_tokens_details.cached_tokens }),
  };
}

function classifyError(error: unknown): LlmAdapterError {
  if (error instanceof LlmAdapterError) return error;
  const candidate = error as { status?: unknown; name?: unknown; message?: unknown };
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const message = typeof candidate?.message === "string" && candidate.message.trim()
    ? `OpenAI request failed: ${candidate.message}`
    : "OpenAI request failed.";
  if (status === 401 || status === 403) return new LlmAdapterError(PROVIDER, "authentication", message);
  if (status === 400 || status === 404 || status === 422) return new LlmAdapterError(PROVIDER, "invalid_request", message);
  if (status === 429) return new LlmAdapterError(PROVIDER, "rate_limited", message, true);
  if (status !== undefined && status >= 500) return new LlmAdapterError(PROVIDER, "unavailable", message, true);
  if (candidate?.name === "APIConnectionError" || candidate?.name === "APIConnectionTimeoutError") {
    return new LlmAdapterError(PROVIDER, "unavailable", message, true);
  }
  return new LlmAdapterError(PROVIDER, "provider", message);
}

/** Stateless adapter over OpenAI's Responses API. */
export class OpenAiAdapter implements LlmAdapter {
  readonly provider = PROVIDER;
  readonly capabilities = openAiCapabilities;

  constructor(private readonly client: OpenAiResponsesClient) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const input = request.messages.flatMap(translateMessage);
    const payload: Record<string, unknown> = {
      model: request.model,
      input,
      store: false,
      ...(request.tools === undefined ? {} : {
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: tool.parameters,
        })),
      }),
      ...(request.toolChoice === undefined ? {} : { tool_choice: translateToolChoice(request.toolChoice) }),
      ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };
    try {
      const response = await this.client.responses.create(payload, { signal: request.signal });
      const message = responseMessage(response);
      const tokenUsage = usage(response);
      return {
        ...(response.id === undefined ? {} : { id: response.id }),
        model: response.model ?? request.model,
        message,
        finishReason: finishReason(response, message.toolCalls !== undefined && message.toolCalls.length > 0),
        ...(tokenUsage === undefined ? {} : { usage: tokenUsage }),
      };
    } catch (error) {
      throw classifyError(error);
    }
  }
}

/** Build the OpenAI adapter from explicit options, then OPENAI_API_KEY when not supplied. */
export function createOpenAiAdapter(options: AdapterOptions = {}): OpenAiAdapter {
  const settings = validateOptions(options);
  const environment = globalThis as { readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> } };
  const apiKey = settings.apiKey ?? environment.process?.env?.OPENAI_API_KEY;
  if (!apiKey?.trim()) {
    throw configurationError("OpenAI requires apiKey or OPENAI_API_KEY.");
  }
  const client = new OpenAI({
    apiKey,
    ...(settings.baseURL === undefined ? {} : { baseURL: settings.baseURL }),
    ...(settings.organization === undefined ? {} : { organization: settings.organization }),
    ...(settings.project === undefined ? {} : { project: settings.project }),
  });
  // The adapter exposes a deliberately narrower, provider-local surface than the SDK's full response union.
  return new OpenAiAdapter(client as unknown as OpenAiResponsesClient);
}

/** Factory suitable for explicit registration in LlmAdapterRegistry. */
export const openAiAdapterFactory: LlmAdapterFactory = Object.freeze({
  provider: PROVIDER,
  create: createOpenAiAdapter,
});

/** Serialize a portable JSON value for a function-call output. */
export function serializeOpenAiToolResult(value: JsonValue): string {
  return JSON.stringify(value);
}
