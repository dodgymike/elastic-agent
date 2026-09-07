/**
 * Bounded memory health and efficiency metrics (MI-14).
 *
 * This module is the single metadata-only accounting surface for memory
 * durability, retrieval effectiveness, summarization/compaction work, and
 * auxiliary LLM requests. It deliberately records only counts, durations,
 * token totals, and scoped failure descriptors — never remembered content.
 *
 * Bounds:
 *  - Counter values are plain numbers (no per-session/per-query cardinality).
 *  - Auxiliary LLM request records are retained in a bounded FIFO ring; the
 *    default ceiling is {@link DEFAULT_MAX_LLM_REQUESTS} and older records are
 *    dropped rather than growing without bound.
 *  - The human-readable diagnostic summary and the local report never include
 *    session strings, query text, file paths, or fact payloads. The scoped
 *    failure record keeps an exact session id for monitoring/tests only, and
 *    the summary surfaces only the operation name.
 *
 * Health states are deliberately distinct:
 *  - `memory-disabled`     : no memory backend is attached.
 *  - `no-relevant-memory`  : retrieval succeeded but found nothing relevant.
 *  - `recall-failed`       : a retrieval operation failed (degraded recall).
 *  - `degraded`            : a non-retrieval operation (durable append, init)
 *                            failed or the backend marked itself degraded.
 *  - `healthy`             : none of the above.
 */

import { redactMemoryText } from "./privacy.js";

/** Durability classification of the authoritative backend. */
export type MemoryDurabilityState = "durable" | "volatile" | "unknown";

/** Distinct memory health states exposed to callers and the CLI. */
export type MemoryHealthState =
  | "memory-disabled"
  | "healthy"
  | "degraded"
  | "no-relevant-memory"
  | "recall-failed";

/** Bounded operation counters. All values are monotonic counters or gauges. */
export interface MemoryOperationCounters {
  /** Total append attempts, durable successes, and failures. */
  readonly appendAttempts: number;
  readonly appendDurable: number;
  readonly appendFailed: number;
  /** Store initialization attempts and failures. */
  readonly initializeAttempts: number;
  readonly initializeFailed: number;
  /** Legacy import attempts and failures. */
  readonly importAttempts: number;
  readonly importFailed: number;
  /** Retrieval attempts, failures, cache hits, and candidate/selection counts. */
  readonly retrievalAttempts: number;
  readonly retrievalFailed: number;
  readonly cacheHits: number;
  readonly candidatesSeen: number;
  readonly selectedCount: number;
  readonly omittedCount: number;
  /** Summarizer and compactor attempts/failures/cancellations/stale results. */
  readonly summaryAttempts: number;
  readonly summaryFailed: number;
  readonly compactionAttempts: number;
  readonly compactionCancelled: number;
  readonly staleResults: number;
  /** Current retained conversation count (a gauge, not a cumulative counter). */
  readonly retainedConversations: number;
}

/**
 * Auxiliary LLM request usage. `measured` distinguishes provider-reported
 * token usage from local estimates; unknown usage stays absent rather than
 * being silently reported as zero.
 */
export interface LlmAuxiliaryUsage {
  readonly measured: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
}

/**
 * One bounded, metadata-only auxiliary LLM request record. Carries purpose,
 * provider/model, a non-sensitive correlation id, and measured-vs-estimated
 * usage — never prompt or response content.
 */
export interface LlmAuxiliaryRequestRecord {
  readonly correlationId: string;
  readonly purpose: string;
  readonly provider?: string;
  readonly model?: string;
  /** 1-based attempt number (retries increment it). */
  readonly attempt: number;
  readonly succeeded: boolean;
  readonly durationMs: number;
  readonly usage: LlmAuxiliaryUsage;
}

/** A failure scoped to one operation and optionally one session. */
export interface ScopedMemoryFailure {
  readonly operation: string;
  readonly sessionId: string | null;
  /** Truncated, redacted failure message (monitoring only). */
  readonly message: string;
}

/** Aggregated auxiliary LLM request accounting for the snapshot. */
export interface LlmRequestSummary {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  /** Requests with provider-reported token usage. */
  readonly measured: number;
  /** Requests with only locally estimated token usage. */
  readonly estimated: number;
  /** Requests with no usage information at all (never reported as zero). */
  readonly unknown: number;
}

