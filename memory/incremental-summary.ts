/**
 * Incremental, revisioned, cancelable summaries (MI-07).
 *
 * Summaries are derived artifacts over the committed event store. This module
 * advances a `SummaryCheckpointV2` using only events after the checkpoint
 * cursor plus a bounded prior summary and protected structured facts, so
 * ordinary updates never re-summarize the full history. Stale or failed
 * summarizer completions never overwrite a newer checkpoint, and timeouts or
 * invalid output retain the previous summary/cursor.
 */

import { createHash } from "node:crypto";
import {
  buildStructuredProjection,
  currentConstraints,
  openWork,
  type StructuredProjection,
  type StructuredRecordV2,
} from "./structured-records.js";
import {
  validateScope,
  type MemoryEventEnvelopeV2,
  type MemoryScopeV2,
} from "./contracts-v2.js";
import { redactMemoryText } from "./privacy.js";

export const INCREMENTAL_SUMMARY_POLICY_VERSION = 1 as const;
export const DETERMINISTIC_SUMMARIZER_VERSION = "deterministic-v1" as const;

export interface SummaryCheckpointV2 {
  readonly scope: MemoryScopeV2;
  readonly coveredThroughSequence: number;
  readonly revision: number;
  readonly text: string;
  readonly protectedFacts: readonly StructuredRecordV2[];
  readonly summarizerVersion: string;
  readonly policyVersion: number;
  readonly inputDigest: string;
}

export interface IncrementalSummarizeInput {
  readonly scope: MemoryScopeV2;
  readonly previous?: SummaryCheckpointV2;
  readonly events: readonly MemoryEventEnvelopeV2[];
  readonly protectedFacts: readonly StructuredRecordV2[];
}

export interface IncrementalSummarizer {
  readonly version: string;
  summarize(input: IncrementalSummarizeInput): Promise<string>;
}

export interface IncrementalSummaryOptions {
  readonly summarizer: IncrementalSummarizer;
  readonly maxBatchEvents?: number;
  readonly deadlineMs?: number;
  readonly maxPriorChars?: number;
  readonly maxOutputChars?: number;
  /** Skip the injected summarizer entirely and use the offline renderer. */
  readonly offlineDeterministic?: boolean;
}

export type SummaryAdvanceResult =
  | { readonly status: "advanced"; readonly checkpoint: SummaryCheckpointV2 }
  | { readonly status: "unchanged"; readonly checkpoint: SummaryCheckpointV2 }
  | { readonly status: "failure"; readonly checkpoint: SummaryCheckpointV2; readonly reason: string }
  | { readonly status: "stale"; readonly checkpoint: SummaryCheckpointV2 };

const DEFAULT_MAX_BATCH_EVENTS = 20;
const DEFAULT_DEADLINE_MS = 2000;
const DEFAULT_MAX_PRIOR_CHARS = 4000;
const DEFAULT_MAX_OUTPUT_CHARS = 12000;

