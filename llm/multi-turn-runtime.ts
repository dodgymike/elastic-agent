import {
  type AssistantMessage,
  type ConversationMessage,
  type FinishReason,
  type GenerateResponse,
  type JsonObject,
  type JsonValue,
  type LlmAdapter,
  LlmAdapterError,
  type ToolDefinition,
  type ToolResultMessage,
} from "./adapter-contract.js";
import { type MemoryContextResult, type MemoryModule } from "../memory/types.js";
import { type RunAbortPhase, throwIfAborted } from "./run-abort.js";
import {
  appendLlmLog,
  formatPrompt,
  formatResponse,
  nowIso,
  REQUEST_TYPE_INITIAL,
  REQUEST_TYPE_TOOL_CONTINUATION,
  type LlmLogRecord,
} from "./llm-log.js";

/** OpenAI-Responses-shaped subset consumed by the legacy main.ts executor. */
export interface CompatibleResponse {
  readonly id: string;
  readonly output: readonly CompatibleOutput[];
  readonly usage?: CompatibleUsage;
  /** Provider-normalized finish reason, exposed for unable-to-complete detection. */
  readonly finishReason?: FinishReason;
}
export type CompatibleOutput = CompatibleMessageOutput | CompatibleFunctionCallOutput;
export interface CompatibleMessageOutput {
  readonly type: "message";
  readonly status: "completed";
  readonly content: readonly { readonly type: "output_text"; readonly text: string }[];
}
export interface CompatibleFunctionCallOutput {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}
export interface CompatibleUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
}
export interface CompatibleCreateRequest {
  readonly input: string | readonly CompatibleToolResult[];
  readonly tools?: readonly ToolDefinition[];
  readonly previous_response_id?: string;
  /** Overrides the runtime-level session id used to scope memory context. */
  readonly session_id?: string;
  /** Abort signal for this generation; falls back to the runtime-level signal. */
  readonly signal?: AbortSignal;
  /** Phase used when an aborted generation is reported as RunAbortError. */
  readonly abortPhase?: RunAbortPhase;
}
export interface CompatibleToolResult {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}
interface ResponseState {
  readonly messages: readonly ConversationMessage[];
  readonly toolCalls: ReadonlyMap<string, string>;
}
function textMessage(role: "system" | "user", text: string): ConversationMessage {
  return { role, content: [{ type: "text", text }] };
}
function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)])) as JsonObject;
  return String(value);
}
function parseToolResult(output: string): JsonValue {
  try { return asJsonValue(JSON.parse(output)); }
  catch { return output; }
}
function usageOf(response: GenerateResponse): CompatibleUsage | undefined {
  if (!response.usage) return undefined;
  return {
    input_tokens: response.usage.inputTokens,
    output_tokens: response.usage.outputTokens,
    total_tokens: response.usage.totalTokens,
    input_tokens_details: response.usage.cachedInputTokens === undefined ? undefined : { cached_tokens: response.usage.cachedInputTokens },
  };
}
function outputOf(message: AssistantMessage): readonly CompatibleOutput[] {
  const output: CompatibleOutput[] = [];
  if (message.content.length > 0) output.push({ type: "message", status: "completed", content: message.content.map((part) => ({ type: "output_text", text: part.text })) });
  for (const call of message.toolCalls ?? []) output.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
  return output;
}

/**
 * Compatibility boundary for the legacy Responses-based executor. It retains
 * complete portable conversation snapshots keyed by generated response IDs,
 * so a legacy `previous_response_id` plus function-call outputs becomes a
 * stateless adapter request without losing multi-turn tool continuation.
 *
 * Memory integration: the runtime accepts an optional {@link MemoryModule}
 * (plus a session id to scope context requests). Before generating an initial
 * (non-continuation) completion it calls `memory.getContext({ session_id })`
 * and, when the store returns summarized context, prepends a labeled block to
 * the user input so previously remembered work re-enters the prompt instead of
 * being rediscovered. The integration is fail-safe and fully optional: when no
 * memory is injected, when no session id is available, or when getContext
 * rejects, the request proceeds unchanged and the failure is surfaced as a
 * non-fatal message rather than aborting the plan loop. Tool continuations keep
 * their existing messages (memory context is only injected on the initial turn
 * of a phase/step), preserving backward compatibility for all current call
 * sites that construct the runtime with only adapter/model/signal.
 */
export class MultiTurnLlmRuntime {
  private nextResponseId = 0;
  private readonly responseStates = new Map<string, ResponseState>();
  private memory?: MemoryModule;
  private sessionId?: string;
  constructor(
    private readonly adapter: LlmAdapter,
    private readonly model: string,
    readonly signal?: AbortSignal,
    options: { memory?: MemoryModule; sessionId?: string } = {},
  ) {
    this.memory = options.memory;
    this.sessionId = options.sessionId;
  }

