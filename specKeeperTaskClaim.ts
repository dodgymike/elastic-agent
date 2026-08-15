import specKeeperDefault, { SpecKeeperOptions, SpecKeeperResult } from "./tools/SpecKeeper.js";
import { normalizeTaskId } from "./cli-task-mode.js";
import { TaskWorkOrder } from "./specKeeperTaskFetch.js";

/**
 * Task-mode claim coordination.
 *
 * After task mode fetches and normalizes an existing Spec Keeper task, the
 * runtime must claim it before starting execution so two agents cannot pick up
 * the same task. This module owns that transition:
 *
 *   1. check the fetched task's current status and fail closed when it is
 *      already claimed or otherwise not claimable, unless the caller supplied
 *      the safe explicit force-claim override;
 *   2. PATCH /tasks/:id to transition the task into the in-progress/claimed
 *      state;
 *   3. POST /tasks/:id/notes so the claim result is durable on the task.
 *
 * Server-side conflicts are still authoritative: a 409/423 from Spec Keeper is
 * never overridden by forceClaim. The override only skips the local status
 * precheck when a caller explicitly wants to reclaim a locally-known state.
 */

export type SpecKeeperTaskClaimErrorKind =
  | "usage"
  | "already-claimed"
  | "not-claimable"
  | "claimability-unknown"
  | "conflict"
  | "not-found"
  | "permission"
  | "configuration"
  | "network"
  | "protocol"
  | "unknown";

/** Typed, actionable error raised by claimSpecKeeperTask. */
export class SpecKeeperTaskClaimError extends Error {
  readonly kind: SpecKeeperTaskClaimErrorKind;
  readonly taskId: string;

  constructor(
    kind: SpecKeeperTaskClaimErrorKind,
    taskId: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SpecKeeperTaskClaimError";
    this.kind = kind;
    this.taskId = taskId;
  }
}

/** Status used to transition a task into the claimed/in-progress state. */
export const DEFAULT_TASK_CLAIM_STATUS = "in_progress";

/** Claimability of a fetched task based on its current status. */
export type TaskClaimState =
  | "claimable"
  | "already-claimed"
  | "not-claimable"
  | "claimability-unknown";

const ALREADY_CLAIMED_STATUSES = new Set([
  "in_progress",
  "claimed",
  "assigned",
  "in_review",
  "review",
  "under_review",
  "pending_review",
]);

const NOT_CLAIMABLE_STATUSES = new Set([
  "done",
  "completed",
  "complete",
  "cancelled",
  "canceled",
  "closed",
  "archived",
  "blocked",
  "on_hold",
  "deferred",
]);

const CLAIMABLE_STATUSES = new Set([
  "todo",
  "open",
  "backlog",
  "ready",
  "new",
  "unassigned",
  "unclaimed",
  "not_started",
  "unstarted",
]);