/** Deterministic offline renderer used for the named deterministic mode. */
export function deterministicIncrementalSummarize(input: IncrementalSummarizeInput): string {
  const lines = input.events.map((event) => {
    const subject = event.kind === "checkpoint" ? `checkpoint ${event.stepRef ?? ""}` : event.kind;
    const outcome = event.outcome?.asserted ?? "unknown";
    return `[${event.sequence}] ${subject} ${outcome}`;
  });
  const facts = input.protectedFacts.map((fact) => `constraint: ${fact.subject}`).join("\n");
  const parts = [
    input.previous?.text ? `prior: ${input.previous.text}` : undefined,
    lines.length > 0 ? lines.join("\n") : undefined,
    facts.length > 0 ? `facts:\n${facts}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join("\n");
}

function digestOf(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** Manages a derived summary checkpoint over committed events. */
export class IncrementalSummaryManager {
  private current: SummaryCheckpointV2;
  private projection: StructuredProjection;
  private readonly options: IncrementalSummaryOptions;
  private deletionGeneration = 0;

  constructor(scope: MemoryScopeV2, options: IncrementalSummaryOptions, initial?: SummaryCheckpointV2) {
    validateScope(scope);
    this.options = options;
    this.projection = buildStructuredProjection(scope, []);
    this.current =
      initial ??
      ({
        scope,
        coveredThroughSequence: 0,
        revision: 0,
        text: "",
        protectedFacts: [],
        summarizerVersion: options.summarizer.version,
        policyVersion: INCREMENTAL_SUMMARY_POLICY_VERSION,
        inputDigest: "",
      } satisfies SummaryCheckpointV2);
  }

  /** The current checkpoint. */
  checkpoint(): SummaryCheckpointV2 {
    return this.current;
  }

  /** The deletion generation this manager last observed. */
  deletionGenerationNow(): number {
    return this.deletionGeneration;
  }

  /**
   * Notify the manager that the authoritative store advanced its deletion
   * generation. An in-flight `advance()` that started before this notification
   * is treated as stale and never overwrites the current checkpoint.
   */
  setDeletionGeneration(generation: number): void {
    if (typeof generation === "number" && Number.isInteger(generation) && generation >= 0) {
      this.deletionGeneration = generation;
    }
  }

  /**
   * Advance the summary over the supplied ordered events. Only events after
   * the current cursor are summarized; empty batches make no summarizer call.
   */
  async advance(events: readonly MemoryEventEnvelopeV2[]): Promise<SummaryAdvanceResult> {
    const base = this.current;
    const generationAtStart = this.deletionGeneration;
    const batch = events
      .filter((event) => event.sequence > base.coveredThroughSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, this.options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS);
    if (batch.length === 0) {
      return { status: "unchanged", checkpoint: base };
    }

    this.projection = buildStructuredProjection(base.scope, batch, this.projection);
    const protectedFacts = [...currentConstraints(this.projection), ...openWork(this.projection)];
    const priorText = boundText(base.text, this.options.maxPriorChars ?? DEFAULT_MAX_PRIOR_CHARS);
    const input: IncrementalSummarizeInput = {
      scope: base.scope,
      previous: { ...base, text: priorText },
      events: batch,
      protectedFacts,
    };

    let text: string;
    try {
      if (this.options.offlineDeterministic === true) {
        text = deterministicIncrementalSummarize(input);
      } else {
        text = await withDeadline(
          this.options.summarizer.summarize(input),
          this.options.deadlineMs ?? DEFAULT_DEADLINE_MS,
          "incremental summarize",
        );
      }
      if (typeof text !== "string" || text.length === 0) {
        return { status: "failure", checkpoint: base, reason: "summarizer returned invalid/empty output" };
      }
      text = redactMemoryText(text);
      if (text.length > (this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)) {
        text = `${text.slice(0, this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)}…[truncated]`;
      }
    } catch (error) {
      return { status: "failure", checkpoint: base, reason: describeError(error) };
    }

    // A deletion that advanced the generation while the summarizer was in
    // flight invalidates this completion: accepting it could resurrect content
    // that has already been forgotten.
    if (this.deletionGeneration !== generationAtStart) {
      return { status: "stale", checkpoint: this.current };
    }

    // Stale completions never overwrite a newer checkpoint.
    if (this.current.revision > base.revision || this.current.coveredThroughSequence > base.coveredThroughSequence) {
      return { status: "stale", checkpoint: this.current };
    }

    const coveredThroughSequence = batch[batch.length - 1].sequence;
    const next: SummaryCheckpointV2 = {
      scope: base.scope,
      coveredThroughSequence,
      revision: base.revision + 1,
      text,
      protectedFacts,
      summarizerVersion: this.options.offlineDeterministic === true
        ? DETERMINISTIC_SUMMARIZER_VERSION
        : this.options.summarizer.version,
      policyVersion: INCREMENTAL_SUMMARY_POLICY_VERSION,
      inputDigest: digestOf([base.scope, base.coveredThroughSequence, priorText, batch.map((e) => e.eventId)]),
    };
    this.current = next;
    return { status: "advanced", checkpoint: next };
  }
}

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated]`;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms deadline`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
