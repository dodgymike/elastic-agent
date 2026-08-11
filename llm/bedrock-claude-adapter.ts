import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
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

const PROVIDER = "bedrock-claude";

/**
 * Settings accepted by the Bedrock Claude factory. Explicit static credentials
 * take precedence over AWS's normal credential-provider chain (environment,
 * shared config, web identity, ECS, and instance role).
 */
export interface BedrockClaudeAdapterOptions {
  readonly region?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
}

/** Narrow client surface retained for isolated adapter tests. */
export interface BedrockConverseClient {
  converse(request: Record<string, unknown>, options?: { abortSignal?: AbortSignal }): PromiseLike<BedrockConverseResponse>;
}

interface BedrockConverseResponse {
  readonly $metadata?: { readonly requestId?: string };
  readonly output?: {
    readonly message?: {
      readonly content?: readonly BedrockContentBlock[];
    };
  };
  readonly stopReason?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cacheReadInputTokens?: number;
  };
}

interface BedrockContentBlock {
  readonly text?: string;
  readonly toolUse?: {
    readonly toolUseId?: string;
    readonly name?: string;
    readonly input?: unknown;
  };
}

export const bedrockClaudeCapabilities: AdapterCapabilities = Object.freeze({
  toolCalling: true,
  systemMessages: true,
  // Bedrock Converse has no separate developer role; it is faithfully carried as a labelled system instruction.
  developerMessages: true,
});

function configurationError(message: string): LlmAdapterError {
  return new LlmAdapterError(PROVIDER, "configuration", message);
}

function validateOptions(options: AdapterOptions): BedrockClaudeAdapterOptions {
  const allowed = new Set(["region", "accessKeyId", "secretAccessKey", "sessionToken"]);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw configurationError(`Unsupported Bedrock Claude adapter option '${key}'.`);
    if (typeof value !== "string") throw configurationError(`Bedrock Claude adapter option '${key}' must be a string.`);
  }
  const settings = options as BedrockClaudeAdapterOptions;
  if ((settings.accessKeyId === undefined) !== (settings.secretAccessKey === undefined)) {
    throw configurationError("Bedrock Claude requires both accessKeyId and secretAccessKey when either static credential is supplied.");
  }
  if (settings.sessionToken !== undefined && settings.accessKeyId === undefined) {
    throw configurationError("Bedrock Claude sessionToken requires accessKeyId and secretAccessKey.");
  }
  return settings;
}

function text(content: readonly TextContent[]): string {
  return content.map((part) => part.text).join("");
}

function systemBlocks(messages: readonly ConversationMessage[]): Record<string, unknown>[] | undefined {
  const blocks = messages.flatMap((message) => {
    if (message.role === "system") return [{ text: text(message.content) }];
    if (message.role === "developer") return [{ text: `Developer instructions:\n${text(message.content)}` }];
    return [];
  });
  return blocks.length === 0 ? undefined : blocks;
}

function translateMessage(message: ConversationMessage): Record<string, unknown> | undefined {
  switch (message.role) {
    case "system":
    case "developer":
      return undefined;
    case "user":
      return { role: "user", content: [{ text: text(message.content) }] };
    case "assistant": {
      const content: Record<string, unknown>[] = [];
      const messageText = text(message.content);
      if (messageText) content.push({ text: messageText });
      for (const call of message.toolCalls ?? []) {
        content.push({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments } });
      }
      if (content.length === 0) content.push({ text: "" });
      return { role: "assistant", content };
    }
    case "tool":
      return {
        role: "user",
        content: [{
          toolResult: {
            toolUseId: message.toolCallId,
            content: [{ json: message.content }],
            ...(message.isError ? { status: "error" } : {}),
          },
        }],
      };
  }
}

function translateToolChoice(choice: GenerateRequest["toolChoice"]): Record<string, unknown> | undefined {
  if (choice === undefined || choice === "auto") return choice === undefined ? undefined : { auto: {} };
  if (choice === "none") return undefined;
  if (choice === "required") return { any: {} };
  return { tool: { name: choice.name } };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseMessage(response: BedrockConverseResponse): AssistantMessage {
  const content: TextContent[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: JsonObject }> = [];
  for (const block of response.output?.message?.content ?? []) {
    if (typeof block.text === "string") content.push({ type: "text", text: block.text });
    if (block.toolUse) {
      const { toolUseId, name, input } = block.toolUse;
      if (!toolUseId || !name || !isJsonObject(input)) {
        throw new LlmAdapterError(PROVIDER, "provider", "Bedrock returned a tool use without an ID, name, or JSON-object input.");
      }
      toolCalls.push({ id: toolUseId, name, arguments: input });
    }
  }
  return toolCalls.length === 0 ? { role: "assistant", content } : { role: "assistant", content, toolCalls };
}

function finishReason(stopReason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls || stopReason === "tool_use") return "tool_calls";
  switch (stopReason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "content_filtered":
    case "guardrail_intervened": return "content_filter";
    default: return "unknown";
  }
}

