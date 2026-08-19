/**
 * Transport-agnostic memory module contract for the elastic-agent runtime.
 *
 * This contract deliberately contains no provider SDK objects, credentials,
 * storage backends, or transport-specific payloads so that a MemoryModule can
 * be swapped (dependency-injected) or chained (delegated) without changing the
 * execution flow of the agent.
 *
 * A MemoryModule is the durable/episodic store that records what the agent did
 * while executing a plan and summarizes it so later turns (and LLM prompts)
 * can reuse relevant context instead of rediscovering it. It pairs with the
 * LLM adapters in `llm/` but is transport-agnostic: the same interface can
 * back an in-memory store, a file store, a SQLite store, or a remote service.
 */

/**
 * Portable JSON values accepted in action/outcome payloads and memory fields.
 * Mirrors the JSON subset used by the LLM adapter contract so memory payloads
 * can round-trip through any transport without lossy conversions.
 */
export type MemoryJsonPrimitive = boolean | number | string | null;
export type MemoryJsonValue = MemoryJsonPrimitive | MemoryJsonObject | readonly MemoryJsonValue[];
export interface MemoryJsonObject {
  readonly [key: string]: MemoryJsonValue;
}

/**
 * A single remembered action within a plan step.
 *
 * `name` and `arguments` let a summarizer describe what the agent did without
 * resolving full tool schemas at memory time. `argsJson` is the opaque JSON
 * payload (tool-call arguments, function inputs, etc.).
 */
export interface MemoryAction {
  /** Action/tool name, for example "Read" or "ExecuteCommand". */
  readonly name: string;
  /** Human-readable one-line description of what this action did. */
  readonly description?: string;
  /** Opaque, portable JSON arguments passed to the action. */
  readonly argsJson?: MemoryJsonObject;
}

/**
 * The current plan and its execution state at the moment memory is captured.
 *
 * Plans are represented by opaque `plan` and `planState` values so the memory
 * contract stays agnostic to any specific Plan data model (a parsed plan, an
 * index into a plan file, a plan id, etc.). The runtime supplies the values
 * relevant to its own Plan representation.
 */
export interface MemoryPlanContext {
  /** Opaque handle/reference to the active plan. */
  readonly plan?: unknown;
  /** Opaque handle/reference to the current plan execution state. */
  readonly planState?: unknown;
}

/**
 * The context captured before a remember() so a summarizer can place the step
 * within the wider run. `session_id` and `user_id` identify the conversation;
 * `plan`/`planState` place the step within the running plan.
 */
export interface MemoryContext {
  /** Stable identifier for the conversation/run this memory belongs to. */
  readonly session_id: string;
  /** Optional identifier for the user/principal this run serves. */
  readonly user_id?: string;
  /** Opaque reference to the active plan. */
  readonly plan?: unknown;
  /** Opaque reference to the current plan execution state. */
  readonly planState?: unknown;
  /** Free-form run/step context that helps the summarizer. */
  readonly context?: MemoryJsonValue;
}

/** How the plan step that is being remembered ended. */
export type MemoryOutcomeStatus = "completed" | "failed" | "aborted" | "skipped" | "unknown";

/**
 * The full input to remember() for a single plan step.
 *
 * `context` carries the MemoryContext (session, user, plan, planState, and
 * optional free-form context); `actions`, `outcome`, and `reasoning` describe
 * what the step actually did and how it ended.
 */
export interface RememberInput {
  /** The run/step context (session, user, plan, planState, free-form). */
  readonly context: MemoryContext;
  /** The ordered actions the step performed. */
  readonly actions: readonly MemoryAction[];
  /** How the step ended. */
  readonly outcome: MemoryOutcomeStatus;
  /** Free-form narrative of the step's outcome, error, or result. */
  readonly outcomeDetail?: MemoryJsonValue;
  /** The reasoning/narrative explaining why the step acted the way it did. */
  readonly reasoning?: string;
  /** Optional timestamp (ISO-8601) when the step completed. */
  readonly timestamp?: string;
  /** Optional free-form extension fields understood by a given backend. */
  readonly extra?: MemoryJsonObject;
}

/**
 * Request for which summarized context a caller (typically the agent's LLM
 * prompt builder) wants for the current turn.
 */
export interface ContextRequest {
  /** The conversation whose context is requested. */
  readonly session_id: string;
  /** Optional user filter for scoping the request. */
  readonly user_id?: string;
  /** Optional current plan reference to bias context toward. */
  readonly plan?: unknown;
  /** Optional token/character budget hint the store may respect. */
  readonly maxChars?: number;
  /** Optional free-form hints (topics to prioritize, etc.). */
  readonly hints?: MemoryJsonObject;
}

/**
 * The summarized context returned by getContext() for a given request.
 *
 * `text` is a rendered, LLM-ready summary the agent can inject directly into a
 * prompt/system message. `matchedContexts` is the structured provenance of the
 * summaries that were consolidated (for chaining and audit).
 */
export interface MemoryContextResult {
  /** The consolidated, LLM-ready summary text for the requested session. */
  readonly text: string;
  /** Structured provenance/source entries used to build `text`. */
  readonly matchedContexts: readonly MemoryContext[];
  /** True when at least one remembered step contributed to the summary. */
  readonly hasMemory: boolean;
}

/**
 * The only interface the application uses to remember steps and retrieve
 * context. Implementations are swappable via dependency injection and
 * chainable: an implementation may wrap a delegate and forward calls.
 */
export interface MemoryModule {
  /**
   * Record one completed plan step.
   *
   * Implementations append the step and typically call an injected LLM
   * summarizer on the accumulated history to refresh a concise summary. Must
   * fail safely: a failure to remember should not halt the agent loop and
   * should be reported via the returned error signal (or a thrown error that
   * the caller treats as non-fatal).
   *
   * @returns a promise that resolves when the step is recorded and any
   *   summarization has settled. Implementations may reject on durable
   *   failure; callers should treat rejection as non-fatal to the plan loop.
   */
  remember(input: RememberInput): Promise<void>;

  /**
   * Retrieve the summarized context for the current turn, suitable for
   * injecting into an LLM prompt/system message.
   */
  getContext(request: ContextRequest): Promise<MemoryContextResult>;
}

/**
 * Convenience factory type so a MemoryModule can be constructed/swapped via
 * dependency injection without coupling callers to a concrete class.
 */
export type MemoryModuleFactory = (options: MemoryModuleFactoryOptions) => MemoryModule;

/** Options passed to a MemoryModuleFactory. `delegate` enables chaining. */
export interface MemoryModuleFactoryOptions {
  /** When set, this module forwards/delegates to `delegate` and augments it. */
  readonly delegate?: MemoryModule;
  /** Backend/implementation-specific options (paths, keys, budgets, etc.). */
  readonly [key: string]: unknown;
}
