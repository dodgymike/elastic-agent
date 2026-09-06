import { prepareMemoryPrompt } from "./memory-prompt.js";
export { memoryContextSuffix } from "./memory-prompt.js";
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
import { redactMemoryText } from "../memory/privacy.js";
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
import {
  appendPromptLog,
  formatPrompt as formatPromptForLog,
  PROMPT_REQUEST_TYPE_INITIAL,
  PROMPT_REQUEST_TYPE_TOOL_CONTINUATION,
  type PromptLogRecord,
} from "./prompt-logger.js";

/** OpenAI-Responses-shaped subset consumed by the legacy main.ts executor. */
export interface CompatibleResponse {
  readonly id: string;
  readonly output: readonly CompatibleOutput[];
  readonly usage?: CompatibleUsage;
  /** Provider-normalized finish reason, exposed for unable-to-complete detection. */
  readonly finishReason?: FinishReason;
  /**
   * The conversation handle id this response belongs to. Present so callers
   * can inspect lifecycle state without retaining a separate handle object.
   */
  readonly conversation_id?: string;
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
  /** Raw task query for recall; avoids searching boilerplate instructions. */
  readonly memory_query?: string;
  readonly input: string | readonly CompatibleToolResult[];
  readonly tools?: readonly ToolDefinition[];
  readonly previous_response_id?: string;
  /**
   * Optional explicit conversation scope. On an initial request it tags the
   * new conversation; on a continuation it must match the conversation that
   * owns `previous_response_id` (defaults to "default" when omitted).
   */
  readonly scope?: string;
  /**
   * Optional human-meaningful purpose recorded on the conversation handle.
   * Diagnostics only; never sent to a provider or stored in metrics.
   */
  readonly purpose?: string;
  /**
   * Per-request model override. When omitted or blank, the runtime's
   * constructed model is used. This lets specialized paths (for example the
   * tool-safety classifier) select a different default model without
   * constructing a second runtime or adapter.
   */
  readonly model?: string;
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

/** Lifecycle state of a conversation owned by the runtime. */
export type ConversationLifecycleState = "active" | "completed" | "released" | "cancelled";

/**
 * A metadata-only view of a runtime conversation. It carries scope, purpose,
 * pending calls, lifecycle state, and the memory-snapshot revision, but never
 * any transcript content.
 */
export interface ConversationHandle {
  readonly id: string;
  readonly scope: string;
  readonly purpose: string;
  readonly state: ConversationLifecycleState;
  readonly pendingCallIds: readonly string[];
  readonly messageCount: number;
  readonly memorySnapshotRevision?: number;
  readonly lastResponseId?: string;
}

/**
 * Metadata-only conversation lifecycle diagnostics. Counts and size estimates
 * are for local accounting only; conversation content is never exposed here.
 */
export interface ConversationStats {
  /** Conversations with pending tool calls that must not be silently evicted. */
  readonly active: number;
  /** Completed conversations still retained for bounded resumption. */
  readonly completed: number;
  /** Total retained conversations (active + completed). */
  readonly retained: number;
  /** Conversations released since construction (or since the last close). */
  readonly releasedCount: number;
  /** Conversations cancelled since construction (or since the last close). */
  readonly cancelledCount: number;
  /** Rough retained transcript size estimate in bytes (UTF-16 code units). */
  readonly estimatedRetainedBytes: number;
}

const DEFAULT_SCOPE = "default";
const DEFAULT_PURPOSE = "default";
const DEFAULT_MAX_RETAINED_CONVERSATIONS = 64;

interface ConversationRecord {
  readonly id: string;
  readonly scope: string;
  readonly purpose: string;
  state: ConversationLifecycleState;
  /** The single owned transcript for this conversation (no per-response copies). */
  readonly messages: ConversationMessage[];
  /** Pending tool-call ids from the conversation's latest response. */
  readonly pendingCalls: Map<string, string>;
  /** Every response id this conversation has produced, in generation order. */
  readonly responseIds: string[];
  lastResponseId?: string;
  memorySnapshotRevision?: number;
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
function normalizeRetentionLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RETAINED_CONVERSATIONS;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("LLM conversation retention error: maxRetainedConversations must be a non-negative integer.");
  }
  return value;
}

