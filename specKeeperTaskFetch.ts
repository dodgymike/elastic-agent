import specKeeperDefault, { SpecKeeperOptions, SpecKeeperResult } from "./tools/SpecKeeper.js";
import { normalizeTaskId } from "./cli-task-mode.js";

/**
 * Task-mode work-order fetch and normalization.
 *
 * When the CLI runs with --task-id, the runtime fetches an existing Spec
 * Keeper task by its task key or public_id and converts it into a normalized
 * work order before claiming or executing it. This module owns that fetch so
 * the failure modes (not-found, configuration, permission, and network) are
 * explicit and carry actionable diagnostics rather than leaking raw HTTP
 * errors into the agent loop.
 */

export type SpecKeeperTaskFetchErrorKind =
  | "usage"
  | "not-found"
  | "configuration"
  | "permission"
  | "network"
  | "protocol"
  | "unknown";

/** Typed, actionable error raised by fetchSpecKeeperTask. */
export class SpecKeeperTaskFetchError extends Error {
  readonly kind: SpecKeeperTaskFetchErrorKind;
  readonly taskId: string;

  constructor(
    kind: SpecKeeperTaskFetchErrorKind,
    taskId: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SpecKeeperTaskFetchError";
    this.kind = kind;
    this.taskId = taskId;
  }
}

/** Related epic information carried alongside a fetched task. */
export interface TaskWorkOrderEpic {
  key?: string;
  publicId?: string;
  title?: string;
  description?: string;
}

/** Normalized task-mode work order consumed by later claim/execution steps. */
export interface TaskWorkOrder {
  /** Task key or public_id used as the route segment. */
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: string;
  epic: TaskWorkOrderEpic | null;
  /** The raw server task record for later lifecycle updates and proofs. */
  raw: Record<string, unknown>;
}

export interface FetchSpecKeeperTaskOptions
  extends Omit<SpecKeeperOptions, "path" | "method" | "body"> {
  /** Task resource path; defaults to /tasks. */
  tasksPath?: string;
}

/** Extract the best error message without leaking the raw error object. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pull an HTTP status out of the project client's stable failure shape:
 * `Spec Keeper request GET <path> failed (404 Not Found); diagnostics: ...`.
 */
function httpStatusFromError(error: unknown): number | undefined {
  const match = errorMessage(error).match(/\bfailed \((\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

/** Classify a client error into a typed, actionable fetch error. */
function classifyTaskFetchError(taskId: string, error: unknown): SpecKeeperTaskFetchError {
  const message = errorMessage(error);
  const status = httpStatusFromError(error);

  // Authentication/request transport failures are network problems.
  if (
    /authentication request could not be sent/i.test(message) ||
    /could not be sent/i.test(message) ||
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(message)
  ) {
    return new SpecKeeperTaskFetchError(
      "network",
      taskId,
      `Spec Keeper could not be reached while fetching task '${taskId}': ${message}. Check your network connection and the configured SPEC_KEEPER_API_BASE.`,
      error,
    );
  }

  // Configuration and authentication-setup failures happen before or during
  // request preparation. Treat them separately from API permission failures.
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
    return new SpecKeeperTaskFetchError(
      "configuration",
      taskId,
      `Spec Keeper is not configured correctly while fetching task '${taskId}': ${message}`,
      error,
    );
  }

  if (status === 404) {
    return new SpecKeeperTaskFetchError(
      "not-found",
      taskId,
      `Spec Keeper task '${taskId}' was not found in the configured project. Check the task ID and the configured projectSlug.`,
      error,
    );
  }

  if (status === 401 || status === 403) {
    return new SpecKeeperTaskFetchError(
      "permission",
      taskId,
      `Spec Keeper denied access to task '${taskId}' (HTTP ${status}). Check that your Spec Keeper credentials are valid and that the enrolled agent has permission to view this task.`,
      error,
    );
  }

  if (status !== undefined) {
    return new SpecKeeperTaskFetchError(
      "protocol",
      taskId,
      `Spec Keeper returned an error while fetching task '${taskId}': ${message}`,
      error,
    );
  }

  return new SpecKeeperTaskFetchError(
    "unknown",
    taskId,
    `Spec Keeper could not fetch task '${taskId}': ${message}`,
    error,
  );
}

/** Return the first non-empty string for one of the recognized keys. */
function firstDefinedString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Coerce acceptance criteria from a JSON array, a stringified array, or lines. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return asStringArray(parsed);
    } catch {
      // Not JSON; treat as one or more text lines below.
    }
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]\s*)?/, "").trim())
      .filter((line) => line.length > 0);
  }

  return [];
}

