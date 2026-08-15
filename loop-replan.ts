/**
 * loop-replan.ts — re-planning orchestration for loop-mode relevant messages.
 *
 * Loop mode (`--loop`, see cli-task-mode.ts and loop-mode.ts) watches the Agent
 * Bus at execution-step boundaries. A *relevant* message (one that references
 * the current plan/task ID or carries a plan-change directive) must abort the
 * plan in flight and re-enter the planning phase with that message as the new
 * input. This module owns the *decision* half of that replan:
 *
 *   - `extractReplanPrompt` turns the pending relevant bus messages into the
 *     new prompt that re-enters planning (concatenating the searchable text of
 *     each relevant message so no directive is lost).
 *   - `resolveLoopReplanMaxIterations` bounds how many consecutive loop-driven
 *     replans a single run may perform (`LOOP_REPLAN_MAX_ITERATIONS`, default
 *     `DEFAULT_LOOP_REPLAN_MAX_ITERATIONS`) so a busy coordinator cannot drive
 *     the agent into an unbounded plan/execute churn loop.
 *   - `decideSafeReplan` is the fail-safe guard: before re-entering planning we
 *     verify the repository is in a state that can safely carry the new plan.
 *     A preserved execution worktree (uncommitted staged work) is fine to keep
 *     and reuse — the replan re-executes into the same worktree so nothing is
 *     lost. But *uncommitted changes on the main checkout* are not safe to
 *     re-plan over (the new execution phase writes into the worktree, and a
 *     dirty main working tree risks mixing the two change sets), so those
 *     block replanning with an actionable reason instead of corrupting state.
 *
 * The module is intentionally free of network I/O and of the runtime's worktree
 * internals: it receives the relevant state through injected predicates so the
 * decision logic can be unit-tested without a git repository or an Agent Bus.
 * main.ts wires the real worktree/clean-state checks into it.
 */

import { messageToSearchableText, type AgentBusMessageLike } from "./loop-mode.js";

/** Default cap on consecutive loop-driven replans within a single run. */
export const DEFAULT_LOOP_REPLAN_MAX_ITERATIONS = 5;

/** Smallest allowed replan cap, to avoid an accidental empty loop. */
export const MIN_LOOP_REPLAN_MAX_ITERATIONS = 1;

/** Environment variable that overrides the loop-driven replan cap. */
export const LOOP_REPLAN_MAX_ITERATIONS_ENV = "LOOP_REPLAN_MAX_ITERATIONS";

export interface LoopReplanBudget {
  /** Number of loop-driven replans still allowed (0 means stop replanning). */
  readonly remaining: number;
  /** Hard cap the budget was resolved from. */
  readonly maxIterations: number;
}

/**
 * Resolve the loop-driven replan cap from the `LOOP_REPLAN_MAX_ITERATIONS`
 * environment variable (falling back to the default). Non-numeric or
 * out-of-range values fall back to the default rather than throwing, so a
 * misconfigured environment cannot break loop mode.
 */
export function resolveLoopReplanMaxIterations(
  explicit?: number,
  env: string | undefined = process.env[LOOP_REPLAN_MAX_ITERATIONS_ENV],
): number {
  const source = explicit !== undefined ? explicit : Number(env);
  if (Number.isFinite(source) && source >= MIN_LOOP_REPLAN_MAX_ITERATIONS) {
    return Math.round(source);
  }
  return DEFAULT_LOOP_REPLAN_MAX_ITERATIONS;
}

/**
 * Build a replay budget for a run: starting remaining count equals the resolved
 * cap, so a fresh run is allowed that many consecutive loop-driven replans.
 */
export function initialLoopReplanBudget(): LoopReplanBudget {
  const maxIterations = resolveLoopReplanMaxIterations();
  return { remaining: maxIterations, maxIterations };
}

/**
 * Consume one replan from the budget. Returns a new budget with one fewer
 * remaining replan. Never goes below zero.
 */
