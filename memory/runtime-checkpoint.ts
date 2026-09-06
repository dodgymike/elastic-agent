/**
 * Runtime checkpoint writer (MI-05).
 *
 * A narrow production lifecycle helper that records truthful step outcomes as
 * durable `checkpoint` events at safe execution boundaries. It is opt-in: the
 * runtime's default backend selection is unchanged until MI-16.
 *
 * Rules enforced here:
 *  - reported completion requires valid feedback; malformed feedback becomes
 *    `invalid_feedback`, never `completed`;
 *  - a reported success stays an unverified assertion, distinct from verified
 *    evidence;
 *  - a failed durable append returns a visible `degraded` result and never
 *    replays a tool mutation;
 *  - flush/close are bounded by a deadline so abort paths cannot hang on
 *    summarization or a locked store;
 *  - resuming only returns committed checkpoints; memory never authorizes
 *    automatic re-execution of previously attempted tools.
 */

import {
  stableEventId,
  validateEventAppend,
  validateScope,
  type MemoryAppendResultV2,
  type MemoryCloseResultV2,
  type MemoryEventAppendV2,
  type MemoryEventEnvelopeV2,
  type MemoryFlushResultV2,
  type MemoryOutcomeAssertionV2,
  type MemoryScopeV2,
} from "./contracts-v2.js";
import { sanitizeMemoryJson as sanitizeForPayload } from "./privacy.js";
import type { MemoryEventStore } from "./event-store.js";

/** Store surface the checkpoint writer needs; satisfies MemoryEventStore. */
export interface RuntimeCheckpointStore {
  append(scope: MemoryScopeV2, event: MemoryEventAppendV2): Promise<MemoryAppendResultV2>;
  flush(scope: MemoryScopeV2): Promise<MemoryFlushResultV2>;
  close(scope: MemoryScopeV2): Promise<MemoryCloseResultV2>;
}

export interface RuntimeCheckpointOptions {
  readonly store: RuntimeCheckpointStore;
  readonly scope: MemoryScopeV2;
  readonly runId: string;
  /** Bound for flush/close deadlines. */
  readonly deadlineMs?: number;
}

export interface RuntimeCheckpointInput {
  /** Zero-based step index. */
  readonly stepIndex: number;
  /** Short step label/reference (bounded by the privacy boundary). */
  readonly stepText: string;
  /** Raw reported outcome from the execution lifecycle. */
  readonly reportedOutcome: string;
  /** True only when the execution feedback parsed successfully. */
  readonly feedbackValid: boolean;
  /** Optional attempt number so distinct attempts get distinct event IDs. */
  readonly attempt?: number;
  /** Optional evidence event IDs. */
  readonly evidenceRefs?: readonly string[];
  /** Optional bounded outcome detail. */
  readonly outcomeDetail?: unknown;
}

export type RuntimeCheckpointResult =
  | {
      readonly status: "checkpointed";
      readonly eventId: string;
      readonly sequence: number;
      readonly outcome: MemoryOutcomeAssertionV2;
    }
  | { readonly status: "degraded"; readonly reason: string };

const DEFAULT_DEADLINE_MS = 2000;
const OUTCOME_MAP = new Map<string, MemoryOutcomeAssertionV2>([
  ["completed", "completed"],
  ["failed", "failed"],
  ["aborted", "aborted"],
  ["blocked", "blocked"],
  ["skipped", "skipped"],
  ["unknown", "unknown"],
  ["invalid_feedback", "invalid_feedback"],
]);

/**
 * Normalize a raw reported outcome. Invalid feedback can never become a
 * completed assertion; unrecognized values fall back to `unknown`.
 */
export function normalizeRuntimeOutcome(
  reportedOutcome: unknown,
  feedbackValid: boolean,
): MemoryOutcomeAssertionV2 {
  if (!feedbackValid) return "invalid_feedback";
  if (typeof reportedOutcome === "string") {
    const mapped = OUTCOME_MAP.get(reportedOutcome);
    if (mapped !== undefined) return mapped;
  }
  return "unknown";
}

/** A durable step-outcome checkpoint writer. */
export class RuntimeCheckpointWriter {
  private readonly store: RuntimeCheckpointStore;
  private readonly scope: MemoryScopeV2;
  private readonly runId: string;
  private readonly deadlineMs: number;

  constructor(options: RuntimeCheckpointOptions) {
    this.store = options.store;
    this.scope = validateScope(options.scope);
    if (typeof options.runId !== "string" || options.runId.length === 0) {
      throw new Error("runId must be a non-empty string");
    }
    this.runId = options.runId;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /** Record one bounded checkpoint event and await durability. */
  async recordStep(input: RuntimeCheckpointInput): Promise<RuntimeCheckpointResult> {
    const scope = this.scope;
    const stepIndex = input.stepIndex;
    if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex) || stepIndex < 0) {
      return { status: "degraded", reason: "stepIndex must be a non-negative integer" };
    }
    const outcome = normalizeRuntimeOutcome(input.reportedOutcome, input.feedbackValid);
    const attempt = input.attempt ?? 0;
    const semanticKey = `${this.runId}:attempt:${attempt}:step:${stepIndex}`;
    const payload = sanitizeForPayload({
      stepText: input.stepText,
      ...(input.outcomeDetail !== undefined ? { outcomeDetail: input.outcomeDetail } : {}),
    });
    const event: MemoryEventAppendV2 = {
      eventId: stableEventId(scope, semanticKey),
      identity: { ...scope, runId: this.runId },
      runRef: this.runId,
      stepRef: String(stepIndex),
      kind: "checkpoint",
      outcome: { asserted: outcome, verification: "unverified" },
      ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs } : {}),
      ...(payload !== undefined ? { payload } : {}),
    };
    try {
      validateEventAppend(event);
    } catch (error) {
      return { status: "degraded", reason: describeError(error) };
    }
    const result = await this.store.append(scope, event);
    if (result.status === "durable") {
      return { status: "checkpointed", eventId: event.eventId, sequence: result.sequence, outcome };
    }
    if (result.status === "duplicate") {
      return { status: "checkpointed", eventId: event.eventId, sequence: 0, outcome };
    }
    return {
      status: "degraded",
      reason: result.status === "conflict" ? result.reason : result.reason,
    };
  }

  /** Flush with a bounded deadline. */
  async flush(): Promise<MemoryFlushResultV2> {
    try {
      return await withDeadline(this.store.flush(this.scope), this.deadlineMs, "checkpoint flush");
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
  }

  /** Close with a bounded deadline. */
  async close(): Promise<MemoryCloseResultV2> {
    try {
      return await withDeadline(this.store.close(this.scope), this.deadlineMs, "checkpoint close");
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
  }
}

/** Resume committed checkpoint envelopes for a scope; never auto-re-executes. */
export async function resumeCheckpointedSteps(
  store: MemoryEventStore,
  scope: MemoryScopeV2,
): Promise<readonly MemoryEventEnvelopeV2[]> {
  validateScope(scope);
  const result = await store.retrieve({ scope, purpose: "replay", limit: 500 });
  if (result.degraded) return [];
  return result.events.filter((event) => event.kind === "checkpoint");
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
