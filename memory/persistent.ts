/**
 * Persistent, end-of-plan memory module for the elastic-agent runtime.
 *
 * `PersistentMemoryModule` implements the transport-agnostic `MemoryModule`
 * contract from `memory/types.ts` and extends it with an explicit *end-of-plan*
 * lifecycle: when the plan completes, the caller invokes `finalize(sessionId)`
 * on the store, which
 *
 *   1. gathers every plan step the session remembered during the run,
 *   2. summarises them into a concise, LLM-ready end-of-plan summary through the
 *      same injected `MemorySummarizer` contract used by the in-memory and graph
 *      modules (falling back to a deterministic renderer when none is injected),
 *      and
 *   3. persists that summary (plus lightweight per-step metadata) to a durable,
 *      per-session file on disk via an atomic write.
 *
 * Design goals (mirroring `memory/inMemory.ts` and `memory/graph-memory.ts`):
 *  - Transport-agnostic: no SDK objects, credentials, or storage backends.
 *  - Swappable via dependency injection: the summarizer and the output directory
 *    (and an optional delegate) are injected through the factory, so the runtime
 *    can construct it behind the same `MemoryModuleFactory` reference.
 *  - Chainable: an optional `delegate` MemoryModule receives forwarded
 *    remember()/getContext() calls so the persistent module can sit in front of
 *    (or behind) another store.
 *  - Fail-safe: remember()/getContext()/finalize() never reject because of a
 *    summarizer, storage, or delegate failure; the first failure is recorded on
 *    `lastFailure` and surfaced, which the plan loop treats as non-fatal.
 *
 * The persisted payload is built exclusively from the non-secret episodic data
 * the caller already passes to remember() (session id, step actions, outcome,
 * reasoning, plan label) — never from any secret store or data sink.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ContextRequest,
  MemoryContextResult,
  MemoryJsonValue,
  MemoryModule,
  MemoryModuleFactory,
  MemoryModuleFactoryOptions,
  RememberInput,
} from "./types.js";
import type { MemorySummarizeInput, MemorySummarizer } from "./inMemory.js";
import { defaultHistorySummarizer, mergeContextResults } from "./inMemory.js";

/** How remember()/finalize() surfaced errors are reported to the caller. */
export interface PersistentFailureReport {
  /** True when the summarizer threw while building the end-of-plan summary. */
  summarizerFailed: boolean;
  /** True when persisting the summary to disk threw. */
  persistFailed: boolean;
  /** True when a delegate MemoryModule threw while forwarding a call. */
  delegateFailed: boolean;
  /** Non-empty strings describe the first failure errors. */
  errorMessages: string[];
}

/**
 * A single remembered plan step as retained by the persistent module for the
 * end-of-plan summary. Lightweight, JSON-serializable, and non-secret.
 */
export interface PersistentStepRecord {
  /** Monotonic index of this step within the session (1-based). */
  readonly step: number;
  /** Human-readable action names performed in the step. */
  readonly actions: readonly string[];
  /** How the step ended. */
  readonly outcome: string;
  /** Free-form detail about the step's outcome/error. */
  readonly outcomeDetail?: MemoryJsonValue;
  /** The reasoning/narrative behind the step. */
  readonly reasoning?: string;
  /** The step description carried on the first action, if any. */
  readonly description?: string;
  /** ISO-8601 timestamp of step completion (may be absent). */
  readonly timestamp?: string;
}

/**
 * The durable, on-disk document produced by finalize() for one session. It is
 * a plain JSON record of the end-of-plan summary plus lightweight per-step
 * metadata — used only for durable recall/audit, never for secrets.
 */
export interface PersistentMemoryDocument {
  /** Schema/version marker. */
  readonly version: 1;
  /** The session this document belongs to. */
  readonly session_id: string;
  /** Optional user/principal id from the remembered context. */
  readonly user_id?: string;
  /** Opaque plan label/reference from the remembered context. */
  readonly plan?: MemoryJsonValue;
  /** ISO-8601 time finalize() persisted the summary. */
  readonly persistedAt: string;
  /** Number of remembered steps summarized. */
  readonly stepCount: number;
  /** The concise, LLM-ready end-of-plan summary. */
  readonly summary: string;
  /** Lightweight per-step records (in append order). */
  readonly steps: readonly PersistentStepRecord[];
}

/** Default filename base used when deriving a per-session file. */
const FILENAME_BASE = "elastic-agent-memory";

/**
 * Factory options accepted by createPersistentMemoryModule /
 * PersistentMemoryModule.
 *
 * `outputDir` (or `filePath`), `summarizer`, and `delegate` implement durable
 * persistence, LLM-backed summarization, and chaining respectively. Additional
 * backend-specific options are accepted via the index signature of
 * `MemoryModuleFactoryOptions`.
 */