/**
 * Immutable health snapshot exposed to tests, monitoring, and the CLI. It is
 * metadata-only and safe to log: no remembered content is present.
 */
export interface MemoryHealthSnapshot {
  readonly backendType: string;
  readonly enabled: boolean;
  readonly initialized: boolean;
  readonly lastCommittedSequence: number;
  readonly pendingSummaryCursor: number | null;
  readonly degraded: boolean;
  readonly degradedReason: string | null;
  readonly durability: MemoryDurabilityState;
  readonly storageSchemaVersion: number | null;
  readonly state: MemoryHealthState;
  readonly counters: MemoryOperationCounters;
  readonly lastFailure: ScopedMemoryFailure | null;
  readonly llmRequests: readonly LlmAuxiliaryRequestRecord[];
  readonly llmRequestSummary: LlmRequestSummary;
}

/** Options for {@link MemoryHealthMetrics}. */
export interface MemoryHealthMetricsOptions {
  readonly durability?: MemoryDurabilityState;
  readonly storageSchemaVersion?: number | null;
  /** Ceiling for retained auxiliary LLM request records (bounded cardinality). */
  readonly maxLlmRequests?: number;
}

/** Default ceiling for retained auxiliary LLM request records. */
export const DEFAULT_MAX_LLM_REQUESTS = 100 as const;

/** Maximum length of a retained scoped failure message. */
const MAX_FAILURE_MESSAGE_CHARS = 240;

type MutableOperationCounters = {
  -readonly [K in keyof MemoryOperationCounters]: MemoryOperationCounters[K];
};

type MutableLlmRequestSummary = {
  -readonly [K in keyof LlmRequestSummary]: LlmRequestSummary[K];
};

const EMPTY_COUNTERS: MutableOperationCounters = {
  appendAttempts: 0,
  appendDurable: 0,
  appendFailed: 0,
  initializeAttempts: 0,
  initializeFailed: 0,
  importAttempts: 0,
  importFailed: 0,
  retrievalAttempts: 0,
  retrievalFailed: 0,
  cacheHits: 0,
  candidatesSeen: 0,
  selectedCount: 0,
  omittedCount: 0,
  summaryAttempts: 0,
  summaryFailed: 0,
  compactionAttempts: 0,
  compactionCancelled: 0,
  staleResults: 0,
  retainedConversations: 0,
};

function emptyLlmRequestSummary(): MutableLlmRequestSummary {
  return { total: 0, succeeded: 0, failed: 0, measured: 0, estimated: 0, unknown: 0 };
}

/** Immutable, zero-value snapshot for a backend with no recorded activity. */
export function emptyHealthSnapshot(options: {
  readonly backendType: string;
  readonly enabled?: boolean;
  readonly durability?: MemoryDurabilityState;
  readonly storageSchemaVersion?: number | null;
}): MemoryHealthSnapshot {
  return {
    backendType: options.backendType,
    enabled: options.enabled ?? true,
    initialized: false,
    lastCommittedSequence: 0,
    pendingSummaryCursor: null,
    degraded: false,
    degradedReason: null,
    durability: options.durability ?? "unknown",
    storageSchemaVersion: options.storageSchemaVersion ?? null,
    state: "healthy",
    counters: { ...EMPTY_COUNTERS },
    lastFailure: null,
    llmRequests: [],
    llmRequestSummary: emptyLlmRequestSummary(),
  };
}

/** Result passed to {@link MemoryHealthMetrics.recordAppend}. */
export interface AppendHealthResult {
  readonly status: "durable" | "duplicate" | "conflict" | "failure";
  readonly sequence?: number;
  readonly sessionId?: string;
  readonly reason?: string;
}

/** Result passed to {@link MemoryHealthMetrics.recordRetrieval}. */
export interface RetrievalHealthResult {
  readonly success: boolean;
  readonly sessionId?: string;
  readonly cacheHit?: boolean;
  readonly candidates?: number;
  readonly selected?: number;
  readonly omitted?: number;
  readonly hasMemory?: boolean;
  readonly reason?: string;
}

/**
 * Bounded memory health/efficiency collector.
 *
 * One instance belongs to one backend instance, so failures are scoped to that
 * backend and — via {@link ScopedMemoryFailure} — to the operation/session
 * where they occurred. There is no process-wide mutable `lastFailure`.
 */
