/**
 * Memory compaction for the elastic-agent runtime.
 *
 * The in-memory/persistent memory modules keep a concise per-session summary
 * that is re-injected into subsequent LLM prompts via getContext(). As a run
 * progresses that summary can grow to a significant fraction of the available
 * context window, which degrades prompt quality (and eventually exceeds the
 * window). This module provides the *detection-and-compaction* logic: it
 * checks the current summary size against a configurable context window and,
 * when the summary exceeds the configured threshold (default 50%), compacts it
 * with the highest-capability model and the `prompts/memory-compaction.md`
 * prompt so future prompts keep the important facts without the bloat.
 *
 * Design goals (mirroring the rest of `memory/`):
 *  - Transport-agnostic: the compactor depends only on the portable
 *    `LlmAdapter` contract and a narrow {@link CompactionSummaryStore} (read +
 *    write of a session summary), never on a specific memory backend or LLM
 *    provider SDK.
 *  - Fail open: if the model call fails, the output is invalid, or the store
 *    read/write throws, the original memory is preserved unchanged and an
 *    actionable diagnostic is logged. Compaction must never corrupt or lose
 *    session memory.
 *  - Deterministic and testable: the threshold check is a pure function
 *    ({@link shouldCompactMemory}) and model invocation is injected through
 *    the adapter, so unit tests can drive every branch with a stub.
 */
import type {
  ConversationMessage,
  LlmAdapter,
} from "../llm/adapter-contract.js";

/**
 * Default context-window size (in characters) used by the compactor when no
 * explicit window is configured. Character count is a conservative proxy for
 * token usage and matches how the memory modules measure summary size (the
 * summary string `.length`). A deployment that knows its true window should
 * configure `contextWindow` / `ELAGENT_MEMORY_CONTEXT_WINDOW`.
 */
export const DEFAULT_CONTEXT_WINDOW = 120_000;

/**
 * Default fraction of the context window at which compaction is triggered.
 * Compaction fires only when `summary.length / contextWindow` is *strictly
 * greater than* this threshold (a summary exactly at the threshold is not
 * compacted). Default 0.5 (50%).
 */
export const MEMORY_COMPACTION_THRESHOLD = 0.5;

/**
 * Minimal store surface the compactor needs from a memory backend. Both
 * `InMemoryMemoryModule` and `PersistentMemoryModule` implement this so the
 * compactor can read the current summary and (only on a successful compact)
 * atomically replace it without touching history.
 */
export interface CompactionSummaryStore {
  getSummary(sessionId: string): string | undefined;
  /** Replace the session's summary. Only called after a validated compaction. */
  setSummary(sessionId: string, summary: string): void;
}

/** Outcome of a single maybeCompact() call, for audit/logging. */
export interface CompactionOutcome {
  /** True when a compaction was attempted (threshold exceeded). */
  readonly attempted: boolean;
  /** True when the summary was actually replaced by a compacted version. */
  readonly compacted: boolean;
  /** Non-empty when compaction failed and the original memory was preserved. */
  readonly error?: string;
}

/** Config for the MemoryCompactor. */
export interface MemoryCompactorOptions {
  /** The store (memory backend) whose summary is read/replaced. */
  readonly store: CompactionSummaryStore;
  /** The provider-neutral LLM adapter used to perform compaction. */
  readonly adapter: LlmAdapter;
  /** The "highest" model id to use for compaction (see resolveHighestModelConfiguration). */
  readonly highestModel: string;
  /**
   * The memory-compaction prompt template (contents of
   * `prompts/memory-compaction.md`) with `${plan}` and `${memory}`
   * placeholders.
   */
  readonly promptTemplate: string;
  /** Context-window size in characters used for the threshold check. */
  readonly contextWindow?: number;
  /** Fraction of the window above which compaction triggers (default 0.5). */
  readonly threshold?: number;
  /** Optional stable name used in log/diagnostic messages. */
  readonly label?: string;
}

/**
 * Pure threshold test: return true only when the summary has a measurable size
 * and it is *strictly greater than* `threshold` of the context window. A size
 * of 0, an empty/absent summary, a non-positive window, or a value exactly at
 * the threshold all return false (no compaction).
 */
export function shouldCompactMemory(
  summaryLength: number,
  contextWindow: number,
  threshold: number = MEMORY_COMPACTION_THRESHOLD,
): boolean {
  if (!Number.isFinite(summaryLength) || summaryLength <= 0) return false;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  if (!Number.isFinite(threshold) || threshold < 0) return false;
  return summaryLength / contextWindow > threshold;
}

/**
 * Render the memory-compaction prompt template by interpolating `${plan}` and
 * `${memory}`. Uses the same `${...}` convention as the main prompt builder
 * (renderPrompt) but scoped to the two placeholders this template carries, so
 * it stays a leaf helper with no dependency on main.ts.
 */
export function renderMemoryCompactionPrompt(
  template: string,
  plan: unknown,
  memory: string,
): string {
  const planText = typeof plan === "string" ? plan : describeUnknown(plan);
  return template
    .split("${plan}")
    .join(planText)
    .split("${memory}")
    .join(memory);
}

