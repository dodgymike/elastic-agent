/**
 * Task-mode argument rules shared by the CLI entrypoint and its tests.
 *
 * The runtime has two mutually exclusive ways to start work:
 *   1. prompt mode: `elastic-agent <prompt>` (the original plan-then-execute
 *      flow), and
 *   2. task mode: `elastic-agent --task-id <task-id>` (claim and execute an
 *      existing Spec Keeper task).
 *
 * Loop mode (`--loop`) is a mode *modifier*, not a third exclusive mode: it
 * may be combined with either prompt mode or task mode. When `--loop` is set,
 * the runtime keeps running and watches the Agent Bus between execution steps
 * so incoming coordination messages can be classified and either handled
 * (relevant messages trigger a re-plan) or queued for later. See loop-mode.ts
 * for the classification rule and main.ts for the poll loop.
 *
 * Mode rules:
 *   - prompt mode and task mode are mutually exclusive (at least one required).
 *   - --loop is additive: it may be combined with either mode and never selects
 *     a mode by itself.
 *
 * This module owns the argument classification, the task-ID well-formedness
 * rule, and the loop flag, so the rules can be unit-tested without booting the
 * agent loop.
 */

export type CliRunMode = "prompt" | "task";

export interface ResolvedCliRunMode {
  readonly mode: CliRunMode;
  /** Normalized task ID (task key or public_id) when mode is "task". */
  readonly taskId?: string;
  /** Original prompt text when mode is "prompt". */
  readonly prompt?: string;
  /** Whether loop mode is enabled (--loop). Additive to either base mode. */
  readonly loop: boolean;
}

/**
 * Spec Keeper task identifiers are used as route segments (for example
 * `TASK-1`, `EA-brand-new-task`, or a UUID public_id). Accept the same
 * URL-safe shape used elsewhere in the project and reject anything that would
 * need escaping beyond a path segment.
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Normalize and validate a user-supplied --task-id value.
 * Returns the trimmed identifier or throws a clear usage error.
 */
export function normalizeTaskId(value: string | undefined): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "Usage: --task-id requires a non-empty Spec Keeper task ID (task key or public_id).",
    );
  }

  const taskId = value.trim();
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(
      `Usage: --task-id '${taskId}' is malformed. Use a URL-safe task key or public_id containing letters, numbers, '.', '_', or '-' with no spaces or slashes.`,
    );
  }
  return taskId;
}

/**
 * Resolve the CLI run mode from the parsed positional prompt and --task-id.
 * The two modes are mutually exclusive and at least one must be supplied.
 * `loop` is an additive modifier: it never selects a mode by itself and may be
 * combined with either prompt mode or task mode.
 */
export function resolveCliRunMode(
  taskId: string | undefined,
  prompt: string | undefined,
  loop = false,
): ResolvedCliRunMode {
  const hasPrompt = typeof prompt === "string" && prompt.trim().length > 0;
  const hasTaskId = taskId !== undefined;

  if (hasTaskId) {
    const normalizedTaskId = normalizeTaskId(taskId);
    if (hasPrompt) {
      throw new Error(
        "Usage: <prompt> and --task-id cannot be used together. Use either prompt mode or task mode, not both.",
      );
    }
    return { mode: "task", taskId: normalizedTaskId, loop };
  }

  if (!hasPrompt) {
    throw new Error(
      "Usage: provide <prompt> for prompt mode or --task-id <task-id> for task mode. No prompt and no --task-id were supplied.",
    );
  }

  return { mode: "prompt", prompt: prompt as string, loop };
}
