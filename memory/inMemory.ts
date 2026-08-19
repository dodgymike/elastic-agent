/**
 * In-memory implementation of the memory module contract from `memory/types.ts`.
 *
 * `InMemoryMemoryModule` is the reference/default MemoryModule for the
 * elastic-agent runtime. It keeps an ordered history of remembered plan steps
 * in process memory and, when a summarizer is injected, calls it after every
 * remember() to refresh a concise summary of everything seen so far. This
 * summary is what getContext() returns for injection into LLM prompts.
 *
 * Design goals (mirroring `llm/adapter-contract.ts`):
 *  - Transport-agnostic: no SDK objects, credentials, or storage backends.
 *  - Swappable via dependency injection: the summarizer is injected through the
 *    constructor/factory so it can be backed by any LLM module or a stub.
 *  - Chainable: an optional `delegate` MemoryModule receives forwarded calls so
 *    several stores can be composed (e.g. an in-memory cache in front of a
 *    durable backend).
 *  - Fail safe: remember() never throws to abort the agent plan loop. Errors
 *    from the summarizer or delegate are surfaced through a non-fatal error
 *    report rather than propagated to the plan runner.
 *
 * This file intentionally defines only the in-memory store; the transport and
 * LLM integration are supplied by callers via the injected summarizer.
 */

import type {
  ContextRequest,
  MemoryContext,
  MemoryJsonValue,
  MemoryModule,
  MemoryModuleFactory,
  MemoryModuleFactoryOptions,
  MemoryContextResult,
  RememberInput,
} from "./types.js";

/**
 * A single remembered plan step as retained in the in-memory history.
 *
 * `entryAt` is the monotonic index of the step within this session, assigned
 * when the step is appended, so provenance can be traced back deterministically
 * even when timestamps are absent or equal.
 */
export interface MemoryEntry {
  /** Monotonic index of this step within this module's history. */
  readonly entryAt: number;
  /** The run/step context supplied to remember(). */
  readonly context: MemoryContext;
  /** The ordered actions the step performed. */
  readonly actions: readonly string[];
  /** How the step ended. */
  readonly outcome: string;
  /** Free-form detail about the step's outcome/error. */
  readonly outcomeDetail?: MemoryJsonValue;
  /** The reasoning/narrative behind the step. */
  readonly reasoning?: string;
  /** ISO-8601 timestamp of step completion (may be absent). */
  readonly timestamp?: string;
}

/**
 * Input to a summarizer on each remember() so it can both append the newest
 * step and refresh the running summary rather than re-summarizing from scratch.
 */
export interface MemorySummarizeInput {
  /** The session whose history is being summarized. */
  readonly sessionId: string;
  /** The concise summary from the previous remember() call, if any. */
  readonly previousSummary?: string;
  /** The full ordered history of remembered steps (including the newest). */
  readonly entries: readonly MemoryEntry[];
}

/**
 * Summarizes accumulated history into a concise, LLM-ready string.
 *
 * A transport-agnostic function type so any caller can supply an LLM-backed
 * summarizer, a heuristic summarizer, or a test stub without coupling this
 * module to a specific provider. Must not throw for the agent loop to proceed
 * safely; a thrown error is caught by InMemoryMemoryModule.
 */
export type MemorySummarizer = (input: MemorySummarizeInput) => Promise<string>;

/**
 * Factory options accepted by createInMemoryMemoryModule / InMemoryMemoryModule.
 *
 * `summarizer` and `delegate` implement swappability and chaining respectively.
 * Additional backend-specific options are accepted via the index signature of
 * MemoryModuleFactoryOptions.
 */
export interface InMemoryMemoryOptions extends MemoryModuleFactoryOptions {
  /** Optional LLM-backed (or stub) summarizer used to refresh the summary. */
  readonly summarizer?: MemorySummarizer;
  /** Optional delegate MemoryModule to forward remember/getContext calls to. */
  readonly delegate?: MemoryModule;
  /** Optional initial summary to seed a fresh module (useful for chaining). */
  readonly seedSummary?: string;
}