  /**
   * Swap or attach an optional MemoryModule at runtime (dependency injection).
   * Setting `undefined` disables memory integration for subsequent requests.
   */
  attachMemory(memory: MemoryModule | undefined, sessionId?: string): void {
    this.memory = memory;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }

  /** The active MemoryModule, if any. */
  hasMemory(): boolean {
    return this.memory !== undefined;
  }

  async create(request: CompatibleCreateRequest): Promise<CompatibleResponse> {
    const signal = request.signal ?? this.signal;
    const abortPhase = request.abortPhase ?? "execution";
    throwIfAborted(signal, abortPhase);
    const prior = request.previous_response_id === undefined ? undefined : this.responseStates.get(request.previous_response_id);
    if (request.previous_response_id !== undefined && !prior) throw new Error(`LLM response continuation error: unknown previous_response_id '${request.previous_response_id}'.`);
    if (prior && typeof request.input === "string") throw new Error("LLM response continuation error: tool outputs are required after previous_response_id.");
    if (!prior && typeof request.input !== "string") throw new Error("LLM response request error: initial input must be text.");
    const continuation: ToolResultMessage[] = prior ? (request.input as readonly CompatibleToolResult[]).map((result) => {
      if (!prior.toolCalls.has(result.call_id)) throw new Error(`LLM response continuation error: unknown tool call '${result.call_id}'.`);
      const content = parseToolResult(result.output);
      return { role: "tool", toolCallId: result.call_id, content, isError: Boolean(content && typeof content === "object" && !Array.isArray(content) && "error" in content) };
    }) : [];
    // On an initial (non-continuation) request, inject summarized memory context
    // ahead of the user input when a MemoryModule is attached and a session id
    // is available. Tool continuations reuse the stored messages unchanged.
    let initialInput: string | undefined;
    if (prior) {
      initialInput = undefined;
    } else {
      initialInput = (request.input as string);
      if (this.memory) {
        const sessionId = request.session_id ?? this.sessionId;
        if (sessionId) {
          initialInput = await this.prependMemoryContext(initialInput, sessionId);
        }
      }
    }
    const messages = prior ? [...prior.messages, ...continuation] : [textMessage("user", initialInput as string)];
    const requestType = prior ? REQUEST_TYPE_TOOL_CONTINUATION : REQUEST_TYPE_INITIAL;
    let generated: GenerateResponse;
    try {
      generated = await this.adapter.generate({ model: this.model, messages, tools: request.tools, signal });
    } catch (error) {
      // A user abort takes precedence over any provider error produced by an
      // in-flight request cancellation, so the top-level handler can report the
      // correct abort phase and exit code instead of a provider failure.
      throwIfAborted(signal, abortPhase);
      if (error instanceof LlmAdapterError) {
        console.error(
          `[LLM ADAPTER ERROR] Prompt that caused the ${error.provider} adapter error (${error.code}):\n` +
          `${formatPrompt(messages)}`,
        );
      }
      throw error;
    }
    const id = `compat-${++this.nextResponseId}`;
    this.responseStates.set(id, { messages: Object.freeze([...messages, generated.message]), toolCalls: new Map((generated.message.toolCalls ?? []).map((call) => [call.id, call.name])) });
    const record: LlmLogRecord = {
      timestamp: nowIso(),
      requestType,
      model: this.model,
      prompt: formatPrompt(messages),
      response: formatResponse(generated.message),
      usage: generated.usage,
      responseId: id,
    };
    appendLlmLog(record);
    return { id, output: outputOf(generated.message), usage: usageOf(generated), finishReason: generated.finishReason };
  }

  /**
   * Fetch summarized context for a session and prepend it to an initial prompt.
   * Fail-safe: a rejected getContext leaves the prompt unchanged and reports
   * the failure as a non-fatal diagnostic so the agent loop can continue.
   */
  private async prependMemoryContext(input: string, sessionId: string): Promise<string> {
    if (!this.memory) return input;
    let result: MemoryContextResult;
    try {
      result = await this.memory.getContext({ session_id: sessionId });
    } catch (error) {
      console.error(`[MEMORY] getContext failed (non-fatal): ${describeError(error)}`);
      return input;
    }
    const prefix = memoryContextPrefix(result);
    return prefix.length > 0 ? `${prefix}${input}` : input;
  }
}

/** Render a memory-context result into a labeled, prompt-ready prefix. */
export function memoryContextPrefix(result: MemoryContextResult): string {
  if (!result.hasMemory || !result.text) return "";
  const text = result.text.trim();
  if (text.length === 0) return "";
  return `[SESSION MEMORY — additional context remembered from earlier in this session]\n${text}\n\n`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