/**
 * Compatibility boundary for the legacy Responses-based executor plus an
 * explicit, bounded conversation lifecycle.
 *
 * `create()` remains stateless from the caller's perspective: an initial
 * request starts a conversation, and a `previous_response_id` plus
 * function-call outputs continues the conversation that owns that response id.
 * Internally each response id is owned by exactly one conversation, so
 * continuation validation can require an exact, unique set of pending results
 * before any provider call.
 *
 * Lifecycle guarantees:
 *   - Active conversations (those with pending tool calls) are never evicted
 *     silently and keep their initial memory snapshot in their owned transcript.
 *   - Completed conversations are retained for bounded resumption up to
 *     `maxRetainedConversations` (default 64; 0 releases immediately), then
 *     released oldest-first. Released/cancelled/advanced response ids fail as
 *     stale before a provider call.
 *   - `releaseConversation` / `cancelConversation` / `close` provide explicit
 *     lifecycle control; `conversationStats` exposes metadata-only diagnostics.
 *
 * Memory integration: the runtime accepts an optional {@link MemoryModule}
 * (plus a session id to scope context requests). Before generating an initial
 * (non-continuation) completion it calls `memory.getContext({ session_id })`
 * and, when the store returns summarized context, appends a labeled block as a
 * trailing section after the user input so previously remembered work re-enters
 * the prompt instead of being rediscovered. The integration is fail-safe and
 * fully optional: when no memory is injected, when no session id is available,
 * or when getContext rejects, the request proceeds unchanged and the failure is
 * surfaced as a non-fatal message rather than aborting the plan loop. Tool
 * continuations keep their existing messages (memory context is only injected
 * on the initial turn of a phase/step), preserving backward compatibility for
 * all current call sites that construct the runtime with only
 * adapter/model/signal.
 */
