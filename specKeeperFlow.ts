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
    epicsPath = DEFAULT_SPEC_KEEPER_RESOURCE.epics,
    ...sendOptions
  } = options;

  const epicsResult = await client({ ...sendOptions, path: epicsPath, method: "GET" });
  const epics = asEpics(epicsResult);
  const existing = selectMatchingEpic(epics, title);

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
      selection: `reused epic ${existing.key ?? existing.public_id ?? "(no id)"} matching "${title}"`,
    };
  }

  const createdResult = await client({
    ...sendOptions,
    path: epicsPath,
    method: "POST",
    body: { title, description: description ?? `Auto-created by elastic-agent for: ${title}` },
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
  const { title, description, epicsPath = DEFAULT_SPEC_KEEPER_RESOURCE.epics, ...sendOptions } = options;
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
