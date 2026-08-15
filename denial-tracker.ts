/**
 * fighting-with-classifier counter.
 *
 * When the tool-safety classifier denies a tool call, the agent may keep
 * retrying the same blocked action instead of changing its approach. That is
 * "fighting the classifier": repeatedly attempting the same goal through an
 * action that the safety gate refuses. Left alone, this burns tokens and
 * stalls the plan. This module detects that pattern and produces an explicit
 * replan directive so the caller can tell the model to stop and re-plan rather
 * than keep firing the denied call.
 *
 * Semantics
 * ---------
 * - A "goal" is the unit of work the agent is currently trying to accomplish
 *   (for this runtime: the active plan step, or the direct single-step prompt).
 *   Denials are tracked per goal key.
 * - A denial is recorded the first time and each subsequent time a tool call
 *   for the current goal is blocked by the classifier.
 * - "Fighting" is defined as the goal's consecutive-denial count reaching
 *   `DENIAL_REPLAN_THRESHOLD` (default 2): at least two separate denied
 *   attempts aimed at the same goal.
 * - When the threshold is reached, `recordDenial` returns a replan directive
 *   that states the attempted action was not allowed and asks the agent to
 *   re-plan. The caller surfaces this directive to the model (e.g. appended to
 *   the denied tool result) and marks the plan-required signal.
 * - Counters are reset when the goal makes progress (`recordSuccess`) or on a
 *   plan change / step boundary (`reset`, `resetAll`), so a fresh approach is
 *   not immediately considered "fighting".
 *
 * The class is deliberately pure and dependency-free so it can be unit tested
 * in isolation and embedded into main.ts's persisted configData via `toJSON`
 * and `fromJSON`.
 */

/** Denials accumulate per goal; reset on success or plan change. */
export interface DenialEntry {
  readonly goalKey: string;
  count: number;
  /** Most recent classifier reason, for the replan directive. */
  lastReason: string;
  /** Most recent tool name that was denied, for the replan directive. */
  lastTool: string;
}

export interface DenialRecordResult {
  /** True exactly at (and past) the fighting threshold. */
  readonly thresholdReached: boolean;
  /** Current consecutive-denial count for the goal. */
  readonly count: number;
  /**
   * Non-null when `thresholdReached` is true: an explicit instruction, stating
   * the attempted action was not allowed, that asks the agent to re-plan
   * instead of repeating the blocked call.
   */
  readonly replanDirective: string | null;
}

/** Number of denied attempts for the same goal that counts as "fighting". */
export const DENIAL_REPLAN_THRESHOLD = 2;

/** Serialized shape persisted into configData.denialTracker. */
export interface DenialTrackerState {
  readonly goals: Record<string, DenialEntry>;
  readonly activeGoal: string | null;
}

function directiveFor(entry: DenialEntry, toolName: string, reason: string, threshold: number): string {
  return [
    `REPLAN DIRECTIVE: the tool call '${toolName}' was denied by the safety classifier ${entry.count}/${threshold} times for this goal,`,
    `so the current approach is "fighting the classifier" and is not progressing.`,
    `The attempted action was NOT allowed: ${reason}`,
    `Do not repeat the denied call. Re-plan this goal: choose an allowed alternative`,
    `operation, restructure the goal so it can be achieved without the blocked action,`,
    `or ask a human before proceeding. Then continue with the revised approach.`,
  ].join(" ");
}

/** Pure, serializable tracker for classifier-denial counters. */
export class DenialTracker {
  private readonly goals: Map<string, DenialEntry>;
  private activeGoal: string | null;
  private readonly threshold: number;

  constructor(threshold: number = DENIAL_REPLAN_THRESHOLD, state?: Partial<DenialTrackerState>) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(`DenialTracker threshold must be a positive integer; got ${threshold}`);
    }
    this.threshold = threshold;
    this.goals = new Map();
    this.activeGoal = null;
    if (state?.goals) {
      for (const entry of Object.values(state.goals)) {
        if (entry && typeof entry.goalKey === "string" && Number.isInteger(entry.count) && entry.count >= 0) {
          this.goals.set(entry.goalKey, {
            goalKey: entry.goalKey,
            count: entry.count,
            lastReason: typeof entry.lastReason === "string" ? entry.lastReason : "",
            lastTool: typeof entry.lastTool === "string" ? entry.lastTool : "",
          });
        }
      }
    }
    if (state?.activeGoal && this.goals.has(state.activeGoal)) {
      this.activeGoal = state.activeGoal;
    }
  }

  /**
   * Record that a tool call for `goalKey` was denied by the classifier.
   * Returns whether the fighting threshold was reached and a replan directive
   * when it was. `reason` and `toolName` feed the human-readable directive.
   */
  recordDenial(goalKey: string, toolName: string, reason: string): DenialRecordResult {
    const key = goalKey || "(default-goal)";
    let entry = this.goals.get(key);
    if (!entry) {
      entry = { goalKey: key, count: 0, lastReason: "", lastTool: "" };
      this.goals.set(key, entry);
    }
    entry.count += 1;
    entry.lastReason = reason;
    entry.lastTool = toolName;
    this.activeGoal = key;
    const thresholdReached = entry.count >= this.threshold;
    return {
      thresholdReached,
      count: entry.count,
      replanDirective: thresholdReached ? directiveFor(entry, toolName, reason, this.threshold) : null,
    };
  }

  /** Record that the given goal made progress (a tool call succeeded). */
  recordSuccess(goalKey: string): void {
    const key = goalKey || "(default-goal)";
    const entry = this.goals.get(key);
    if (entry) entry.count = 0;
  }

  /** Clear the counter for a single goal (e.g. on a plan change for that goal). */
  reset(goalKey: string): void {
    const key = goalKey || "(default-goal)";
    const entry = this.goals.get(key);
    if (entry) entry.count = 0;
  }

  /** Clear every counter and the active-goal marker (e.g. on a new plan phase). */
  resetAll(): void {
    this.goals.clear();
    this.activeGoal = null;
  }

  /** Current consecutive-denial count for a goal (0 when none recorded). */
  countFor(goalKey: string): number {
    const key = goalKey || "(default-goal)";
    return this.goals.get(key)?.count ?? 0;
  }

  /** The goal with the most recent denial, if any. */
  currentGoal(): string | null {
    return this.activeGoal;
  }

  /** Whether any goal has reached the fighting threshold. */
  hasFought(): boolean {
    for (const entry of this.goals.values()) {
      if (entry.count >= this.threshold) return true;
    }
    return false;
  }

  /** Serialize for persistence (e.g. into configData.denialTracker). */
  toJSON(): DenialTrackerState {
    const goals: Record<string, DenialEntry> = {};
    for (const [key, entry] of this.goals) {
      goals[key] = { goalKey: entry.goalKey, count: entry.count, lastReason: entry.lastReason, lastTool: entry.lastTool };
    }
    return { goals, activeGoal: this.activeGoal };
  }
}