/** Normalize a Spec Keeper status for comparison without mutating the original. */
function normalizeTaskStatus(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Classify a task status into the claimability decision used before PATCH. */
export function taskClaimState(status: string): TaskClaimState {
  const normalized = normalizeTaskStatus(status);
  if (CLAIMABLE_STATUSES.has(normalized)) return "claimable";
  if (ALREADY_CLAIMED_STATUSES.has(normalized)) return "already-claimed";
  if (NOT_CLAIMABLE_STATUSES.has(normalized)) return "not-claimable";
  return "claimability-unknown";
}

export interface SpecKeeperTaskNoteResult {
  /** True when POST /tasks/:id/notes succeeded. */
  recorded: boolean;
  /** The project-scoped note route that was attempted. */
  path: string;
  /** Redacted diagnostic when recording failed; undefined on success. */
  error?: string;
}

/** Result of a successful claim transition. */
export interface ClaimedSpecKeeperTask {
  id: string;
  /** Status reported by the server after the claim, or the requested status. */
  status: string;
  /** True when the local claimability precheck was bypassed with forceClaim. */
  forced: boolean;
  /** The server's task record after claiming (or the normalized fallback). */
  task: Record<string, unknown>;
  /** Outcome of recording the claim result as a Spec Keeper note. */
  note: SpecKeeperTaskNoteResult;
}

export interface ClaimSpecKeeperTaskOptions
  extends Omit<SpecKeeperOptions, "path" | "method" | "body"> {
  /** Task resource path; defaults to /tasks. */
  tasksPath?: string;
  /** Status applied by the claim PATCH; defaults to in_progress. */
  claimStatus?: string;
  /** Human-readable claim note sent as status_note and as a task note. */
  claimNote?: string;
  /** Safe explicit override that skips only the local claimability precheck. */
  forceClaim?: boolean;
  /** JSON field used for the note content; defaults to content. */
  noteContentField?: string;
}

export interface AddSpecKeeperTaskNoteOptions
  extends Omit<SpecKeeperOptions, "path" | "method" | "body"> {
  tasksPath?: string;
  noteContentField?: string;
}

/** Extract the best error message without leaking the raw error object. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pull an HTTP status out of the project client's stable failure shape. */
function httpStatusFromError(error: unknown): number | undefined {
  const match = errorMessage(error).match(/\bfailed \((\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

/** Return the first non-empty string for one of the recognized keys. */
function firstDefinedString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Coerce a PATCH response body into a single task-shaped record. */
function coerceClaimResponseTask(
  body: unknown,
  taskId: string,
): Record<string, unknown> | undefined {
  if (Array.isArray(body)) {
    for (const item of body) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const candidate = item as Record<string, unknown>;
        if (
          candidate.key === taskId ||
          candidate.public_id === taskId ||
          candidate.id === taskId
        ) {
          return candidate;
        }
      }
    }
    const first = body[0];
    return first && typeof first === "object" && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : undefined;
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const nested = record.task ?? record.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    return record;
  }

  return undefined;
}

/** Classify a client error into a typed, actionable claim error. */
function classifyTaskClaimError(taskId: string, error: unknown): SpecKeeperTaskClaimError {
  const message = errorMessage(error);
  const status = httpStatusFromError(error);

  if (
    /authentication request could not be sent/i.test(message) ||
    /could not be sent/i.test(message) ||
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(message)
  ) {
    return new SpecKeeperTaskClaimError(
      "network",
      taskId,
      `Spec Keeper could not be reached while claiming task '${taskId}': ${message}. Check your network connection and the configured SPEC_KEEPER_API_BASE.`,
      error,
    );
  }

  if (
    /authentication failed/i.test(message) ||
    /credential store/i.test(message) ||
    /Spec Keeper needs/i.test(message) ||
    /projectSlug/i.test(message) ||
    /apiBase/i.test(message) ||
    /User-Agent/i.test(message) ||
    /path must/i.test(message) ||
    /control characters/i.test(message) ||
    /Unsupported Spec Keeper project resource/i.test(message)
  ) {
    return new SpecKeeperTaskClaimError(
      "configuration",
      taskId,
      `Spec Keeper is not configured correctly while claiming task '${taskId}': ${message}`,
      error,
    );
  }

  if (status === 404) {
    return new SpecKeeperTaskClaimError(
      "not-found",
      taskId,
      `Spec Keeper task '${taskId}' could not be claimed because it was not found in the configured project. Check the task ID and the configured projectSlug.`,
      error,
    );
  }

  if (status === 401 || status === 403) {
    return new SpecKeeperTaskClaimError(
      "permission",
      taskId,
      `Spec Keeper denied the claim for task '${taskId}' (HTTP ${status}). Check that your Spec Keeper credentials are valid and that the enrolled agent has permission to update this task.`,
      error,
    );
  }

  if (status === 409) {
    return new SpecKeeperTaskClaimError(
      "conflict",
      taskId,
      `Spec Keeper task '${taskId}' could not be claimed because it is already claimed or in a conflicting state (HTTP 409). Stop, check the task owner, and coordinate before retrying.`,
      error,
    );
  }

  if (status === 423) {
    return new SpecKeeperTaskClaimError(
      "not-claimable",
      taskId,
      `Spec Keeper task '${taskId}' is locked and not claimable (HTTP 423). Check the task state and blocker before retrying.`,
      error,
    );
  }

  if (status !== undefined) {
    return new SpecKeeperTaskClaimError(
      "protocol",
      taskId,
      `Spec Keeper returned an error while claiming task '${taskId}': ${message}`,
      error,
    );
  }

  return new SpecKeeperTaskClaimError(
    "unknown",
    taskId,
    `Spec Keeper could not claim task '${taskId}': ${message}`,
    error,
  );
}

/** Build the claim PATCH body without logging request bodies. */
function claimPatchBody(claimStatus: string, claimNote: string): Record<string, unknown> {
  return { status: claimStatus, status_note: claimNote };
}

/**
 * Post one note to a task (POST /tasks/:id/notes).
 *
 * The note content field is configurable so callers can match the deployed
 * Spec Keeper note schema without duplicating the route logic. Failures are
 * returned to the caller as exceptions; claimSpecKeeperTask downgrades a note
 * failure to a visible, non-fatal warning because the claim transition has
 * already happened at that point.
 */
export async function addSpecKeeperTaskNote(
  taskId: string,
  note: string,
  options: AddSpecKeeperTaskNoteOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SpecKeeperResult> {
  const {
    tasksPath = "/tasks",
    noteContentField = "content",
    ...sendOptions
  } = options;
  const path = `${tasksPath}/${encodeURIComponent(taskId)}/notes`;
  return client({
    ...sendOptions,
    path,
    method: "POST",
    body: { [noteContentField]: note },
  });
}

/** Record the claim result as a note without turning note failure into claim failure. */
async function recordClaimNote(
  taskId: string,
  note: string,
  tasksPath: string,
  noteContentField: string,
  sendOptions: Omit<ClaimSpecKeeperTaskOptions, "tasksPath" | "claimStatus" | "claimNote" | "forceClaim" | "noteContentField">,
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult>,
): Promise<SpecKeeperTaskNoteResult> {
  const path = `${tasksPath}/${encodeURIComponent(taskId)}/notes`;
  try {
    await addSpecKeeperTaskNote(taskId, note, { ...sendOptions, tasksPath, noteContentField }, client);
    return { recorded: true, path };
  } catch (error) {
    return { recorded: false, path, error: errorMessage(error) };
  }
}

/** One-line, secret-safe summary of a successful claim for logs. */
export function describeClaimedSpecKeeperTask(result: ClaimedSpecKeeperTask): string {
  const note = result.note.recorded
    ? "claim note recorded"
    : `claim note NOT recorded (${result.note.error ?? "unknown error"})`;
  return `task ${result.id} claimed (status=${result.status}${result.forced ? ", forced" : ""}, ${note}).`;
}

/**
 * Claim an existing Spec Keeper task before execution begins.
 *
 * The task is transitioned with PATCH /tasks/:id and the claim result is
 * recorded with POST /tasks/:id/notes. Locally-known already-claimed and
 * not-claimable states fail closed unless `forceClaim` is explicitly set;
 * server-side 409/423 responses always fail closed.
 */
export async function claimSpecKeeperTask(
  workOrder: TaskWorkOrder,
  options: ClaimSpecKeeperTaskOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<ClaimedSpecKeeperTask> {
  const rawTaskId = String(workOrder.id ?? "").trim();
  if (!rawTaskId) {
    throw new SpecKeeperTaskClaimError(
      "usage",
      "",
      "Usage: cannot claim a Spec Keeper task without a task id. The work order must contain a task key or public_id.",
    );
  }

  let taskId: string;
  try {
    taskId = normalizeTaskId(rawTaskId);
  } catch (error) {
    throw new SpecKeeperTaskClaimError("usage", rawTaskId, errorMessage(error), error);
  }

  const {
    tasksPath = "/tasks",
    claimStatus = DEFAULT_TASK_CLAIM_STATUS,
    claimNote = `Claimed task '${taskId}' by elastic-agent task mode (${workOrder.status || "unknown"} -> ${claimStatus}).`,
    forceClaim = false,
    noteContentField = "content",
    ...sendOptions
  } = options;

  const currentStatus = workOrder.status ?? "";
  if (!forceClaim) {
    const state = taskClaimState(currentStatus);
    if (state === "already-claimed") {
      throw new SpecKeeperTaskClaimError(
        "already-claimed",
        taskId,
        `Spec Keeper task '${taskId}' is already claimed (status=${currentStatus || "(none)"}). Refusing to claim it without a safe explicit override. Pass forceClaim only after confirming this agent should take over the task.`,
      );
    }
    if (state === "not-claimable") {
      throw new SpecKeeperTaskClaimError(
        "not-claimable",
        taskId,
        `Spec Keeper task '${taskId}' is not claimable (status=${currentStatus}). Refusing to claim it without a safe explicit override. Pass forceClaim only after confirming the task should be picked up.`,
      );
    }
    if (state === "claimability-unknown") {
      throw new SpecKeeperTaskClaimError(
        "claimability-unknown",
        taskId,
        `Spec Keeper task '${taskId}' has unrecognized status '${currentStatus}'. Refusing to claim it without a safe explicit override. Pass forceClaim to claim it anyway.`,
      );
    }
  }

  const claimPath = `${tasksPath}/${encodeURIComponent(taskId)}`;
  let claimResult: SpecKeeperResult;
  try {
    claimResult = await client({
      ...sendOptions,
      path: claimPath,
      method: "PATCH",
      body: claimPatchBody(claimStatus, claimNote),
    });
  } catch (error) {
    throw classifyTaskClaimError(taskId, error);
  }

  const serverTask = coerceClaimResponseTask(claimResult.body, taskId);
  const updatedTask: Record<string, unknown> = {
    ...(serverTask ?? workOrder.raw),
    status: firstDefinedString(serverTask ?? {}, ["status", "state"]) || claimStatus,
  };

  const note = await recordClaimNote(
    taskId,
    claimNote,
    tasksPath,
    noteContentField,
    sendOptions,
    client,
  );

  return {
    id: taskId,
    status: firstDefinedString(updatedTask, ["status", "state"]) || claimStatus,
    forced: forceClaim,
    task: updatedTask,
    note,
  };
}
