import specKeeperDefault, { SpecKeeperOptions, SpecKeeperResult } from "./tools/SpecKeeper.js";

/**
 * Epic-first Spec Keeper coordination.
 *
 * Before a plan is generated or executed, the runtime always:
 *   1. GET /epics to pull the current epics,
 *   2. select an existing epic matching the work, or create a new one (POST
 *      /epics) when none matches,
 *   3. GET /tasks?epicId=<epic> (or filter by the resolved epic identifier) to
 *      fetch the tasks that belong to that epic,
 *   4. hand the caller the selected epic and its tasks so the caller can either
 *      update the epic with the generated plan, or fold the epic's tasks into
 *      the plan.
 *
 * The flow is deliberately deterministic: matching is by exact key/public_id,
 * then by case-insensitive keyword overlap between the requested title and the
 * epic's title/description. This module never invents a project slug; it reuses
 * the project-scoped contract from tools/SpecKeeper.ts.
 */

export const DEFAULT_SPEC_KEEPER_RESOURCE = {
  epics: "/epics",
  tasks: "/tasks",
} as const;

export interface EpicLike {
  key?: string;
  public_id?: string;
  title?: string;
  description?: string;
  [k: string]: unknown;
}

export interface SyncEpicResult {
  epic: EpicLike;
  /** Tasks belonging to the selected epic (may be empty). */
  tasks: unknown[];
  /** True when a new epic was created rather than reusing an existing one. */
  created: boolean;
  /** Human-readable descriptor of how the epic was selected/created. */
  selection: string;
}

export interface EpicFlowOptions extends Omit<SpecKeeperOptions, "path"> {
  /** The request/title used to match or create the epic. */
  title: string;
  /** Optional description applied when creating a new epic. */
  description?: string;
  /** Optional preferred epic key, matched exactly before title keywords. */
  key?: string;
  /** Optional path of the epic resource; defaults to /epics. */
  epicsPath?: string;
}

/** Extract an epic identifier suitable for filtering tasks by epic. */
export function epicIdentifier(epic: EpicLike): string | undefined {
  return epic.key ?? epic.public_id;
}

/** True when the epic carries the exact key or public_id we asked for. */
export function isExactEpicMatch(epic: EpicLike, requested: string): boolean {
  const requestedId = requested.trim();
  return (epic.key ?? "") === requestedId || (epic.public_id ?? "") === requestedId;
}

/** Normalize an epic identifier (key or public_id) to a URL-safe string. */
function normalizeId(value: string | undefined): string {
  return (value ?? "").toLowerCase().trim();
}

/** Word-boundary keyword overlap score against an epic's title/description. */
export function epicKeywordScore(epic: EpicLike, title: string): number {
  const wanted = title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (wanted.length === 0) return 0;
  const haystack = `${epic.title ?? ""} ${epic.description ?? ""}`.toLowerCase();
  let score = 0;
  for (const word of wanted) {
    if (haystack.includes(word)) score += 1;
  }
  return score;
}

/**
 * Select an existing epic from the supplied list that best matches the given
 * title, preferring exact key/public_id matches then highest keyword overlap.
 * Returns undefined when nothing meaningfully matches so the caller can create
 * a new epic.
 */
export function selectMatchingEpic(epics: EpicLike[], title: string): EpicLike | undefined {
  for (const epic of epics) {
    if (normalizeId(epic.key) === normalizeId(title) || normalizeId(epic.public_id) === normalizeId(title)) {
      return epic;
    }
  }
  let best: EpicLike | undefined;
  let bestScore = 0;
  for (const epic of epics) {
    const score = epicKeywordScore(epic, title);
    if (score > bestScore) {
      best = epic;
      bestScore = score;
    }
  }
  // Require at least two overlapping keywords so we do not bind unrelated epics.
  return bestScore >= 2 ? best : undefined;
}