export class MultiTurnLlmRuntime {
  private nextConversationId = 0;
  private nextResponseId = 0;
  private readonly conversations = new Map<string, ConversationRecord>();
  /** Owned lookup layer: response id -> conversation id. */
  private readonly responseOwners = new Map<string, string>();
  /** Completed-but-retained conversation ids in completion order (oldest first). */
  private readonly completedOrder: string[] = [];
  private readonly maxRetainedConversations: number;
  private releasedConversationCount = 0;
  private cancelledConversationCount = 0;
  private memorySnapshotRevision = 0;
  private closed = false;
  private memory?: MemoryModule;
  private sessionId?: string;
  private readonly logPrompts: boolean;
  constructor(
    private readonly adapter: LlmAdapter,
    private readonly model: string,
    readonly signal?: AbortSignal,
    options: {
      memory?: MemoryModule;
      sessionId?: string;
      logPrompts?: boolean;
      /** Ceiling for retained completed conversations; 0 releases immediately. */
      maxRetainedConversations?: number;
    } = {},
  ) {
    this.memory = options.memory;
    this.sessionId = options.sessionId;
    this.logPrompts = options.logPrompts === true;
    this.maxRetainedConversations = normalizeRetentionLimit(options.maxRetainedConversations);
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
    this.ensureOpen();
    const signal = request.signal ?? this.signal;
    const abortPhase = request.abortPhase ?? "execution";
    throwIfAborted(signal, abortPhase);
    const prior = this.resolvePriorConversation(request);
    const continuation = prior ? this.validateContinuationResults(prior, request) : [];
    // On an initial (non-continuation) request, inject summarized memory context
    // as a trailing section after the user input when a MemoryModule is attached
    // and a session id is available. Tool continuations reuse the stored
    // messages unchanged.
    let record: ConversationRecord;
    let initialInput: string | undefined;
    let memorySnapshotRevision: number | undefined;
    let requestType: typeof REQUEST_TYPE_INITIAL | typeof REQUEST_TYPE_TOOL_CONTINUATION;
    if (prior) {
      record = prior;
      initialInput = undefined;
      requestType = REQUEST_TYPE_TOOL_CONTINUATION;
    } else {
      if (typeof request.input !== "string") throw new Error("LLM response request error: initial input must be text.");
      const scope = (request.scope ?? "").trim() || DEFAULT_SCOPE;
      const purpose = (request.purpose ?? "").trim() || DEFAULT_PURPOSE;
      record = this.beginConversationInternal(scope, purpose);
      initialInput = request.input;
      if (this.memory) {
        const sessionId = request.session_id ?? this.sessionId;
        if (sessionId) {
          const revisionBefore = this.memorySnapshotRevision;
          initialInput = await this.appendMemoryContext(initialInput, sessionId, request.memory_query);
          if (this.memorySnapshotRevision > revisionBefore) memorySnapshotRevision = this.memorySnapshotRevision;
        }
      }
      requestType = REQUEST_TYPE_INITIAL;
    }
    if (memorySnapshotRevision !== undefined) record.memorySnapshotRevision = memorySnapshotRevision;
    const requestMessages = prior ? [...prior.messages, ...continuation] : [textMessage("user", initialInput as string)];
    const model = request.model?.trim() || this.model;
    // When --log-prompts is enabled, record the finalized prompt (including any
    // memory-injected context) immediately before it is sent to the model.
    if (this.logPrompts) {
      const promptRecord: PromptLogRecord = {
        timestamp: nowIso(),
        requestType: prior ? PROMPT_REQUEST_TYPE_TOOL_CONTINUATION : PROMPT_REQUEST_TYPE_INITIAL,
        model,
        prompt: redactMemoryText(formatPromptForLog(requestMessages)),
      };
      appendPromptLog(promptRecord);
    }
    let generated: GenerateResponse;
    try {
      generated = await this.adapter.generate({ model, messages: requestMessages, tools: request.tools, signal });
    } catch (error) {
      // A newly-created conversation that never produced a response must not
      // leak into the registry when the provider call fails.
      if (!prior) this.discardEmptyConversation(record);
      // A user abort takes precedence over any provider error produced by an
      // in-flight request cancellation, so the top-level handler can report the
      // correct abort phase and exit code instead of a provider failure.
      try {
        throwIfAborted(signal, abortPhase);
      } catch (abortError) {
        throw abortError;
      }
      if (error instanceof LlmAdapterError) {
        console.error(
          `[LLM ADAPTER ERROR] provider=${error.provider} code=${error.code} requestType=${requestType} model=${model}: ${redactMemoryText(error.message)}`,
        );
      }
      throw error;
    }
    // Commit the generated message into the conversation's single owned
    // transcript. Tool-continuation results are appended immediately before the
    // assistant message, preserving tool-call/result ordering.
    if (prior) {
      prior.messages.push(...continuation, generated.message);
    } else {
      record.messages.push(...requestMessages, generated.message);
    }
    const pendingToolCalls = new Map((generated.message.toolCalls ?? []).map((call) => [call.id, call.name]));
    record.pendingCalls.clear();
    for (const [callId, name] of pendingToolCalls) record.pendingCalls.set(callId, name);
    const id = `compat-${++this.nextResponseId}`;
    record.responseIds.push(id);
    record.lastResponseId = id;
    this.responseOwners.set(id, record.id);
    if (pendingToolCalls.size === 0) {
      record.state = "completed";
      if (this.maxRetainedConversations === 0) {
        this.releaseRecord(record);
      } else {
        this.completedOrder.push(record.id);
        this.trimCompletedRetention();
      }
    }
    const llmRecord: LlmLogRecord = {
      timestamp: nowIso(),
      requestType,
      model,
      prompt: redactMemoryText(formatPrompt(requestMessages)),
      response: redactMemoryText(formatResponse(generated.message)),
      usage: generated.usage,
      responseId: id,
    };
    appendLlmLog(llmRecord);
    return { id, output: outputOf(generated.message), usage: usageOf(generated), finishReason: generated.finishReason, conversation_id: record.id };
  }

