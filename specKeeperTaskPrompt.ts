import type { TaskWorkOrder } from "./specKeeperTaskFetch.js";

/**
 * Task-mode work-order seeding.
 *
 * After task mode fetches and claims an existing Spec Keeper task, the runtime
 * converts the normalized work order into an initial agent prompt. This module
 * owns that conversion so the prompt always includes the task id and the
 * Spec Keeper lifecycle requirements (notes, status changes, and proof
 * artifacts) without mixing prompt-mode history rendering into the work order.
 */

export interface TaskWorkOrderPromptOptions {
  /** Optional commit instruction appended to the work order. */
  commitInstruction?: string;
  /** Optional tools-available block appended to the work order. */
  toolsAvailable?: string;
}

/** Render acceptance criteria as a deterministic numbered list. */
export function formatAcceptanceCriteria(criteria: string[]): string {
  if (!Array.isArray(criteria) || criteria.length === 0) return "(no acceptance criteria)";
  return criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
}

/** Render the related epic as one human-readable, secret-safe line. */
export function formatTaskEpic(epic: TaskWorkOrder["epic"]): string {
  if (!epic) return "(no epic)";
  const id = epic.key ?? epic.publicId ?? "(no epic id)";
  const title = epic.title ? ` — ${epic.title}` : "";
  const description = epic.description ? `: ${epic.description}` : "";
  return `${id}${title}${description}`;
}

/**
 * Build a concise, plain-language summary of a task work order. This is the
 * task-mode equivalent of the raw command-line prompt: it feeds the
 * planning-necessity classifier and prompt history without carrying the full
 * lifecycle instructions from buildTaskWorkOrderPrompt.
 */
export function buildTaskWorkOrderBrief(workOrder: TaskWorkOrder): string {
  const lines = [`Spec Keeper task ${workOrder.id}: ${workOrder.title}`];
  if (workOrder.description.trim()) lines.push(workOrder.description.trim());
  lines.push(`Acceptance criteria:\n${formatAcceptanceCriteria(workOrder.acceptanceCriteria)}`);
  if (workOrder.epic) lines.push(`Epic: ${formatTaskEpic(workOrder.epic)}`);
  return lines.join("\n");
}

/**
 * Convert a fetched/claimed task work order into the initial agent prompt for
 * task mode.
 *
 * The prompt includes the task id and instructs the agent to keep Spec Keeper
 * updated with notes, status changes, and proof artifacts throughout the task.
 * It is deliberately workflow-agnostic so the existing plan-then-execute or
 * single-step execution flow can consume it unchanged.
 */
export function buildTaskWorkOrderPrompt(
  workOrder: TaskWorkOrder,
  options: TaskWorkOrderPromptOptions = {},
): string {
  const taskId = workOrder.id || "(unknown task id)";
  const encodedTaskId = encodeURIComponent(taskId);
  const sections = [
    "SPEC KEEPER TASK MODE — WORK ORDER",
    "",
    `Task ID: ${taskId}`,
    `Title: ${workOrder.title}`,
    `Status: ${workOrder.status}`,
    `Epic: ${formatTaskEpic(workOrder.epic)}`,
    "",
    "Description:",
    workOrder.description.trim() || "(no description)",
    "",
    "Acceptance criteria:",
    formatAcceptanceCriteria(workOrder.acceptanceCriteria),
    "",
    "Spec Keeper lifecycle requirements:",
    "You are executing the Spec Keeper task above. Keep Spec Keeper updated throughout the task using the SpecKeeper tool:",
    `1. Notes: POST /tasks/${encodedTaskId}/notes with concise progress notes at meaningful points (plan produced, execution started, checks run, review completed, task completed, or task failed/blocked).`,
    `2. Status: PATCH /tasks/${encodedTaskId} with a status such as in_progress, done, or blocked as the work advances. The task is already claimed; do not claim it again.`,
    "3. Proofs: attach proof artifacts (commit hashes, test output, file paths) to notes or the task's evidence/proof fields when the SpecKeeper schema supports them.",
    `Use the exact task ID ${taskId} in every SpecKeeper update. Keep updates frequent enough to preserve a durable handoff, and never write SpecKeeper credentials, enrollment recipes, or secret-store content to the repository, docs, or handoffs.`,
    "",
    "Plan when the work is complex, then execute the plan. For simple, unambiguous work, execute directly. Verify your work before reporting completion.",
  ];

  if (options.commitInstruction?.trim()) {
    sections.push("", `Commit instruction for this step: ${options.commitInstruction.trim()}`);
  }
  if (options.toolsAvailable?.trim()) {
    sections.push("", `Tools available:\n${options.toolsAvailable.trim()}`);
  }

  return sections.join("\n");
}