/** Compute the query string to fetch tasks belonging to an epic. */
export function tasksQueryForEpic(epic: EpicLike): string {
  const id = epicIdentifier(epic);
  return id ? `epicId=${encodeURIComponent(id)}` : "";
}

/** Coerce a response body into an array of epic objects. */
function asEpics(result: SpecKeeperResult): EpicLike[] {
  const body = result.body;
  if (Array.isArray(body)) return body as EpicLike[];
  if (body && typeof body === "object") {
    const list = (body as Record<string, unknown>).epics ?? (body as Record<string, unknown>).results;
    if (Array.isArray(list)) return list as EpicLike[];
  }
  return [];
}

/** Coerce a response body into an array of task objects. */
function asTasks(result: SpecKeeperResult): unknown[] {
  const body = result.body;
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const list = (body as Record<string, unknown>).tasks ?? (body as Record<string, unknown>).results;
    if (Array.isArray(list)) return list;
  }
  return [];
}

/**
 * Sync the epic-first flow deterministically.
 *
 * Always fetches epics, then selects a matching existing epic or creates a new
 * one, then fetches that epic's tasks. Returns the epic, its tasks, and a
 * description of how the epic was resolved. Never throws for a "no matching
 * epic" situation; it creates one instead.
 */
export async function syncSpecKeeperEpic(
  options: EpicFlowOptions,
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SyncEpicResult> {
  const {
    title,
    description,
    key,
    epicsPath = DEFAULT_SPEC_KEEPER_RESOURCE.epics,
    ...sendOptions
  } = options;
  const matchTitle = key?.trim() || title;

  const epicsResult = await client({ ...sendOptions, path: epicsPath, method: "GET" });
  const epics = asEpics(epicsResult);
  const existing = selectMatchingEpic(epics, matchTitle);

  if (existing) {
    const tasksResult = await client({
      ...sendOptions,
      path: `${DEFAULT_SPEC_KEEPER_RESOURCE.tasks}?${tasksQueryForEpic(existing)}`,
      method: "GET",
    });
    return {
      epic: existing,
      tasks: asTasks(tasksResult),
      created: false,
      selection: `reused epic ${existing.key ?? existing.public_id ?? "(no id)"} matching "${matchTitle}"`,
    };
  }

  const createBody: Record<string, unknown> = {
    title,
    description: description ?? `Auto-created by elastic-agent for: ${title}`,
  };
  if (key?.trim()) createBody.key = key.trim();
  const createdResult = await client({
    ...sendOptions,
    path: epicsPath,
    method: "POST",
    body: createBody,
  });
  const created = Array.isArray(createdResult.body)
    ? (createdResult.body as EpicLike[]).find((candidate) => (candidate.title ?? "") === title) ?? createdResult.body[0]
    : ((createdResult.body ?? {}) as EpicLike);

  const createdId = epicIdentifier(created);
  const tasksQuery = createdId ? `?${tasksQueryForEpic(created)}` : "";
  const createdTasks: unknown[] = [];
  if (createdId) {
    const tasksResult = await client({
      ...sendOptions,
      path: `${DEFAULT_SPEC_KEEPER_RESOURCE.tasks}${tasksQuery}`,
      method: "GET",
    });
    createdTasks.push(...asTasks(tasksResult));
  }

  return {
    epic: created,
    tasks: createdTasks,
    created: true,
    selection: `created epic "${title}"`,
  };
}

/**
 * Persist a generated/updated plan onto the selected epic (PUT /epics/:id),
 * returning the updated epic. This makes the epic the durable home for the
 * plan so later runs can recover it before regenerating.
 */
export async function updateEpicWithPlan(
  epic: EpicLike,
  plan: string,
  options: EpicFlowOptions,
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<EpicLike> {
  const id = epicIdentifier(epic);
  if (!id) return epic;
  const { title, description, key: _key, epicsPath = DEFAULT_SPEC_KEEPER_RESOURCE.epics, ...sendOptions } = options;
  const updated = await client({
    ...sendOptions,
    path: `${epicsPath}/${encodeURIComponent(id)}`,
    method: "PUT",
    body: {
      title,
      description: description ?? epic.description ?? `Auto-created by elastic-agent for: ${title}`,
      plan,
    },
  });
  return (updated.body ?? epic) as EpicLike;
}

/**
 * Task-level Spec Keeper coordination.
 *
 * The runtime creates or reuses one run task under the resolved epic for every
 * execution (including the no-plan single-step path) and updates that task's
 * status across the in_progress -> done/blocked lifecycle. It also creates or
 * reuses one task per plan step so step-level status can be recorded as the
 * plan executes and is reviewed.
 */

export interface TaskLike {
  key?: string;
  public_id?: string;
  title?: string;
  description?: string;
  epic_key?: string;
  epicId?: string;
  status?: string;
  [k: string]: unknown;
}

export interface SyncTaskResult {
  task: TaskLike;
  created: boolean;
  selection: string;
}

export interface TaskSyncOptions extends Omit<SpecKeeperOptions, "path"> {
  /** Title used to match an existing task or create a new one. */
  title: string;
  /** Optional description applied when creating a new task. */
  description?: string;
  /** Optional stable task key, matched exactly before title keywords. */
  key?: string;
  /** Prefix used to derive a stable key when no explicit key is supplied. */
  keyPrefix?: string;
  /** Epic identifier new tasks are attached to. */
  epicId?: string;
  /** Status applied when creating a new task. */
  defaultStatus?: string;
  /** Optional path of the task resource; defaults to /tasks. */
  tasksPath?: string;
}

export interface TaskUpdateOptions extends Omit<SpecKeeperOptions, "path"> {
  /** Optional path of the task resource; defaults to /tasks. */
  tasksPath?: string;
}

export interface PlanStepSyncOptions extends Omit<SpecKeeperOptions, "path"> {
  keyPrefix?: string;
  epicId?: string;
  defaultStatus?: string;
  tasksPath?: string;
}

export interface EpicUpdateOptions extends Omit<SpecKeeperOptions, "path"> {
  epicsPath?: string;
}

/** Extract a task identifier suitable for PATCH routes. */
export function taskIdentifier(task: TaskLike): string | undefined {
  return task.key ?? task.public_id;
}

/** Derive a deterministic, URL-safe task key from a title. */
export function generateTaskKey(keyPrefix: string | undefined, title: string): string {
  const prefix = (keyPrefix ?? "TASK-").trim();
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${prefix}${slug || "task"}`;
}

/**
 * Select an existing task from a list by exact key/public_id, then exact
 * case-insensitive title, then keyword overlap against the task title and
 * description. Returns undefined when nothing meaningfully matches.
 */
export function selectMatchingTask(
  tasks: TaskLike[],
  requestedKey: string | undefined,
  title: string,
): TaskLike | undefined {
  const wantedKey = (requestedKey ?? "").trim();
  if (wantedKey) {
    for (const task of tasks) {
      if ((task.key ?? "") === wantedKey || (task.public_id ?? "") === wantedKey) return task;
    }
  }

  const wantedTitle = title.trim().toLowerCase();
  if (wantedTitle) {
    for (const task of tasks) {
      if ((task.title ?? "").trim().toLowerCase() === wantedTitle) return task;
    }
  }

  let best: TaskLike | undefined;
  let bestScore = 0;
  for (const task of tasks) {
    const score = epicKeywordScore(task as unknown as EpicLike, title);
    if (score > bestScore) {
      best = task;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : undefined;
}

/**
 * Fetch-or-create one task under an epic. When the task already exists it is
 * reused without mutating it; callers update status through
 * updateSpecKeeperTask/updateTaskStatus.
 */
export async function syncSpecKeeperTask(
  options: TaskSyncOptions,
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SyncTaskResult> {
  const {
    title,
    description,
    key,
    keyPrefix,
    epicId,
    defaultStatus = "todo",
    tasksPath = DEFAULT_SPEC_KEEPER_RESOURCE.tasks,
    ...sendOptions
  } = options;

  const query = epicId ? `?epicId=${encodeURIComponent(epicId)}` : "";
  const tasksResult = await client({ ...sendOptions, path: `${tasksPath}${query}`, method: "GET" });
  const tasks = asTasks(tasksResult) as TaskLike[];
  const existing = selectMatchingTask(tasks, key, title);
  if (existing) {
    return {
      task: existing,
      created: false,
      selection: `reused task ${taskIdentifier(existing) ?? "(no id)"} matching "${title}"`,
    };
  }

  const taskKey = key?.trim() || generateTaskKey(keyPrefix, title);
  const createBody: Record<string, unknown> = {
    key: taskKey,
    title,
    description: description ?? `Auto-created by elastic-agent for: ${title}`,
    status: defaultStatus,
  };
  if (epicId) createBody.epic_key = epicId;

  const createdResult = await client({ ...sendOptions, path: tasksPath, method: "POST", body: createBody });
  const created = Array.isArray(createdResult.body)
    ? (createdResult.body as TaskLike[]).find((candidate) => (candidate.title ?? "") === title) ?? createdResult.body[0]
    : ((createdResult.body ?? {}) as TaskLike);

  return {
    task: created,
    created: true,
    selection: `created task "${title}"`,
  };
}

/** Patch one task (PATCH /tasks/:id) and return the server's task body. */
export async function updateSpecKeeperTask(
  task: TaskLike,
  updates: Record<string, unknown>,
  options: TaskUpdateOptions,
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<TaskLike> {
  const id = taskIdentifier(task);
  if (!id) return task;
  const { tasksPath = DEFAULT_SPEC_KEEPER_RESOURCE.tasks, ...sendOptions } = options;
  const updated = await client({
    ...sendOptions,
    path: `${tasksPath}/${encodeURIComponent(id)}`,
    method: "PATCH",
    body: updates,
  });
  return (updated.body ?? task) as TaskLike;
}

/** Update a task status with an optional human-readable note. */
export async function updateTaskStatus(
  task: TaskLike,
  status: string,
  statusNote: string | undefined,
  options: TaskUpdateOptions,
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<TaskLike> {
  const updates: Record<string, unknown> = { status };
  if (statusNote?.trim()) updates.status_note = statusNote.trim();
  return updateSpecKeeperTask(task, updates, options, client);
}

/** Patch an epic status (PATCH /epics/:id). */
export async function updateEpicStatus(
  epic: EpicLike,
  status: string,
  options: EpicUpdateOptions,
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<EpicLike> {
  const id = epicIdentifier(epic);
  if (!id) return epic;
  const { epicsPath = DEFAULT_SPEC_KEEPER_RESOURCE.epics, ...sendOptions } = options;
  const updated = await client({
    ...sendOptions,
    path: `${epicsPath}/${encodeURIComponent(id)}`,
    method: "PATCH",
    body: { status },
  });
  return (updated.body ?? epic) as EpicLike;
}

/**
 * Create or reuse one task per plan step under the epic. The first step is
 * created/updated as in_progress and the rest as todo so the execution phase
 * can flip each step task as it runs.
 */
export async function syncPlanStepTasks(
  epic: EpicLike,
  steps: string[],
  options: PlanStepSyncOptions,
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<{ tasks: TaskLike[]; createdCount: number }> {
  const epicId = epicIdentifier(epic);
  const tasks: TaskLike[] = [];
  let createdCount = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const synced = await syncSpecKeeperTask(
      {
        ...options,
        title: step,
        description: `Plan step ${index + 1} of ${steps.length} under epic ${epicId ?? "(no id)"}: ${step}`,
        epicId,
        defaultStatus: index === 0 ? "in_progress" : "todo",
      },
      client,
    );
    tasks.push(synced.task);
    if (synced.created) createdCount += 1;
  }

  return { tasks, createdCount };
}