/** How remember()/getContext() surfaced errors are reported to the caller. */
export interface MemoryFailureReport {
  /** True when a summarizer threw while refreshing the summary. */
  summarizerFailed: boolean;
  /** True when a delegate MemoryModule threw while forwarding a call. */
  delegateFailed: boolean;
  /** Non-empty strings describe the first summarizer/delegate error message. */
  errorMessages: string[];
}

/**
 * Default, fail-safe no-op summarizer used when none is injected. It produces
 * a stable textual rendering of the history so getContext() still returns
 * useful context even without an LLM-backed summarizer.
 */
export function defaultHistorySummarizer(input: MemorySummarizeInput): Promise<string> {
  const lines = input.entries.map((entry) => {
    const actions = entry.actions.length > 0 ? entry.actions.join(", ") : "(no actions)";
    const detail =
      entry.outcomeDetail !== undefined ? ` (${renderJson(entry.outcomeDetail)})` : "";
    return `[${entry.entryAt}] ${entry.outcome}${detail}: ${actions}`;
  });
  const text = lines.length > 0 ? `Session ${input.sessionId} history:\n${lines.join("\n")}` : "";
  return Promise.resolve(text);
}

function renderJson(value: MemoryJsonValue): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * In-memory MemoryModule that records plan steps against this process and
 * refreshes a concise summary via an injected summarizer.
 *
 * Behavior:
 *  - remember(input) appends a MemoryEntry to `history`, refreshes `summary`
 *    by invoking the injected summarizer (or the default renderer) on the
 *    accumulated history, and forwards to a delegate when present.
 *  - getContext(request) returns the current summary plus the provenance of
 *    the steps that contributed to it, and merges in delegate context.
 *  - Fail-safe: remember()/getContext() never reject because of a summarizer
 *    or delegate failure; the first failure is recorded on `lastFailure` and
 *    surfaced to the caller (which the plan loop treats as non-fatal).
 */
export class InMemoryMemoryModule implements MemoryModule {
  /** Individual steps remembered so far, in append order. */
  private readonly historyBySession = new Map<string, MemoryEntry[]>();
  /** Concise running summary per session, refreshed by the summarizer. */
  private readonly summaryBySession = new Map<string, string>();
  /** Monotonic counter used to assign entryAt indices. */
  private count = 0;

  private readonly summarizer: MemorySummarizer;
  private readonly delegate?: MemoryModule;

  /** The most recent non-fatal failure reported by this module, if any. */
  lastFailure: MemoryFailureReport | null = null;

  constructor(options: InMemoryMemoryOptions = {}) {
    this.summarizer = options.summarizer ?? defaultHistorySummarizer;
    this.delegate = options.delegate;
    if (options.seedSummary !== undefined) {
      this.summaryBySession.set("__default__", options.seedSummary);
    }
  }

  /**
   * Record one completed plan step.
   *
   * Appends the step to history, refreshes the session summary, and forwards
   * to the delegate. Failures are absorbed into `lastFailure` and the returned
   * error report; they never reject, so the plan loop can continue safely.
   */
  async remember(input: RememberInput): Promise<void> {
    const entry = this.toEntry(input);
    const sessionId = input.context.session_id;

    let history = this.historyBySession.get(sessionId);
    if (!history) {
      history = [];
      this.historyBySession.set(sessionId, history);
    }
    history.push(entry);

    const report: MemoryFailureReport = { summarizerFailed: false, delegateFailed: false, errorMessages: [] };
    const previous = this.summaryBySession.get(sessionId);
    try {
      const next = await this.summarizer({ sessionId, previousSummary: previous, entries: history });
      this.summaryBySession.set(sessionId, next);
    } catch (error) {
      report.summarizerFailed = true;
      report.errorMessages = [...report.errorMessages, summarizeError(error)];
    }

    if (this.delegate) {
      try {
        await this.delegate.remember(input);
      } catch (error) {
        report.delegateFailed = true;
        report.errorMessages = [...report.errorMessages, summarizeError(error)];
      }
    }

    this.lastFailure = report.summarizerFailed || report.delegateFailed ? report : null;
  }

