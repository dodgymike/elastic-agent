/**
 * Graph-based implementation of the memory module contract from
 * `memory/types.ts`, backed by the in-memory adjacency store defined in
 * `memory/graph-store.ts`.
 *
 * Unlike `InMemoryMemoryModule` (a flat ordered list per session),
 * `GraphMemoryModule` models each remembered plan step as graph nodes and typed
 * edges so later turns can retrieve a *chain of related steps* (not just flat
 * history). It follows the logical data model in `GRAPH_DATA_MODEL.md`:
 *
 *  - A `plan` **entity** node is created the first time a session remembers a
 *    step (upsert by session + plan text).
 *  - Each plan step is a `claim` node keyed by `sessionId + stepIndex` — the
 *    *step key*. Re-remembering the same session/step updates that node rather
 *    than creating a duplicate (idempotent upsert).
 *  - Consecutive steps are linked with `depends_on` / `derived_from` edges so
 *    `getContext()` can walk the recent chain and the transitive predecessors
 *    of a given step.
 *  - Actions, reasoning, and outcome detail are stored as bounded, sanitized
 *    labels/attributes on the step claim — not raw transcripts or secrets.
 *
 * Design goals (mirroring `memory/inMemory.ts`):
 *  - Transport-agnostic: no SDK objects, credentials, or storage backends.
 *  - Swappable via dependency injection: the same `MemoryModuleFactory` type
 *    (`memory/types.ts`) is used, so the runtime can construct either the
 *    in-memory or the graph module behind one reference.
 *  - Chainable: an optional `delegate` MemoryModule receives forwarded calls so
 *    several stores can be composed; graph context is merged with delegated
 *    context via `mergeContextResults`.
 *  - Fail safe: remember()/getContext() never reject because of a summarizer,
 *    storage, or delegate failure; the first failure is recorded on
 *    `lastFailure` and surfaced, which the plan loop treats as non-fatal.
 *
 * The LLM summarizer is injected as a function (the same `MemorySummarizer`
 * type as `memory/inMemory.ts`), so a real LLM adapter or a test stub can
 * supply it without new types or coupling.
 */

import type {
  ContextRequest,
  MemoryContext,
  MemoryContextResult,
  MemoryJsonValue,
  MemoryModule,
  MemoryModuleFactory,
  MemoryModuleFactoryOptions,
  RememberInput,
} from "./types.js";
import {
  InMemoryGraphStore,
  type GraphAttributes,
  type GraphEdge,
  type GraphNode,
  type GraphNodeType,
  type GraphStore,
} from "./graph-store.js";
import type { MemorySummarizeInput, MemorySummarizer } from "./inMemory.js";
import { mergeContextResults } from "./inMemory.js";

/** What the free-form step context may carry for structured `step` indexing. */
interface StepContextValue {
  readonly step?: unknown;
}

/**
 * Factory options accepted by createGraphMemoryModule / GraphMemoryModule.
 *
 * `store`, `summarizer`, and `delegate` implement backend swappability,
 * LLM-backed summarization, and chaining respectively. Additional
 * backend-specific options are accepted via the index signature of
 * `MemoryModuleFactoryOptions`.
 */
export interface GraphMemoryOptions extends MemoryModuleFactoryOptions {
  /** In-memory adjacency store; defaults to `InMemoryGraphStore`. */
  readonly store?: GraphStore;
  /** Optional LLM-backed (or stub) summarizer, same type as InMemoryMemoryModule. */
  readonly summarizer?: MemorySummarizer;
  /** Optional delegate MemoryModule to forward remember/getContext calls to. */
  readonly delegate?: MemoryModule;
  /** How many recent steps getContext() returns (default 5). */
  readonly recentSteps?: number;
  /** Max characters of rendered context (budget guard, default 2000). */
  readonly maxChars?: number;
}

/** How remember()/getContext() surfaced errors are reported to the caller. */
export interface GraphFailureReport {
  /** True when the summarizer threw while refreshing the summary. */
  summarizerFailed: boolean;
  /** True when a delegate MemoryModule threw while forwarding a call. */
  delegateFailed: boolean;
  /** Non-empty strings describe the first summarizer/delegate error message. */
  errorMessages: string[];
}

const DEFAULT_RECENT_STEPS = 5;
const DEFAULT_MAX_CHARS = 2000;

/** Prefix used to build opaque, deterministic-ish node ids from step keys. */
const STEP_ID_PREFIX = "claim:step:";