/**
 * Validate a model compaction response. Returns its trimmed text when it is a
 * usable compacted summary; otherwise returns null so the caller can fail open
 * and preserve the original memory. Rejects empty/whitespace output and output
 * that clearly violates the prompt's output contract (JSON document or fenced
 * code block), which the runtime treats as "invalid" and therefore preserves
 * the original memory.
 */
export function validateCompactedSummary(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (looksLikeJsonDocument(trimmed)) return null;
  if (/^```/m.test(trimmed)) return null;
  return trimmed;
}

/**
 * The detection-and-compaction component.
 *
 * {@link maybeCompact} is the post-memory-update hook: call it after a
 * remember() (or before injecting context) to check whether the session's
 * summary has grown past the threshold and, when it has, compact it with the
 * highest model and the compaction prompt.
 *
 * Safety contract (fail open): any failure — a missing summary, a throwing
 * store, a throwing model call, an invalid response, or a bad template — is
 * caught, reported through the returned outcome (and console diagnostic), and
 * leaves the stored summary untouched. The agent loop never aborts because of
 * a compaction failure.
 */
export class MemoryCompactor {
  private readonly store: CompactionSummaryStore;
  private readonly adapter: LlmAdapter;
  private readonly highestModel: string;
  private readonly promptTemplate: string;
  private readonly contextWindow: number;
  private readonly threshold: number;
  private readonly label: string;

  constructor(options: MemoryCompactorOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.highestModel = options.highestModel;
    this.promptTemplate = options.promptTemplate;
    this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.threshold = options.threshold ?? MEMORY_COMPACTION_THRESHOLD;
    this.label = options.label ?? "memory-compaction";
  }

  /** The context-window size (in characters) this compactor uses. */
  getWindow(): number {
    return this.contextWindow;
  }

  /** The fraction-of-window threshold above which compaction triggers. */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Check whether the session summary exceeds the threshold and, if so,
   * compact it with the highest model. Returns an outcome describing what
   * happened. Never throws; failures are recorded on the outcome and logged.
   */
  async maybeCompact(sessionId: string, plan: unknown): Promise<CompactionOutcome> {
    if (!sessionId) {
      return failOpen("missing session id; compaction skipped");
    }
    let current: string | undefined;
    try {
      current = this.store.getSummary(sessionId);
    } catch (error) {
      return failOpen(`store.getSummary failed (non-fatal): ${describeError(error)}`);
    }
    if (typeof current !== "string" || current.length === 0) {
      return { attempted: false, compacted: false };
    }
    if (!shouldCompactMemory(current.length, this.contextWindow, this.threshold)) {
      return { attempted: false, compacted: false };
    }

    // Threshold exceeded: attempt compaction with the highest model.
    let promptText: string;
    try {
      promptText = renderMemoryCompactionPrompt(this.promptTemplate, plan, current);
    } catch (error) {
      return failOpen(`memory-compaction prompt rendering failed (non-fatal): ${describeError(error)}`);
    }

    let generated;
    try {
      generated = await this.adapter.generate({
        model: this.highestModel,
        messages: compactionMessages(promptText),
      });
    } catch (error) {
      return failOpen(`memory compaction model call failed (non-fatal, original memory preserved): ${describeError(error)}`);
    }

    const compressed = validateCompactedSummary(textOf(generated));
    if (compressed === null) {
      return failOpen("memory compaction returned an invalid or empty summary (non-fatal, original memory preserved)");
    }
    if (compressed.length >= current.length) {
      // A "compaction" that did not actually shrink the summary is not worth
      // replacing — it could equally be an echo. Preserve the original.
      return failOpen(
        `memory compaction did not reduce the summary (${compressed.length} chars vs ${current.length}); original memory preserved`,
      );
    }

    try {
      this.store.setSummary(sessionId, compressed);
    } catch (error) {
      return failOpen(`store.setSummary failed (non-fatal, original memory preserved): ${describeError(error)}`);
    }

    console.log(
      `[${this.label}] compacted session ${sessionId} memory from ${current.length} to ${compressed.length} chars ` +
        `using model ${this.highestModel}`,
    );
    return { attempted: true, compacted: true };
  }
}

/** Build the single-message conversation used for a compaction generation. */
function compactionMessages(prompt: string): readonly ConversationMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  ];
}

/** Extract the assistant text from a GenerateResponse, or "" when absent. */
function textOf(generated: { message?: { content?: readonly { text?: string }[] } }): string {
  return (generated?.message?.content ?? [])
    .map((part) => part?.text ?? "")
    .join("");
}

/** Whether a string is a JSON document (starts with `{` or `[` after trim). */
function looksLikeJsonDocument(trimmed: string): boolean {
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function failOpen(error: string): CompactionOutcome {
  console.error(`[memory-compaction] ${error}`);
  return { attempted: true, compacted: false, error };
}

function describeUnknown(value: unknown): string {
  if (value === undefined || value === null) return "(no plan)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