export class MemoryHealthMetrics {
  private backendType: string;
  private enabled = true;
  private initialized = false;
  private lastCommittedSequence = 0;
  private pendingSummaryCursor: number | null = null;
  private degraded = false;
  private explicitDegraded = false;
  private degradedReason: string | null = null;
  private durability: MemoryDurabilityState;
  private storageSchemaVersion: number | null;
  private lastFailure: ScopedMemoryFailure | null = null;
  private lastRetrievalHadMemory: boolean | null = null;

  private readonly maxLlmRequests: number;
  private readonly llmRequests: LlmAuxiliaryRequestRecord[] = [];
  private readonly llmSummary = emptyLlmRequestSummary();

  private readonly counters: MutableOperationCounters = { ...EMPTY_COUNTERS };

  constructor(backendType = "unknown", options: MemoryHealthMetricsOptions = {}) {
    this.backendType = backendType;
    this.durability = options.durability ?? "unknown";
    this.storageSchemaVersion = options.storageSchemaVersion ?? null;
    this.maxLlmRequests = normalizeLlmRequestCeiling(options.maxLlmRequests);
  }

  setBackendType(backendType: string): void {
    this.backendType = backendType;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setInitialized(initialized: boolean): void {
    this.initialized = initialized;
  }

  setLastCommittedSequence(sequence: number): void {
    if (Number.isSafeInteger(sequence) && sequence > this.lastCommittedSequence) {
      this.lastCommittedSequence = sequence;
    }
  }

  setPendingSummaryCursor(cursor: number | null): void {
    if (cursor === null || (Number.isSafeInteger(cursor) && cursor >= 0)) {
      this.pendingSummaryCursor = cursor;
    }
  }

  setStorageSchemaVersion(version: number | null): void {
    this.storageSchemaVersion = version;
  }

  setRetainedConversations(count: number): void {
    if (Number.isSafeInteger(count) && count >= 0) {
      this.counters.retainedConversations = count;
    }
  }

  markDegraded(reason: string): void {
    this.explicitDegraded = true;
    this.degraded = true;
    this.degradedReason = truncateFailureMessage(reason);
  }

  /**
   * Record a scoped failure without clobbering a different operation's failure
   * record through a shared mutable global. The most recent failure wins, but
   * it always carries its own operation and session.
   */
  recordFailure(operation: string, sessionId: string | null, message: string): void {
    this.lastFailure = {
      operation,
      sessionId,
      message: truncateFailureMessage(message),
    };
    this.degraded = true;
    if (this.degradedReason === null) this.degradedReason = truncateFailureMessage(message);
  }

  /** Clear a failure only when the same operation (and session, if given) recovered. */
  clearFailure(operation: string, sessionId?: string): void {
    const current = this.lastFailure;
    if (!current) return;
    if (current.operation !== operation) return;
    if (sessionId !== undefined && current.sessionId !== sessionId) return;
    this.lastFailure = null;
    if (!this.explicitDegraded) {
      this.degraded = false;
      this.degradedReason = null;
    }
  }

  /** Record one durable append attempt and its outcome. */
  recordAppend(result: AppendHealthResult): void {
    this.counters.appendAttempts += 1;
    if (result.status === "durable") {
      this.counters.appendDurable += 1;
      if (result.sequence !== undefined) this.setLastCommittedSequence(result.sequence);
      this.clearFailure("append", result.sessionId);
    } else if (result.status === "duplicate") {
      // Idempotent duplicate writes are not failures and carry no new sequence.
      this.clearFailure("append", result.sessionId);
    } else {
      this.counters.appendFailed += 1;
      this.recordFailure("append", result.sessionId ?? null, result.reason ?? "durable append failed");
    }
  }

  /** Record store initialization. */
  recordInitialization(success: boolean, reason?: string): void {
    this.counters.initializeAttempts += 1;
    if (success) {
      this.initialized = true;
      this.clearFailure("initialize");
    } else {
      this.counters.initializeFailed += 1;
      this.recordFailure("initialize", null, reason ?? "initialization failed");
    }
  }

  /** Record a legacy import attempt. */
  recordImport(success: boolean, reason?: string): void {
    this.counters.importAttempts += 1;
    if (!success) {
      this.counters.importFailed += 1;
      this.recordFailure("import", null, reason ?? "import failed");
    }
  }

  /** Record one retrieval operation (cache hit, candidate/selection counts). */
  recordRetrieval(result: RetrievalHealthResult): void {
    this.counters.retrievalAttempts += 1;
    if (!result.success) {
      this.counters.retrievalFailed += 1;
      this.lastRetrievalHadMemory = false;
      this.recordFailure("retrieval", result.sessionId ?? null, result.reason ?? "retrieval failed");
      return;
    }
    if (result.cacheHit === true) this.counters.cacheHits += 1;
    this.counters.candidatesSeen += nonNegative(result.candidates);
    this.counters.selectedCount += nonNegative(result.selected);
    this.counters.omittedCount += nonNegative(result.omitted);
    this.lastRetrievalHadMemory = result.hasMemory === true;
    if (result.hasMemory === true) {
      this.clearFailure("retrieval", result.sessionId);
    }
  }

  /** Record a direct cache hit (e.g. from a projection/cache layer). */
  recordCacheHit(): void {
    this.counters.cacheHits += 1;
  }

  /** Record one summarization attempt. */
  recordSummaryAttempt(success: boolean): void {
    this.counters.summaryAttempts += 1;
    if (!success) this.counters.summaryFailed += 1;
  }

  /** Record one compaction attempt, including cancellations and stale results. */
  recordCompactionAttempt(options: { cancelled?: boolean; stale?: boolean } = {}): void {
    this.counters.compactionAttempts += 1;
    if (options.cancelled === true) this.counters.compactionCancelled += 1;
    if (options.stale === true) this.counters.staleResults += 1;
  }

  /** Record one auxiliary LLM request (including failures and retries). */
  recordLlmRequest(record: LlmAuxiliaryRequestRecord): void {
    this.llmSummary.total += 1;
    if (record.succeeded) this.llmSummary.succeeded += 1;
    else this.llmSummary.failed += 1;
    if (record.usage.measured) {
      this.llmSummary.measured += 1;
    } else if (
      record.usage.estimatedInputTokens !== undefined ||
      record.usage.estimatedOutputTokens !== undefined
    ) {
      this.llmSummary.estimated += 1;
    } else {
      this.llmSummary.unknown += 1;
    }

    this.llmRequests.push(record);
    if (this.llmRequests.length > this.maxLlmRequests) {
      this.llmRequests.splice(0, this.llmRequests.length - this.maxLlmRequests);
    }
  }

  /** Build an immutable snapshot of the current health/metrics state. */
  snapshot(): MemoryHealthSnapshot {
    return {
      backendType: this.backendType,
      enabled: this.enabled,
      initialized: this.initialized,
      lastCommittedSequence: this.lastCommittedSequence,
      pendingSummaryCursor: this.pendingSummaryCursor,
      degraded: this.degraded,
      degradedReason: this.degradedReason,
      durability: this.durability,
      storageSchemaVersion: this.storageSchemaVersion,
      state: this.deriveState(),
      counters: { ...this.counters },
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
      llmRequests: [...this.llmRequests],
      llmRequestSummary: { ...this.llmSummary },
    };
  }

  /** Concise, non-sensitive single-line diagnostic summary. */
  diagnosticSummary(): string {
    return formatHealthDiagnostic(this.snapshot());
  }

  /** Derive the distinct health state from current collector data. */
  private deriveState(): MemoryHealthState {
    if (!this.enabled) return "memory-disabled";
    if (this.lastFailure?.operation === "retrieval" || this.counters.retrievalFailed > 0) {
      return "recall-failed";
    }
    if (this.degraded || this.lastFailure !== null) return "degraded";
    if (
      this.counters.retrievalAttempts > 0 &&
      this.counters.retrievalFailed === 0 &&
      this.counters.selectedCount === 0 &&
      this.lastRetrievalHadMemory === false
    ) {
      return "no-relevant-memory";
    }
    return "healthy";
  }
}

/** Concise, non-sensitive diagnostic line for a snapshot. */
export function formatHealthDiagnostic(snapshot: MemoryHealthSnapshot): string {
  const counters = snapshot.counters;
  const summary = snapshot.llmRequestSummary;
  const failure = snapshot.lastFailure ? ` failure=${snapshot.lastFailure.operation}` : "";
  return (
    `memory:${snapshot.backendType} ${snapshot.state} ` +
    `durable=${snapshot.durability} initialized=${snapshot.initialized} ` +
    `committed=${snapshot.lastCommittedSequence} ` +
    `append=${counters.appendDurable}/${counters.appendAttempts} ` +
    `appendFailed=${counters.appendFailed} ` +
    `retrieval=${counters.selectedCount}/${counters.candidatesSeen} ` +
    `summary=${counters.summaryAttempts - counters.summaryFailed}/${counters.summaryAttempts} ` +
    `compaction=${counters.compactionAttempts} ` +
    `llm=${summary.total} (measured=${summary.measured}, estimated=${summary.estimated}, unknown=${summary.unknown}, failed=${summary.failed})` +
    failure
  );
}

/** Input for the reproducible local health report (synthetic sessions only). */
export interface SyntheticSessionHealthInput {
  readonly sessionId: string;
  readonly appendCount: number;
  readonly inputTokens?: number;
  readonly estimatedInputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly retrievalCandidates: number;
  readonly retrievalSelected: number;
  readonly summaryAttempts: number;
  readonly compactionAttempts: number;
  readonly llmRequestCount: number;
  readonly totalLlmDurationMs: number;
}

/**
 * Reproducible, metadata-only local report for synthetic sessions. It shows
 * input growth, retrieval effectiveness, and a cost/latency breakdown, with
 * content logging disabled: session ids are never echoed (rows are addressed
 * by index), and only counts, token totals, and durations are rendered.
 */
export function renderLocalHealthReport(sessions: readonly SyntheticSessionHealthInput[]): string {
  if (sessions.length === 0) return "memory-health-report: no sessions";

  let totalInput = 0;
  let totalEstimatedInput = 0;
  let totalOutput = 0;
  let totalEstimatedOutput = 0;
  let totalCandidates = 0;
  let totalSelected = 0;
  let totalLlmRequests = 0;
  let totalDurationMs = 0;

  const rows: string[] = [];
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const input = nonNegative(session.inputTokens);
    const estimatedInput = nonNegative(session.estimatedInputTokens);
    const output = nonNegative(session.outputTokens);
    const estimatedOutput = nonNegative(session.estimatedOutputTokens);
    const candidates = nonNegative(session.retrievalCandidates);
    const selected = nonNegative(session.retrievalSelected);
    const effectiveness = candidates > 0 ? (selected / candidates) * 100 : 0;
    const llmRequests = nonNegative(session.llmRequestCount);
    const durationMs = nonNegative(session.totalLlmDurationMs);

    totalInput += input;
    totalEstimatedInput += estimatedInput;
    totalOutput += output;
    totalEstimatedOutput += estimatedOutput;
    totalCandidates += candidates;
    totalSelected += selected;
    totalLlmRequests += llmRequests;
    totalDurationMs += durationMs;

    rows.push(
      `session[${index}] append=${nonNegative(session.appendCount)} ` +
        `input=${input}${estimatedInput > 0 ? ` (est ${estimatedInput})` : ""} ` +
        `effectiveness=${effectiveness.toFixed(1)}% (${selected}/${candidates}) ` +
        `summary=${nonNegative(session.summaryAttempts)} compaction=${nonNegative(session.compactionAttempts)} ` +
        `llm=${llmRequests} latency=${durationMs}ms`,
    );
  }

  const overallEffectiveness = totalCandidates > 0 ? (totalSelected / totalCandidates) * 100 : 0;
  const lines = [
    "memory-health-report (metadata-only; session content logging disabled)",
    `sessions=${sessions.length}`,
    `inputGrowth=${totalInput}${totalEstimatedInput > 0 ? ` (estimated ${totalEstimatedInput})` : ""}`,
    `output=${totalOutput}${totalEstimatedOutput > 0 ? ` (estimated ${totalEstimatedOutput})` : ""}`,
    `retrievalEffectiveness=${overallEffectiveness.toFixed(1)}% (${totalSelected}/${totalCandidates})`,
    `llmRequests=${totalLlmRequests} totalLlmLatency=${totalDurationMs}ms`,
    ...rows,
  ];
  return lines.join("\n");
}

function normalizeLlmRequestCeiling(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_LLM_REQUESTS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_MAX_LLM_REQUESTS;
  }
  return value;
}

function nonNegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function truncateFailureMessage(message: string): string {
  const redacted = redactMemoryText(message);
  if (redacted.length <= MAX_FAILURE_MESSAGE_CHARS) return redacted;
  return `${redacted.slice(0, MAX_FAILURE_MESSAGE_CHARS)}…`;
}