  /**
   * Retrieve the summarized context for the current turn.
   *
   * Combines this module's own summary/provenance with the delegate's (when
   * present) so chained stores contribute context without duplication. Uses the
   * request's maxChars budget to trim the rendered text.
   */
  async getContext(request: ContextRequest): Promise<MemoryContextResult> {
    const own = this.ownContext(request);
    if (!this.delegate) {
      return own;
    }
    try {
      const delegated = await this.delegate.getContext(request);
      return mergeContextResults([own, delegated], request.maxChars);
    } catch (error) {
      this.lastFailure = {
        summarizerFailed: false,
        delegateFailed: true,
        errorMessages: [summarizeError(error)],
      };
      return own;
    }
  }

  /** The number of remembered steps for a session (0 when none). */
  countForSession(sessionId: string): number {
    return this.historyBySession.get(sessionId)?.length ?? 0;
  }

  /** The current raw summary string for a session, if any. */
  summaryForSession(sessionId: string): string | undefined {
    return this.summaryBySession.get(sessionId);
  }

  private ownContext(request: ContextRequest): MemoryContextResult {
    const sessionId = request.session_id;
    const history = this.historyBySession.get(sessionId) ?? [];
    const summary = this.summaryBySession.get(sessionId);
    const matched = history.map((entry) => entry.context);

    let text = summary !== undefined ? summary : "";
    if (text.length === 0 && history.length > 0) {
      // Never summarized (e.g. no summarizer injected): fall back to the raw
      // count so callers still know memory exists.
      text = `Session ${sessionId}: ${history.length} step(s) remembered, no summary available.`;
    }
    if (request.maxChars !== undefined && text.length > request.maxChars) {
      text = `${text.slice(0, request.maxChars)}…`;
    }
    return {
      text,
      matchedContexts: matched,
      hasMemory: history.length > 0,
    };
  }

  private toEntry(input: RememberInput): MemoryEntry {
    this.count += 1;
    return {
      entryAt: this.count,
      context: input.context,
      actions: input.actions.map((action) => action.name),
      outcome: input.outcome,
      outcomeDetail: input.outcomeDetail,
      reasoning: input.reasoning,
      timestamp: input.timestamp,
    };
  }
}

/**
 * Dependency-injection factory for InMemoryMemoryModule, satisfying
 * MemoryModuleFactory so it can be swapped without coupling callers to the
 * concrete class.
 */
export const createInMemoryMemoryModule: MemoryModuleFactory = (
  options: InMemoryMemoryOptions = {},
): MemoryModule => {
  return new InMemoryMemoryModule(options);
};

/**
 * Merge the context results of several MemoryModules (typically "own" plus one
 * or more delegated) into a single MemoryContextResult, de-duplicating
 * provenance by object identity where possible. Empty results are dropped so a
 * chain with no memory does not pollute the final summary.
 */
export function mergeContextResults(
  results: readonly MemoryContextResult[],
  maxChars?: number,
): MemoryContextResult {
  const present = results.filter((result) => result.hasMemory || result.text.length > 0);
  const matched: MemoryContext[] = [];
  const seen = new Set<MemoryContext>();
  for (const result of present) {
    for (const context of result.matchedContexts) {
      if (!seen.has(context)) {
        seen.add(context);
        matched.push(context);
      }
    }
  }
  const joined = present
    .map((result) => result.text)
    .filter((text) => text.length > 0)
    .join("\n");
  let text = joined;
  if (maxChars !== undefined && text.length > maxChars) {
    text = `${text.slice(0, maxChars)}…`;
  }
  return {
    text,
    matchedContexts: matched,
    hasMemory: present.some((result) => result.hasMemory),
  };
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
