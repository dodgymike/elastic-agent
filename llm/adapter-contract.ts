/**
 * Provider-neutral LLM adapter contract.
 *
 * Adapters translate this contract to a provider SDK or HTTP API.  The
 * contract deliberately contains no provider SDK objects, credentials, or raw
 * provider responses so callers can switch providers without changing their
 * execution flow.  Provider selection and construction belong to the registry
 * introduced in the next implementation step.
 */

/** A configured provider identifier. Built-in providers may use stable names such as "openai" or "bedrock". */
export type ProviderId = string;

/** JSON values accepted in tool schemas and tool-call arguments. */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Text-only content keeps all providers on the portable common denominator. */
export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface SystemMessage {
  readonly role: "system" | "developer";
  readonly content: readonly TextContent[];
}

export interface UserMessage {
  readonly role: "user";
  readonly content: readonly TextContent[];
}

/** A normalized function invocation returned by a model. Arguments must be decoded JSON objects. */
export interface ToolCall {
  /** Unique within a generation response and reused by the matching tool result. */
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly TextContent[];
  readonly toolCalls?: readonly ToolCall[];
}

/** A tool result is represented as JSON rather than provider-specific serialized payloads. */
export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: JsonValue;
  /** Set by the caller when the invoked tool failed without terminating the model turn. */
  readonly isError?: boolean;
}

export type ConversationMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** Portable function-tool declaration using the JSON Schema object subset accepted by the selected provider. */
export interface ToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly parameters: JsonObject;
  /**
   * Repository-relative path to a per-tool usage prompt file (for example
   * tools/read-usage.md). The LLM is instructed to read this file before
   * calling the tool for the first time. Provider adapters must not forward
   * this metadata in their provider tool payloads.
   */
  readonly usage_prompt?: string;
}

export type ToolChoice = "auto" | "none" | "required" | { readonly name: string };

/**
 * A complete conversation is supplied on every call. This avoids coupling the
 * runtime to provider-specific response IDs or server-side conversation state.
 */
export interface GenerateRequest {
  readonly model: string;
  readonly messages: readonly ConversationMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "cancelled" | "unknown";

/** Normalized token accounting. Omitted fields mean the provider did not report that value. */
export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
}

/**
 * A portable generation result. `message` contains the assistant text and any
 * tool calls; adapters must not expose provider response objects here.
 */
export interface GenerateResponse {
  readonly id?: string;
  readonly model: string;
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

/** Capabilities advertise optional behavior without changing the call contract. */
export interface AdapterCapabilities {
  readonly toolCalling: boolean;
  readonly systemMessages: boolean;
  readonly developerMessages: boolean;
}

/** The only interface the application uses to invoke an LLM provider. */
export interface LlmAdapter {
  readonly provider: ProviderId;
  readonly capabilities: AdapterCapabilities;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}

/**
 * Error category exposed by adapters. Callers can distinguish configuration
 * errors from retryable provider failures without inspecting SDK error shapes.
 */
export type AdapterErrorCode = "authentication" | "configuration" | "invalid_request" | "rate_limited" | "unavailable" | "provider";

export class LlmAdapterError extends Error {
  readonly provider: ProviderId;
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;

  constructor(provider: ProviderId, code: AdapterErrorCode, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "LlmAdapterError";
    this.provider = provider;
    this.code = code;
    this.retryable = retryable;
  }
}