/** Coerce a fetch response body into a single task-shaped record. */
function coerceTaskRecord(body: unknown, fallbackId: string): Record<string, unknown> | undefined {
  if (Array.isArray(body)) {
    for (const item of body) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const candidate = item as Record<string, unknown>;
        if (
          candidate.key === fallbackId ||
          candidate.public_id === fallbackId ||
          candidate.id === fallbackId
        ) {
          return candidate;
        }
      }
    }
    if (body.length === 1) {
      const only = body[0];
      return only && typeof only === "object" && !Array.isArray(only)
        ? (only as Record<string, unknown>)
        : undefined;
    }
    return undefined;
  }

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const nested = record.task ?? record.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    if (Array.isArray(record.results)) return coerceTaskRecord(record.results, fallbackId);
    if (Array.isArray(record.tasks)) return coerceTaskRecord(record.tasks, fallbackId);
    return record;
  }

  return undefined;
}

/** True when a record carries at least one task-shaped identifier. */
function hasTaskShape(record: Record<string, unknown>): boolean {
  return ["key", "public_id", "id", "title", "name", "summary"].some((key) => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/** Normalize the related epic carried by a task record. */
function normalizeEpic(task: Record<string, unknown>): TaskWorkOrderEpic | null {
  const nested = task.epic;
  const epicRecord =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : undefined;

  const key =
    firstDefinedString(epicRecord ?? {}, ["key"]) ||
    firstDefinedString(task, ["epic_key", "epicKey", "epic_id", "epicId"]);
  const publicId =
    firstDefinedString(epicRecord ?? {}, ["public_id", "publicId"]) ||
    firstDefinedString(task, ["epic_public_id", "epicPublicId"]);
  const title =
    firstDefinedString(epicRecord ?? {}, ["title"]) ||
    firstDefinedString(task, ["epic_title", "epicTitle"]);
  const description =
    firstDefinedString(epicRecord ?? {}, ["description"]) ||
    firstDefinedString(task, ["epic_description", "epicDescription"]);

  if (!key && !publicId && !title && !description) return null;

  const epic: TaskWorkOrderEpic = {};
  if (key) epic.key = key;
  if (publicId) epic.publicId = publicId;
  if (title) epic.title = title;
  if (description) epic.description = description;
  return epic;
}

/** Convert a task-shaped server record into the normalized work order. */
function normalizeTaskWorkOrder(taskId: string, task: Record<string, unknown>): TaskWorkOrder {
  const id =
    firstDefinedString(task, ["key", "public_id", "id"]) || taskId;
  const title =
    firstDefinedString(task, ["title", "name", "summary"]) || taskId;
  const description = firstDefinedString(task, ["description", "details", "body"]);
  const status = firstDefinedString(task, ["status", "state"]) || "todo";

  const acceptanceValue =
    task.acceptance_criteria ??
    task.acceptanceCriteria ??
    task["acceptance criteria"] ??
    task.criteria ??
    task.definition_of_done;

  return {
    id,
    title,
    description,
    acceptanceCriteria: asStringArray(acceptanceValue),
    status,
    epic: normalizeEpic(task),
    raw: task,
  };
}

/** One-line, secret-safe summary of a fetched work order for logs. */
export function describeTaskWorkOrder(workOrder: TaskWorkOrder): string {
  const criteria =
    workOrder.acceptanceCriteria.length === 0
      ? "no acceptance criteria"
      : workOrder.acceptanceCriteria.length === 1
        ? workOrder.acceptanceCriteria[0]
        : `${workOrder.acceptanceCriteria.length} acceptance criteria`;
  const epic = workOrder.epic
    ? workOrder.epic.key ?? workOrder.epic.publicId ?? workOrder.epic.title ?? "(epic)"
    : "no epic";
  return `task ${workOrder.id} fetched: "${workOrder.title}" (status=${workOrder.status}, ${criteria}, epic=${epic}).`;
}

/**
 * Fetch an existing Spec Keeper task by ID and normalize it into a work order.
 *
 * The request uses the project-scoped GET /tasks/:id route through the
 * standard SpecKeeper client (or an injected client for tests). Failures are
 * classified as usage, not-found, configuration, permission, network,
 * protocol, or unknown errors so callers can produce actionable diagnostics
 * and choose the correct fail-open/fail-closed behavior.
 */
export async function fetchSpecKeeperTask(
  taskId: string,
  options: FetchSpecKeeperTaskOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<TaskWorkOrder> {
  let normalizedId: string;
  try {
    normalizedId = normalizeTaskId(taskId);
  } catch (error) {
    throw new SpecKeeperTaskFetchError("usage", String(taskId), errorMessage(error), error);
  }

  const { tasksPath = "/tasks", ...sendOptions } = options;
  const path = `${tasksPath}/${encodeURIComponent(normalizedId)}`;

  let result: SpecKeeperResult;
  try {
    result = await client({ ...sendOptions, path, method: "GET" });
  } catch (error) {
    throw classifyTaskFetchError(normalizedId, error);
  }

  const task = coerceTaskRecord(result.body, normalizedId);
  if (!task || !hasTaskShape(task)) {
    throw new SpecKeeperTaskFetchError(
      "protocol",
      normalizedId,
      `Spec Keeper returned an unrecognizable task payload for task '${normalizedId}'. The response did not contain a task object with an id or title.`,
    );
  }

  return normalizeTaskWorkOrder(normalizedId, task);
}