export interface PersistentMemoryOptions extends MemoryModuleFactoryOptions {
  /** Directory into which per-session end-of-plan files are written. */
  readonly outputDir?: string;
  /** Exact file path override (overrides outputDir when both are set). */
  readonly filePath?: string;
  /** Optional LLM-backed (or stub) summarizer, same type as InMemoryMemoryModule. */
  readonly summarizer?: MemorySummarizer;
  /** Optional delegate MemoryModule to forward remember/getContext calls to. */
  readonly delegate?: MemoryModule;
}

/**
 * Persistent MemoryModule that records plan steps in process memory, forwards
 * to an optional delegate for live context, and — at end of plan — summarises
 * and persists the full session to a durable per-session file.
 *
 * Behavior:
 *  - remember(input) records the step locally, refreshes the running summary
 *    via the injected summarizer (or the default renderer), and forwards to a
 *    delegate when present.
 *  - getContext(request) returns the running summary plus provenance and merges
 *    in delegate context.
 *  - finalize(sessionId) gathers the remembered steps, builds a fresh end-of-plan
 *    summary through the summarizer, and writes a `PersistentMemoryDocument`
 *    atomically under the configured output directory.
 *  - Fail-safe: remember()/getContext()/finalize() never reject because of a
 *    summarizer or delegate failure; a failed durable write is surfaced through
 *    a thrown error the plan loop treats as non-fatal. The first failure is
 *    recorded on `lastFailure`.
 */
export class PersistentMemoryModule implements MemoryModule {
  private readonly historyBySession = new Map<string, RememberInput[]>();
  private readonly summaryBySession = new Map<string, string>();
  private readonly summarizer: MemorySummarizer;
  private readonly delegate?: MemoryModule;
  private readonly filePath?: string;
  private readonly outputDir?: string;

  /** The most recent non-fatal failure reported by this module, if any. */
  lastFailure: PersistentFailureReport | null = null;

  constructor(options: PersistentMemoryOptions = {}) {
    this.summarizer = options.summarizer ?? defaultHistorySummarizer;
    this.delegate = options.delegate;
    this.filePath = options.filePath;
    this.outputDir = options.outputDir;
  }