  /**
   * Resolve the conversation that owns `previous_response_id`, or `undefined`
   * for an initial request. Throws before any provider call when the id is
   * unknown, released/cancelled, completed, stale (not the conversation's
   * latest response), or scoped differently from the continuation request.
   */
  private resolvePriorConversation(request: CompatibleCreateRequest): ConversationRecord | undefined {
    if (request.previous_response_id === undefined) return undefined;
    const responseId = request.previous_response_id;
    const ownerId = this.responseOwners.get(responseId);
    if (!ownerId) throw new Error(`LLM response continuation error: unknown previous_response_id '${responseId}'.`);
    const record = this.conversations.get(ownerId);
    if (!record) throw new Error(`LLM response continuation error: unknown previous_response_id '${responseId}'.`);
    if (record.state === "released" || record.state === "cancelled") {
      throw new Error(`LLM response continuation error: previous_response_id '${responseId}' refers to a ${record.state} conversation.`);
    }
    if (record.state === "completed") {
      throw new Error(`LLM response continuation error: stale previous_response_id '${responseId}' (conversation already completed).`);
    }
    if (record.lastResponseId !== responseId) {
      throw new Error(`LLM response continuation error: stale previous_response_id '${responseId}' (conversation has advanced to '${record.lastResponseId ?? "none"}').`);
    }
    const scope = (request.scope ?? "").trim();
    if (scope.length > 0 && scope !== record.scope) {
      throw new Error(`LLM response continuation error: scope mismatch (request '${scope}' vs conversation '${record.scope}').`);
    }
    return record;
  }

  /**
   * Validate a continuation's tool results against the conversation's pending
   * calls. The declared set must be exactly the pending set: unknown, duplicate,
   * and missing result ids all fail before a provider call. Partial results are
   * intentionally unsupported, so generation never resumes on an incomplete
   * result set.
   */
  private validateContinuationResults(record: ConversationRecord, request: CompatibleCreateRequest): ToolResultMessage[] {
    if (typeof request.input === "string") {
      throw new Error("LLM response continuation error: tool outputs are required after previous_response_id.");
    }
    const results = request.input as readonly CompatibleToolResult[];
    const seen = new Set<string>();
    const supplied = new Set<string>();
    for (const result of results) {
      if (!record.pendingCalls.has(result.call_id)) {
        throw new Error(`LLM response continuation error: unknown tool call '${result.call_id}'.`);
      }
      if (seen.has(result.call_id)) {
        throw new Error(`LLM response continuation error: duplicate tool result for call '${result.call_id}'.`);
      }
      seen.add(result.call_id);
      supplied.add(result.call_id);
    }
    for (const callId of record.pendingCalls.keys()) {
      if (!supplied.has(callId)) {
        throw new Error(`LLM response continuation error: missing tool result for call '${callId}'.`);
      }
    }
    return results.map((result) => {
      const content = parseToolResult(result.output);
      return { role: "tool", toolCallId: result.call_id, content, isError: Boolean(content && typeof content === "object" && !Array.isArray(content) && "error" in content) };
    });
  }

  /**
   * Fetch summarized context for a session and append it as a trailing section
   * to an initial prompt. Fail-safe: a rejected getContext leaves the prompt
   * unchanged and reports the failure as a non-fatal diagnostic so the agent
   * loop can continue. Each successful injection advances the runtime's memory
   * snapshot revision used by conversation handles.
   */
  private async appendMemoryContext(input: string, sessionId: string, queryText = input): Promise<string> {
    try {
      const prepared = await prepareMemoryPrompt(input, sessionId, this.memory, queryText);
      if (prepared.memory.hasMemory) this.memorySnapshotRevision += 1;
      return prepared.prompt;
    } catch (error) {
      console.error(`[MEMORY] getContext failed (non-fatal): ${redactMemoryText(describeError(error))}`);
      return input;
    }
  }

  private beginConversationInternal(scope: string, purpose: string): ConversationRecord {
    const id = `conv-${++this.nextConversationId}`;
    const record: ConversationRecord = {
      id,
      scope,
      purpose,
      state: "active",
      messages: [],
      pendingCalls: new Map(),
      responseIds: [],
    };
    this.conversations.set(id, record);
    return record;
  }

  private discardEmptyConversation(record: ConversationRecord): void {
    if (record.responseIds.length !== 0) return;
    this.conversations.delete(record.id);
  }

  private trimCompletedRetention(): void {
    while (this.completedOrder.length > this.maxRetainedConversations) {
      const oldest = this.completedOrder.shift();
      if (oldest === undefined) break;
      this.releaseRecord(this.conversations.get(oldest));
    }
  }

  private releaseRecord(record: ConversationRecord | undefined): void {
    if (!record) return;
    if (record.state === "released" || record.state === "cancelled") return;
    record.state = "released";
    for (const responseId of record.responseIds) this.responseOwners.delete(responseId);
    this.conversations.delete(record.id);
    const retainedIndex = this.completedOrder.indexOf(record.id);
    if (retainedIndex !== -1) this.completedOrder.splice(retainedIndex, 1);
    this.releasedConversationCount += 1;
  }