/**
 * Default, fail-safe renderer used when no summarizer is injected. It produces
 * a stable textual rendering of the recent chain so getContext() still returns
 * useful context even without an LLM-backed summarizer.
 */
export function defaultChainRenderer(chain: readonly GraphNode[]): string {
  if (chain.length === 0) return "";
  const lines = chain.map((node) => {
    const outcome = node.attributes?.outcome ?? "unknown";
    const detail = node.attributes?.outcomeDetail ?? "";
    const actions =
      Array.isArray(node.attributes?.actions) && (node.attributes.actions as unknown[]).length > 0
        ? ` [${String(node.attributes.actions)}]`
        : "";
    return `[${node.attributes?.stepIndex ?? "?"}] ${outcome}${detail ? `: ${String(detail)}` : ""}${actions}`;
  });
  return `Session ${chain[0]?.sessionId ?? ""} steps:\n${lines.join("\n")}`;
}

/**
 * Default, fail-safe summarizer body used when no summarizer is injected. It
 * renders the ordered `MemorySummarizeInput` entries (which carry step
 * context, actions, and outcome) into a readable, LLM-ready chain. Kept as a
 * standalone function so it can be reused/tested independently of the module.
 */
function defaultChainRendererEntries(input: MemorySummarizeInput): string {
  if (input.entries.length === 0) return "";
  const lines = input.entries.map((entry) => {
    const stepIndex = String((entry.context?.context as { step?: unknown } | undefined)?.step ?? "?");
    const actions = entry.actions.length > 0 ? ` [${entry.actions.join(", ")}]` : "";
    const detail = entry.outcomeDetail !== undefined ? `: ${renderJson(entry.outcomeDetail)}` : "";
    return `[${stepIndex}] ${entry.outcome}${detail}${actions}`;
  });
  return `Session ${input.sessionId} steps:\n${lines.join("\n")}`;
}

/**
 * Graph-backed MemoryModule that records plan steps as nodes/edges and
 * refreshes a concise per-session summary via an injected summarizer.
 *
 * Behavior:
 *  - remember(input) upserts the session's plan entity node and the step claim
 *    node (keyed by session + step index), links the step to the plan and to
 *    the prior step in the same session, refreshes the summary via the
 *    summarizer (or default renderer) over the recent chain, and forwards to a
 *    delegate when present.
 *  - getContext(request) returns a rendered summary of the recent chain plus
 *    provenance, and merges in delegate context.
 *  - Fail-safe: remember()/getContext() never reject because of a summarizer,
 *    storage, or delegate failure; the first failure is recorded on
 *    `lastFailure` and surfaced to the caller (which the plan loop treats as
 *    non-fatal).
 */
export class GraphMemoryModule implements MemoryModule {
  private readonly store: GraphStore;
  private readonly summarizer: MemorySummarizer;
  private readonly delegate?: MemoryModule;
  private readonly recentSteps: number;
  private readonly maxChars: number;
  private readonly summaryBySession = new Map<string, string>();
  /** Monotonic counter used to generate opaque edge/node ids. */
  private count = 0;

  /** The most recent non-fatal failure reported by this module, if any. */
  lastFailure: GraphFailureReport | null = null;

