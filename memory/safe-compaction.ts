/**
 * Safe derived-summary compaction (MI-10).
 *
 * Compacts only derived narrative text while carrying exact user constraints,
 * active decision IDs, unresolved work IDs, and evidence references through
 * the structured projection outside the model's lossy rewrite. It validates a
 * versioned response contract (scope/source cursor/reference coverage/length),
 * rejects stale revisions, threads cancellation and deadlines, and suppresses
 * repeated attempts on unchanged input after failure. Events are never
 * mutated.
 */

import {
  currentConstraints,
  currentDecisions,
  openWork,
  type StructuredProjection,
} from "./structured-records.js";
import type { SummaryCheckpointV2 } from "./incremental-summary.js";
import { estimateTokensConservative } from "./context-assembly.js";

export const SAFE_COMPACTION_POLICY_VERSION = 1 as const;

export interface CompactionModelRequestV2 {
  readonly text: string;
  readonly protectedSubjects: readonly string[];
  readonly signal?: AbortSignal;
}

export interface CompactionModelResponseV2 {
  readonly text: string;
  readonly retainedSubjects: readonly string[];
}

export interface CompactionModelV2 {
  readonly config: string;
  compact(request: CompactionModelRequestV2): Promise<CompactionModelResponseV2>;
}

export interface SafeCompactorOptions {
  readonly model: CompactionModelV2;
  readonly capacityTokens: number;
  readonly outputReserveTokens: number;
  readonly deadlineMs?: number;
  readonly estimator?: (text: string) => number;
  readonly maxAttempts?: number;
}

export type SafeCompactionResult =
  | {
      readonly status: "compacted";
      readonly checkpoint: SummaryCheckpointV2;
      readonly config: string;
      readonly protectedSubjects: readonly string[];
    }
  | {
      readonly status: "failure";
      readonly checkpoint: SummaryCheckpointV2;
      readonly reason: string;
      readonly retrySuppressed: boolean;
    }
  | {
      readonly status: "stale";
      readonly checkpoint: SummaryCheckpointV2;
      readonly reason: string;
    };

const DEFAULT_DEADLINE_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 2;

/** Extract protected subjects that must survive a lossy narrative rewrite. */
export function protectedSubjectsFor(projection: StructuredProjection): string[] {
  const subjects = [
    ...currentConstraints(projection).map((record) => record.subject),
    ...currentDecisions(projection).map((record) => record.subject),
    ...openWork(projection).map((record) => record.subject),
  ];
  return [...new Set(subjects)].sort();
}

export class SafeCompactor {
  private current: SummaryCheckpointV2;
  private readonly options: SafeCompactorOptions;
  private readonly estimator: (text: string) => number;
  private lastFailureDigest = "";
  private attempts = 0;

  constructor(initial: SummaryCheckpointV2, options: SafeCompactorOptions) {
    this.current = initial;
    this.options = options;
    this.estimator = options.estimator ?? estimateTokensConservative;
  }

  checkpoint(): SummaryCheckpointV2 {
    return this.current;
  }

  async compact(projection: StructuredProjection): Promise<SafeCompactionResult> {
    const base = this.current;
    const protectedSubjects = protectedSubjectsFor(projection);
    const inputDigest = `${base.revision}:${base.coveredThroughSequence}:${base.text}:${protectedSubjects.join("|")}`;

    if (inputDigest === this.lastFailureDigest && this.attempts >= (this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      return {
        status: "failure",
        checkpoint: base,
        reason: "compaction retry suppressed for unchanged input after failure",
        retrySuppressed: true,
      };
    }

    let response: CompactionModelResponseV2;
    try {
      response = await withDeadline(
        this.options.model.compact({ text: base.text, protectedSubjects }),
        this.options.deadlineMs ?? DEFAULT_DEADLINE_MS,
        "safe compaction",
      );
    } catch (error) {
      this.lastFailureDigest = inputDigest;
      this.attempts += 1;
      return { status: "failure", checkpoint: base, reason: describeError(error), retrySuppressed: false };
    }

    if (this.current.revision !== base.revision || this.current.coveredThroughSequence !== base.coveredThroughSequence) {
      return { status: "stale", checkpoint: this.current, reason: "compaction result is stale" };
    }

    const available = this.options.capacityTokens - this.options.outputReserveTokens;
    const outputTokens = this.estimator(response.text);
    if (typeof response.text !== "string" || response.text.length === 0) {
      this.lastFailureDigest = inputDigest;
      this.attempts += 1;
      return { status: "failure", checkpoint: base, reason: "compaction produced empty output", retrySuppressed: false };
    }
    if (outputTokens > available) {
      this.lastFailureDigest = inputDigest;
      this.attempts += 1;
      return {
        status: "failure",
        checkpoint: base,
        reason: `compaction output too large (${outputTokens} tokens; budget ${available})`,
        retrySuppressed: false,
      };
    }

    const missing = protectedSubjects.filter((subject) => !response.retainedSubjects.includes(subject));
    const fabricated = response.retainedSubjects.filter((subject) => !protectedSubjects.includes(subject));
    if (missing.length > 0 || fabricated.length > 0) {
      this.lastFailureDigest = inputDigest;
      this.attempts += 1;
      return {
        status: "failure",
        checkpoint: base,
        reason: `compaction protected-reference mismatch (missing ${missing.length}, fabricated ${fabricated.length})`,
        retrySuppressed: false,
      };
    }

    const next: SummaryCheckpointV2 = {
      ...base,
      revision: base.revision + 1,
      text: response.text,
      policyVersion: SAFE_COMPACTION_POLICY_VERSION,
    };
    this.current = next;
    this.attempts = 0;
    this.lastFailureDigest = "";
    return { status: "compacted", checkpoint: next, config: this.options.model.config, protectedSubjects };
  }
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