  private cancelRecord(record: ConversationRecord | undefined): void {
    if (!record) return;
    if (record.state === "cancelled") return;
    record.state = "cancelled";
    for (const responseId of record.responseIds) this.responseOwners.delete(responseId);
    this.conversations.delete(record.id);
    const retainedIndex = this.completedOrder.indexOf(record.id);
    if (retainedIndex !== -1) this.completedOrder.splice(retainedIndex, 1);
    this.cancelledConversationCount += 1;
  }

  private resolveRecord(idOrResponseId: string): ConversationRecord | undefined {
    const direct = this.conversations.get(idOrResponseId);
    if (direct) return direct;
    const ownerId = this.responseOwners.get(idOrResponseId);
    return ownerId ? this.conversations.get(ownerId) : undefined;
  }

  /**
   * A metadata-only view of a conversation, addressed by conversation id or by
   * any response id that belongs to it. Returns `undefined` when released,
   * cancelled, or unknown.
   */
  conversationHandle(idOrResponseId: string): ConversationHandle | undefined {
    const record = this.resolveRecord(idOrResponseId);
    if (!record) return undefined;
    return {
      id: record.id,
      scope: record.scope,
      purpose: record.purpose,
      state: record.state,
      pendingCallIds: Object.freeze([...record.pendingCalls.keys()]),
      messageCount: record.messages.length,
      memorySnapshotRevision: record.memorySnapshotRevision,
      lastResponseId: record.lastResponseId,
    };
  }

  /**
   * Release a completed conversation, dropping its transcript references and
   * owned response ids. Active conversations must be cancelled instead; they
   * are never silently evicted.
   */
  releaseConversation(idOrResponseId: string): boolean {
    const record = this.resolveRecord(idOrResponseId);
    if (!record) return false;
    if (record.state === "active") {
      throw new Error(`LLM conversation lifecycle error: cannot release active conversation '${record.id}' with ${record.pendingCalls.size} pending call(s); cancel it instead.`);
    }
    this.releaseRecord(record);
    return true;
  }

  /**
   * Cancel a conversation (active or completed), dropping its transcript
   * references and owned response ids. Used for abort/shutdown paths.
   */
  cancelConversation(idOrResponseId: string): boolean {
    const record = this.resolveRecord(idOrResponseId);
    if (!record) return false;
    this.cancelRecord(record);
    return true;
  }

  /**
   * Metadata-only lifecycle diagnostics for downstream health metrics. Never
   * returns conversation content.
   */
  conversationStats(): ConversationStats {
    let active = 0;
    let completed = 0;
    let estimatedRetainedBytes = 0;
    for (const record of this.conversations.values()) {
      if (record.state === "active") active += 1;
      else if (record.state === "completed") completed += 1;
      estimatedRetainedBytes += this.estimateRecordBytes(record);
    }
    return {
      active,
      completed,
      retained: active + completed,
      releasedCount: this.releasedConversationCount,
      cancelledCount: this.cancelledConversationCount,
      estimatedRetainedBytes,
    };
  }

  private estimateRecordBytes(record: ConversationRecord): number {
    let bytes = 128;
    for (const message of record.messages) {
      bytes += 64;
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          bytes += part.text.length;
        }
      }
      if ("toolCallId" in message && typeof message.toolCallId === "string") {
        bytes += message.toolCallId.length;
      }
      if ("toolCalls" in message && message.toolCalls) {
        for (const call of message.toolCalls) bytes += call.name.length + JSON.stringify(call.arguments).length;
      }
    }
    return bytes;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("LLM response request error: the runtime is closed.");
  }

  /**
   * Cancel all retained conversations and reject further requests. Call at
   * safe shutdown boundaries so a long-lived process never retains stale
   * conversation transcripts. Durable session memory is owned elsewhere and is
   * not touched by this method.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const record of [...this.conversations.values()]) {
      this.cancelRecord(record);
    }
    this.completedOrder.length = 0;
    this.responseOwners.clear();
  }
}

/**
 * Render a memory-context result into a labeled, prompt-ready trailing section.
 * The leading blank line separates it from the user input it is appended to, so
 * it can never shift the stable prefix of an initial request.
 */

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