  constructor(options: GraphMemoryOptions = {}) {
    this.store = options.store ?? new InMemoryGraphStore();
    this.summarizer = options.summarizer ?? this.defaultSummarizer;
    this.delegate = options.delegate;
    this.recentSteps = options.recentSteps ?? DEFAULT_RECENT_STEPS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  /**
   * Record one completed plan step as nodes/edges in the graph.
   *
   * Failures from the summarizer, store, or delegate are absorbed into
   * `lastFailure` and never reject, so the plan loop can continue safely.
   */
  async remember(input: RememberInput): Promise<void> {
    const sessionId = input.context.session_id;
    // The store is trusted to be a plain in-memory structure; wrap in a
    // try/catch for fail-safe behavior regardless.
    try {
      this.applyStep(input);
    } catch (error) {
      this.lastFailure = {
        summarizerFailed: false,
        delegateFailed: false,
        errorMessages: [summarizeError(error)],
      };
      return;
    }

    const report: GraphFailureReport = {
      summarizerFailed: false,
      delegateFailed: false,
      errorMessages: [],
    };

    const chain = this.store.recentChain(sessionId, this.recentSteps);
    const previous = this.summaryBySession.get(sessionId);
    try {
      const next = await this.summarizer({ sessionId, previousSummary: previous, entries: chainToEntries(chain) });
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
   * Retrieve summarized context for the current turn.
   *
   * Combines this module's own chain-derived summary/provenance with the
   * delegate's (when present) so chained stores contribute context without
   * duplication. Respects `request.maxChars` (falling back to the module's
   * configured budget) when trimming the rendered text.
   */
  async getContext(request: ContextRequest): Promise<MemoryContextResult> {
    const own = this.ownContext(request);
    if (!this.delegate) {
      return own;
    }
    try {
      const delegated = await this.delegate.getContext(request);
      const budget = request.maxChars ?? this.maxChars;
      return mergeContextResults([own, delegated], budget);
    } catch (error) {
      this.lastFailure = {
        summarizerFailed: false,
        delegateFailed: true,
        errorMessages: [summarizeError(error)],
      };
      return own;
    }
  }

  /** The number of remembered plan steps for a session (0 when none). */
  countForSession(sessionId: string): number {
    return this.store.stepsForSession(sessionId).length;
  }

  /** The current raw summary string for a session, if any. */
  summaryForSession(sessionId: string): string | undefined {
    return this.summaryBySession.get(sessionId);
  }

  // ------------------------------------------------------------------ *
  // Internals
  // ------------------------------------------------------------------ *

  private ownContext(request: ContextRequest): MemoryContextResult {
    const sessionId = request.session_id;
    const chain = this.store.recentChain(sessionId, this.recentSteps);
    const matched = this.store.stepsForSession(sessionId).map((node) => nodeToMemoryContext(node));

    let text = this.summaryBySession.get(sessionId) ?? "";
    if (text.length === 0 && chain.length > 0) {
      text = defaultChainRenderer(chain);
    }
    if (text.length === 0 && chain.length === 0) {
      text = "";
    }
    const budget = request.maxChars ?? this.maxChars;
    if (text.length > budget) {
      text = `${text.slice(0, budget)}…`;
    }
    return {
      text,
      matchedContexts: matched,
      hasMemory: chain.length > 0,
    };
  }

  /**
   * Build the plan entity node and the step claim node for a remember() call,
   * link them, and store them. Idempotent: re-remembering the same
   * session/step updates the existing step node rather than duplicating it.
   */
  private applyStep(input: RememberInput): void {
    const sessionId = input.context.session_id;
    const stepIndex = extractStepIndex(input.context);

    // Upsert the plan entity node.
    const existingPlan = this.store.planForSession(sessionId);
    const planLabel = planLabelOf(input.context);
    if (!existingPlan) {
      const now = nowIso(input);
      this.store.upsertNode({
        id: this.nextId("plan"),
        kind: "entity",
        type: "plan",
        label: planLabel,
        sessionId,
        status: "active",
        createdAt: now,
        updatedAt: now,
        attributes: { label: planLabel },
      });
    } else {
      this.store.upsertNode({
        ...existingPlan,
        updatedAt: nowIso(input),
        attributes: { ...(existingPlan.attributes ?? {}), label: planLabel },
      });
    }
    const planNode = this.store.planForSession(sessionId);
    if (!planNode) throw new Error("plan node missing after upsert");

    // Upsert the step claim node (keyed by session + step index).
    const stepId = stepNodeId(sessionId, stepIndex);
    const existingStep = this.store.getNode(stepId);
    const now = nowIso(input);
    const stepNode: GraphNode = this.buildStepNode(input, sessionId, stepIndex, stepId, now, existingStep);
    this.store.upsertNode(stepNode);

    // Link step -> plan.
    this.store.upsertEdge(this.makeEdge("depends_on", stepNode.id, planNode.id, now));

    // Link step -> prior step in the same session (chain).
    const steps = this.store.stepsForSession(sessionId).filter((n) => n.id !== stepId);
    const prior = steps[steps.length - 1];
    if (prior) {
      this.store.upsertEdge(this.makeEdge("depends_on", stepNode.id, prior.id, now));
      this.store.upsertEdge(this.makeEdge("derived_from", stepNode.id, prior.id, now));
    }
  }

  private buildStepNode(
    input: RememberInput,
    sessionId: string,
    stepIndex: number,
    stepId: string,
    now: string,
    existingStep: GraphNode | undefined,
  ): GraphNode {
    const type: GraphNodeType = "fact";
    const actions = input.actions.map((a) => a.name);
    const outcomeDetail = boundedValue(renderJson(input.outcomeDetail), 500, "outcome");
    const stepAttributes: GraphAttributes = {
      stepIndex,
      outcome: input.outcome,
      actions,
      outcomeDetail,
      reasoning: boundedValue(input.reasoning ?? "", 500, "reasoning"),
    };
    const base: GraphNode = {
      id: stepId,
      kind: "claim",
      type,
      label: stepClaimLabel(input, stepIndex),
      sessionId,
      status: "active",
      createdAt: existingStep?.createdAt ?? now,
      updatedAt: now,
      attributes: stepAttributes,
    };
    return base;
  }

  private makeEdge(type: GraphEdge["type"], fromId: string, toId: string, now: string): GraphEdge {
    return {
      id: this.nextId("edge"),
      type,
      fromId,
      toId,
      status: "active",
      attributes: { createdAt: now },
    };
  }

  private nextId(prefix: string): string {
    this.count += 1;
    return `${prefix}:${this.count}`;
  }

  private readonly defaultSummarizer: MemorySummarizer = async (
    input: MemorySummarizeInput,
  ): Promise<string> => {
    return defaultChainRendererEntries(input);
  };
}

/**
 * Dependency-injection factory for GraphMemoryModule, satisfying
 * MemoryModuleFactory so it can be swapped without coupling callers to the
 * concrete class.
 */
export const createGraphMemoryModule: MemoryModuleFactory = (
  options: GraphMemoryOptions = {},
): MemoryModule => {
  return new GraphMemoryModule(options);
};

// ------------------------------------------------------------------ *
// Helpers
// ------------------------------------------------------------------ *

/** Opaque, deterministic id for a step claim node keyed by session + index. */
export function stepNodeId(sessionId: string, stepIndex: number): string {
  return `${STEP_ID_PREFIX}${sessionId}:${stepIndex}`;
}

/** Read the step index from the free-form context, falling back to 1. */
function extractStepIndex(context: MemoryContext): number {
  const raw = context.context as StepContextValue | undefined;
  const step = raw?.step;
  if (typeof step === "number" && Number.isFinite(step) && step >= 1) {
    return Math.floor(step);
  }
  return 1;
}

/** Derive a human-readable plan label from the opaque plan reference. */
function planLabelOf(context: MemoryContext): string {
  const plan = context.plan;
  if (typeof plan === "string" && plan.trim().length > 0) return plan.trim();
  if (plan !== undefined && plan !== null) {
    try {
      const s = JSON.stringify(plan);
      if (s && s.length > 0) return s.slice(0, 200);
    } catch {
      /* ignore */
    }
  }
  return "plan";
}

/** Short display label for a step claim node. */
function stepClaimLabel(input: RememberInput, stepIndex: number): string {
  const actionName = input.actions[0]?.name ?? "step";
  return `step ${stepIndex}: ${actionName}`;
}

/** Timestamp for the current mutation (RFC 3339). */
function nowIso(input: RememberInput): string {
  return input.timestamp ?? new Date().toISOString();
}

/** Bounded-value guard: keep a rendered string within a max length. */
function boundedValue(value: string, max: number, fallback: string): string {
  if (value.length === 0) return fallback;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Render an outcome detail payload into a bounded string. */
function renderJson(value: MemoryJsonValue | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Convert a stored step claim node back into a `MemoryContext` for provenance. */
function nodeToMemoryContext(node: GraphNode): MemoryContext {
  const context: { step?: number; outcome?: string } = {};
  if (typeof node.attributes?.stepIndex === "number") {
    context.step = node.attributes.stepIndex;
  }
  if (typeof node.attributes?.outcome === "string") {
    context.outcome = node.attributes.outcome;
  }
  return {
    session_id: node.sessionId,
    context,
  };
}

/** Convert a chain of GraphNodes into MemorySummarizeInput entries. */
function chainToEntries(chain: readonly GraphNode[]): MemorySummarizeInput["entries"] {
  return chain.map((node, index) => ({
    entryAt: index + 1,
    context: nodeToMemoryContext(node),
    actions: Array.isArray(node.attributes?.actions)
      ? ((node.attributes.actions as unknown[]) as string[])
      : [],
    outcome: String(node.attributes?.outcome ?? "unknown"),
    outcomeDetail: node.attributes?.outcomeDetail ?? undefined,
    reasoning: node.attributes?.reasoning !== undefined ? String(node.attributes.reasoning) : undefined,
    timestamp: node.updatedAt,
  }));
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
