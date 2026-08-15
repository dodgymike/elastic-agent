import specKeeperDefault, { SpecKeeperOptions, SpecKeeperResult } from "./tools/SpecKeeper.js";
import { normalizeTaskId } from "./cli-task-mode.js";
import { addSpecKeeperTaskNote } from "./specKeeperTaskClaim.js";

/**
 * Spec Keeper task-mode lifecycle helpers.
 *
 * After task mode fetches and claims an existing Spec Keeper task, the runtime
 * keeps that task updated as the work advances. This module owns the three
 * update primitives used by the execution flow:
 *
 *   1. posting progress notes   (POST /tasks/:id/notes),
 *   2. updating task status     (PATCH /tasks/:id),
 *   3. attaching proof artifacts (PATCH /tasks/:id with a configurable proof
 *      field, falling back to a proof note when the proof field is unsupported).
 *
 * Note and status helpers throw on failure so callers can surface the failure
 * through the standard best-effort Spec Keeper sync diagnostic. The proof
 * helper returns a structured result instead, because proof fields vary by
 * deployed Spec Keeper schema and a note fallback should not be mistaken for a
 * failed update.
 */

export type SpecKeeperTaskProof = string | Record<string, unknown>;

export interface SpecKeeperTaskLifecycleOptions
  extends Omit<SpecKeeperOptions, "path" | "method" | "body"> {
  /** Task resource path; defaults to /tasks. */
  tasksPath?: string;
  /** JSON field used for note content; defaults to content. */
  noteContentField?: string;
  /** JSON field used for the proof payload on a task PATCH; defaults to proof. */
  proofField?: string;
}

export interface SpecKeeperTaskProofResult {
  /** True when the proof was recorded through either the field or note path. */
  attached: boolean;
  /** Which mechanism recorded the proof. */
  method: "field" | "note" | "none";
  /** Route used when the proof was recorded (or last attempted on failure). */
  path?: string;
  /** Human-readable failure diagnostic when attached is false. */
  error?: string;
  /** Optional detail for a successful field or note attachment. */
  detail?: string;
}

/** Extract the best error message without leaking the raw error object. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Post one progress note to a task (POST /tasks/:id/notes).
 *
 * The note is validated before a request is sent. Client and transport
 * failures propagate to the caller so the execution flow can record a visible
 * diagnostic and decide whether the update failure is fatal.
 */
export async function postSpecKeeperTaskNote(
  taskId: string,
  note: string,
  options: SpecKeeperTaskLifecycleOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SpecKeeperResult> {
  const normalizedId = normalizeTaskId(taskId);
  if (typeof note !== "string" || !note.trim()) {
    throw new Error("Spec Keeper task notes must be non-empty strings.");
  }

  const {
    tasksPath = "/tasks",
    noteContentField = "content",
    proofField: _proofField,
    ...sendOptions
  } = options;

  return addSpecKeeperTaskNote(
    normalizedId,
    note.trim(),
    { ...sendOptions, tasksPath, noteContentField },
    client,
  );
}

/**
 * Update a task status (PATCH /tasks/:id) with an optional status note.
 *
 * The task id and status are validated before a request is sent. Failures
 * propagate to the caller so the execution flow can surface them.
 */
export async function updateSpecKeeperTaskStatus(
  taskId: string,
  status: string,
  statusNote?: string,
  options: SpecKeeperTaskLifecycleOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SpecKeeperResult> {
  const normalizedId = normalizeTaskId(taskId);
  if (typeof status !== "string" || !status.trim()) {
    throw new Error("Spec Keeper task status must be a non-empty string.");
  }

  const {
    tasksPath = "/tasks",
    noteContentField: _noteContentField,
    proofField: _proofField,
    ...sendOptions
  } = options;

  const updates: Record<string, unknown> = { status: status.trim() };
  if (typeof statusNote === "string" && statusNote.trim()) {
    updates.status_note = statusNote.trim();
  }

  return client({
    ...sendOptions,
    path: `${tasksPath}/${encodeURIComponent(normalizedId)}`,
    method: "PATCH",
    body: updates,
  });
}

/** Return a compact, JSON-stable representation of a proof payload. */
function stringifyProof(proof: SpecKeeperTaskProof): string {
  return typeof proof === "string" ? proof : JSON.stringify(proof);
}

/** True when a proof payload carries some useful content. */
function hasProofContent(proof: SpecKeeperTaskProof): boolean {
  if (typeof proof === "string") return proof.trim().length > 0;
  return (
    !!proof &&
    !Array.isArray(proof) &&
    Object.keys(proof).length > 0
  );
}

/**
 * Attach a proof artifact to a task.
 *
 * First attempts PATCH /tasks/:id with the configured proof field (for example
 * `proof`). When that field is not supported by the deployed Spec Keeper
 * schema, it falls back to POST /tasks/:id/notes with the proof embedded in the
 * note content. The result reports which mechanism recorded the proof and any
 * diagnostic, so callers can keep the update visible without failing the run.
 */
export async function attachSpecKeeperTaskProof(
  taskId: string,
  proof: SpecKeeperTaskProof,
  options: SpecKeeperTaskLifecycleOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SpecKeeperTaskProofResult> {
  let normalizedId: string;
  try {
    normalizedId = normalizeTaskId(taskId);
  } catch (error) {
    return { attached: false, method: "none", error: errorMessage(error) };
  }

  if (!hasProofContent(proof)) {
    return {
      attached: false,
      method: "none",
      error:
        "Spec Keeper task proof must be a non-empty string or a non-empty object.",
    };
  }

  const {
    tasksPath = "/tasks",
    noteContentField = "content",
    proofField = "proof",
    ...sendOptions
  } = options;

  const taskPath = `${tasksPath}/${encodeURIComponent(normalizedId)}`;

  try {
    await client({
      ...sendOptions,
      path: taskPath,
      method: "PATCH",
      body: { [proofField]: proof },
    });
    return {
      attached: true,
      method: "field",
      path: taskPath,
      detail: `updated '${proofField}' field`,
    };
  } catch (fieldError) {
    const notePath = `${tasksPath}/${encodeURIComponent(normalizedId)}/notes`;
    try {
      await addSpecKeeperTaskNote(
        normalizedId,
        `Proof: ${stringifyProof(proof)}`,
        { ...sendOptions, tasksPath, noteContentField },
        client,
      );
      return {
        attached: true,
        method: "note",
        path: notePath,
        detail: `proof field update failed (${errorMessage(fieldError)})`,
      };
    } catch (noteError) {
      return {
        attached: false,
        method: "none",
        path: notePath,
        error: `proof field update failed (${errorMessage(fieldError)}) and proof note failed (${errorMessage(noteError)})`,
      };
    }
  }
}