export function consumeReplanBudget(budget: LoopReplanBudget): LoopReplanBudget {
  return { remaining: Math.max(0, budget.remaining - 1), maxIterations: budget.maxIterations };
}

/**
 * Extract the next planning prompt from the pending relevant bus messages.
 * Each relevant message's searchable text is concatenated (newline-separated)
 * so a multi-message directive (e.g. a plan-ID reference plus a follow-up
 * change-of-direction) is preserved verbatim as the new work order.
 *
 * Returns an empty string when there are no relevant messages, so the caller
 * can detect that no replan is warranted.
 */
export function extractReplanPrompt(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message === null || message === undefined) continue;
    const text = messageToSearchableText(message as AgentBusMessageLike);
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join("\n");
}

/**
 * The state predicates main.ts supplies so the safety guard can decide whether
 * re-entering planning preserves the repo rather than corrupting it. Each
 * predicate is best-effort; a `null` meaning "unknown" is treated as a blocker
 * so loop mode fails safe (close) when it cannot prove the state is clean.
 */
export interface ReplanSafetyChecks {
  /** Whether the execution worktree currently has staged/unstaged work. */
  readonly worktreeHasWork?: () => boolean | null;
  /** Whether the main checkout has uncommitted changes that a replan would risk. */
  readonly mainCheckoutIsDirty?: () => boolean | null;
  /** Whether a preserved execution worktree exists for the replan to reuse. */
  readonly worktreeExists?: () => boolean | null;
}

export interface ReplanSafetyDecision {
  /** True when it is safe to abort execution and re-enter planning. */
  readonly safe: boolean;
  /** Why it is (or is not) safe to replan, for status output. */
  readonly reason: string;
}

/**
 * Decide whether it is safe to abort the current plan and re-enter planning on
 * top of the preserved work.
 *
 * Fail-safe rule: replanning is allowed only when we can confirm the main
 * checkout is clean. A preserved execution worktree with staged work is the
 * intended carrier of interrupted work — it is kept and reused, so that staged
 * set is preserved across the replan. Unknown predicate results (null) block
 * replanning with an actionable message because we cannot guarantee the repo
 * would not be corrupted.
 */
export function decideSafeReplan(checks: ReplanSafetyChecks): ReplanSafetyDecision {
  // If we cannot confirm the main checkout is clean, fail closed: do not replan
  // over possible uncommitted main-checkout changes.
  const mainDirty = checks.mainCheckoutIsDirty?.() ?? null;
  if (mainDirty === null) {
    return {
      safe: false,
      reason:
        "cannot confirm the main checkout is clean; refusing to re-plan to avoid mixing uncommitted main-checkout changes with the new plan. Commit or stash them and retry.",
    };
  }
  if (mainDirty === true) {
    return {
      safe: false,
      reason:
        "the main checkout has uncommitted changes; refusing to re-plan to avoid corrupting them. Commit, stash, or clean the main working tree and retry.",
    };
  }

  const worktreeExists = checks.worktreeExists?.() ?? null;
  const worktreeHasWork = checks.worktreeHasWork?.() ?? null;

  // The worktree is optional: if there is none, a fresh execution phase will
  // create one. If one exists but we cannot determine its state, allow it —
  // an existing worktree is the expected carrier of preserved work.
  if (worktreeExists === false) {
    return { safe: true, reason: "no preserved execution worktree; a fresh one will be created for the new plan." };
  }
  if (worktreeExists === true) {
    const hasWork = worktreeHasWork ?? null;
    if (hasWork === false) {
      return { safe: true, reason: "the preserved execution worktree has no staged work to protect; a fresh execution will reuse it." };
    }
    return {
      safe: true,
      reason:
        "the preserved execution worktree will be kept and reused so staged work is carried into the new plan rather than lost.",
    };
  }

  // worktreeExists is null (unknown): the main checkout is clean; treat the
  // unknown as no worktree to preserve and allow the replan.
  return { safe: true, reason: "no execution worktree detected; main checkout is clean; ready to re-plan." };
}