  /**
   * Record one completed plan step.
   *
   * Appends the step to local history, refreshes the running summary, and
   * forwards to the delegate. Failures are absorbed into `lastFailure`; they
   * never reject, so the plan loop can continue safely.
   */
  async remember(input: RememberInput): Promise<void> {
    const sessionId = input.context.session_id;
    let history = this.historyBySession.get(sessionId);
    if (!history) {
      history = [];
      this.historyBySession.set(sessionId, history);
    }
    history.push(input);

    const report: PersistentFailureReport = {
      summarizerFailed: false,
      persistFailed: false,
      delegateFailed: false,
      errorMessages: [],
    };
    const previous = this.summaryBySession.get(sessionId);
    try {
      const next = await this.summarizer({ sessionId, previousSummary: previous, entries: toEntries(history) });
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
   * Combines this module's own running summary/provenance with the delegate's
   * (when present) so chained stores contribute context without duplication.
   */
  async getContext(request: ContextRequest): Promise<MemoryContextResult> {
    const own = this.ownContext(request);
    if (!this.delegate) return own;
    try {
      const delegated = await this.delegate.getContext(request);
      return mergeContextResults([own, delegated], request.maxChars);
    } catch (error) {
      this.lastFailure = {
        summarizerFailed: false,
        persistFailed: false,
        delegateFailed: true,
        errorMessages: [summarizeError(error)],
      };
      return own;
    }
  }

  /**
   * End-of-plan lifecycle: summarise the session's remembered steps and persist
   * the result to a durable per-session file.
   *
   * Returns the resolved durable path on success. On a durable write failure it
   * throws so the caller can surface it; the plan loop treats this as non-fatal
   * (the in-memory record is unaffected). A summarizer failure is absorbed and
   * recorded on `lastFailure`; the running/runtime summary is still persisted.
   *
   * @returns the absolute path of the persisted document for `sessionId`.
   */
  async finalize(sessionId: string): Promise<string> {
    const history = this.historyBySession.get(sessionId) ?? [];
    const steps: PersistentStepRecord[] = history.map((input, index) => toStepRecord(input, index + 1));

    // Build the end-of-plan summary through the (injected) summarizer over the
    // full remembered history. Fall back to the running summary on failure.
    let summary = this.summaryBySession.get(sessionId) ?? "";
    const report: PersistentFailureReport = {
      summarizerFailed: false,
      persistFailed: false,
      delegateFailed: false,
      errorMessages: [],
    };
    try {
      summary = await this.summarizer({
        sessionId,
        previousSummary: summary || undefined,
        entries: toEntries(history),
      });
      this.summaryBySession.set(sessionId, summary);
    } catch (error) {
      report.summarizerFailed = true;
      report.errorMessages = [...report.errorMessages, summarizeError(error)];
    }

    const firstContext = history[0]?.context;
    const document: PersistentMemoryDocument = {
      version: 1,
      session_id: sessionId,
      user_id: firstContext?.user_id,
      plan: toJsonValue(firstContext?.plan),
      persistedAt: new Date().toISOString(),
      stepCount: steps.length,
      summary,
      steps,
    };

    const path = this.resolvePath(sessionId);
    try {
      await atomicWriteJson(path, document);
    } catch (error) {
      report.persistFailed = true;
      report.errorMessages = [...report.errorMessages, summarizeError(error)];
      this.lastFailure = report;
      throw new Error(`Could not persist end-of-plan memory for session ${sessionId}: ${summarizeError(error)}`);
    }

    this.lastFailure = report.summarizerFailed ? report : null;
    return path;
  }

  /** The number of remembered steps for a session (0 when none). */
  countForSession(sessionId: string): number {
    return this.historyBySession.get(sessionId)?.length ?? 0;
  }

  /** The current running summary string for a session, if any. */
  summaryForSession(sessionId: string): string | undefined {
    return this.summaryBySession.get(sessionId);
  }

  private ownContext(request: ContextRequest): MemoryContextResult {
    const sessionId = request.session_id;
    const history = this.historyBySession.get(sessionId) ?? [];
    const summary = this.summaryBySession.get(sessionId);
    let text = summary ?? "";
    if (text.length === 0 && history.length > 0) {
      text = `Session ${sessionId}: ${history.length} step(s) remembered, no summary available.`;
    }
    if (request.maxChars !== undefined && text.length > request.maxChars) {
      text = `${text.slice(0, request.maxChars)}…`;
    }
    return {
      text,
      matchedContexts: history.map((input) => input.context),
      hasMemory: history.length > 0,
    };
  }

  private resolvePath(sessionId: string): string {
    if (this.filePath) return resolve(this.filePath);
    const dir = resolve(this.outputDir ?? "memory-output");
    const safeId = sanitizeFilePart(sessionId);
    return join(dir, `${FILENAME_BASE}-${safeId}.json`);
  }
}

/**
 * Dependency-injection factory for PersistentMemoryModule, satisfying
 * MemoryModuleFactory so it can be swapped without coupling callers to the
 * concrete class.
 */
export const createPersistentMemoryModule: MemoryModuleFactory = (
  options: PersistentMemoryOptions = {},
): MemoryModule => {
  return new PersistentMemoryModule(options);
};

// ------------------------------------------------------------------ *
// Helpers
// ------------------------------------------------------------------ *

/** Convert a list of RememberInput into MemorySummarizeInput entries. */
function toEntries(history: readonly RememberInput[]): MemorySummarizeInput["entries"] {
  return history.map((input, index) => ({
    entryAt: index + 1,
    context: input.context,
    actions: input.actions.map((action) => action.name),
    outcome: input.outcome,
    outcomeDetail: input.outcomeDetail,
    reasoning: input.reasoning,
    timestamp: input.timestamp,
  }));
}

/** Convert one RememberInput into a lightweight, JSON-safe step record. */
function toStepRecord(input: RememberInput, step: number): PersistentStepRecord {
  const first = input.actions[0];
  return {
    step,
    actions: input.actions.map((action) => action.name),
    outcome: input.outcome,
    outcomeDetail: sanitizeJson(input.outcomeDetail),
    reasoning: input.reasoning,
    description: first?.description,
    timestamp: input.timestamp,
  };
}

/** Sanitize an outcome detail value for JSON persistence. */
function sanitizeJson(value: MemoryJsonValue | undefined): MemoryJsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as MemoryJsonValue;
  } catch {
    return String(value);
  }
}

/** Convert an opaque plan reference to a JSON-safe value. */
function toJsonValue(value: unknown): MemoryJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as MemoryJsonValue;
  } catch {
    return String(value);
  }
}

/** Replace characters that are unsafe in a filename with a safe marker. */
function sanitizeFilePart(part: string): string {
  const cleaned = part.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "session";
}

/** Write a JSON document atomically (temp file + rename) to `path`. */
async function atomicWriteJson(path: string, document: PersistentMemoryDocument): Promise<void> {
  const payload = JSON.stringify(document, null, 2);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, payload, "utf-8");
  await rename(tmp, path);
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