function usage(response: BedrockConverseResponse): TokenUsage | undefined {
  const value = response.usage;
  if (!value) return undefined;
  return {
    ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
    ...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
    ...(value.cacheReadInputTokens === undefined ? {} : { cachedInputTokens: value.cacheReadInputTokens }),
  };
}

function classifyError(error: unknown): LlmAdapterError {
  if (error instanceof LlmAdapterError) return error;
  const candidate = error as { $metadata?: { httpStatusCode?: unknown }; name?: unknown; message?: unknown };
  const status = typeof candidate?.$metadata?.httpStatusCode === "number" ? candidate.$metadata.httpStatusCode : undefined;
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const detail = typeof candidate?.message === "string" && candidate.message.trim() ? `: ${candidate.message}` : "";
  const message = `Bedrock Claude request failed${detail}`;
  if (status === 401 || status === 403 || /AccessDenied|UnrecognizedClient|ExpiredToken/i.test(name)) return new LlmAdapterError(PROVIDER, "authentication", message);
  if (status === 400 || status === 404 || status === 422 || /ValidationException|ResourceNotFound/i.test(name)) return new LlmAdapterError(PROVIDER, "invalid_request", message);
  if (status === 429 || /Throttl/i.test(name)) return new LlmAdapterError(PROVIDER, "rate_limited", message, true);
  if ((status !== undefined && status >= 500) || /Timeout|ServiceUnavailable|Networking|RequestTimeout/i.test(name)) {
    return new LlmAdapterError(PROVIDER, "unavailable", message, true);
  }
  return new LlmAdapterError(PROVIDER, "provider", message);
}

/** Stateless adapter over Amazon Bedrock Converse for Anthropic Claude Sonnet models. */
export class BedrockClaudeAdapter implements LlmAdapter {
  readonly provider = PROVIDER;
  readonly capabilities = bedrockClaudeCapabilities;

  constructor(private readonly client: BedrockConverseClient) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const messages = request.messages.map(translateMessage).filter((message): message is Record<string, unknown> => message !== undefined);
    const system = systemBlocks(request.messages);
    const toolChoice = translateToolChoice(request.toolChoice);
    const payload: Record<string, unknown> = {
      modelId: request.model,
      messages,
      ...(system === undefined ? {} : { system }),
      ...(request.tools === undefined ? {} : {
        toolConfig: {
          tools: request.tools.map((tool) => ({
            toolSpec: {
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              inputSchema: { json: tool.parameters },
            },
          })),
          ...(toolChoice === undefined ? {} : { toolChoice }),
        },
      }),
      ...(request.maxOutputTokens === undefined && request.temperature === undefined ? {} : {
        inferenceConfig: {
          ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        },
      }),
    };
    try {
      const response = await this.client.converse(payload, { abortSignal: request.signal });
      const message = responseMessage(response);
      const tokenUsage = usage(response);
      return {
        ...(response.$metadata?.requestId === undefined ? {} : { id: response.$metadata.requestId }),
        model: request.model,
        message,
        finishReason: finishReason(response.stopReason, message.toolCalls !== undefined && message.toolCalls.length > 0),
        ...(tokenUsage === undefined ? {} : { usage: tokenUsage }),
      };
    } catch (error) {
      throw classifyError(error);
    }
  }
}

/** Build a Claude-on-Bedrock adapter using explicit settings before AWS's default credential chain. */
export function createBedrockClaudeAdapter(options: AdapterOptions = {}): BedrockClaudeAdapter {
  const settings = validateOptions(options);
  const environment = globalThis as { readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> } };
  const region = settings.region ?? environment.process?.env?.AWS_REGION ?? environment.process?.env?.AWS_DEFAULT_REGION;
  if (!region?.trim()) throw configurationError("Bedrock Claude requires region, AWS_REGION, or AWS_DEFAULT_REGION.");
  const client = new BedrockRuntimeClient({
    region,
    ...(settings.accessKeyId === undefined ? {} : {
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey!,
        ...(settings.sessionToken === undefined ? {} : { sessionToken: settings.sessionToken }),
      },
    }),
  });
  return new BedrockClaudeAdapter({
    converse: (request, requestOptions) => client.send(new ConverseCommand(request as never), requestOptions),
  });
}

/** Factory suitable for explicit registration in LlmAdapterRegistry. */
export const bedrockClaudeAdapterFactory: LlmAdapterFactory = Object.freeze({
  provider: PROVIDER,
  create: createBedrockClaudeAdapter,
});

/** Serialize a portable JSON value when a caller needs a textual tool-result audit representation. */
export function serializeBedrockToolResult(value: JsonValue): string {
  return JSON.stringify(value);
}
