import specKeeperDefault, { SpecKeeperOptions, SpecKeeperResult } from "./tools/SpecKeeper.js";
import {
  attachSpecKeeperTaskProof,
  postSpecKeeperTaskNote,
  updateSpecKeeperTaskStatus,
  SpecKeeperTaskLifecycleOptions,
  SpecKeeperTaskProof,
} from "./specKeeperTaskLifecycle.js";

/**
 * Task-mode terminal transition helpers.
 *
 * Once execution (or review) reaches a terminal outcome, the runtime marks the
 * claimed Spec Keeper task as done, blocked, or failed and records a proof
 * artifact plus a human-readable note. This module owns that terminal
 * transition so callers never have to remember the status/note/proof sequence
 * and tests can exercise the final updates with a fake client.
 *
 * The helpers are best-effort at the update level: each status, note, and proof
 * update is attempted independently, and any failure is returned as a bounded
 * diagnostic rather than thrown. The runtime outcome has already been decided
 * by the time these helpers run, so a failed final update must not hide the
 * real success/failure or change the CLI exit code.
 */

export type SpecKeeperTaskFinalStatus = "done" | "blocked" | "failed";

export interface SpecKeeperTaskCompletionOptions
  extends SpecKeeperTaskLifecycleOptions {
  /** Status to apply when the task fails; defaults to blocked. */
  failureStatus?: "blocked" | "failed";
  /** Maximum length of diagnostics embedded in notes and proofs. */
  maxDiagnosticLength?: number;
}

export interface SpecKeeperTaskCompletionResult {
  taskId: string;
  status: SpecKeeperTaskFinalStatus;
  statusUpdated: boolean;
  noteRecorded: boolean;
  proofAttached: boolean;
  proofMethod: "field" | "note" | "none";
  diagnostics: string[];
}

const DEFAULT_MAX_DIAGNOSTIC_LENGTH = 400;

/** Extract the best error message without leaking the raw error object. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bound and normalize a failure diagnostic before it is embedded in updates. */
function diagnosticText(diagnostic: string, maxLength: number): string {
  const normalized = String(diagnostic ?? "").trim();
  if (!normalized) return "no diagnostic provided";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

/** Run one terminal update and collect its failure as a diagnostic. */
async function attempt(
  action: () => Promise<unknown>,
  diagnostics: string[],
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    diagnostics.push(errorMessage(error));
    return false;
  }
}

/**
 * Mark a claimed task complete (status done) with a note and proof artifact.
 *
 * The caller supplies the proof payload; it should include commit or test
 * evidence when that evidence is available. The status note is a concise,
 * secret-safe summary. Update failures are returned in `diagnostics` and do
 * not throw.
 */
export async function completeSpecKeeperTask(
  taskId: string,
  proof: SpecKeeperTaskProof,
  options: SpecKeeperTaskCompletionOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SpecKeeperTaskCompletionResult> {
  const {
    failureStatus: _failureStatus,
    maxDiagnosticLength = DEFAULT_MAX_DIAGNOSTIC_LENGTH,
    ...lifecycleOptions
  } = options;
  const diagnostics: string[] = [];

  const statusUpdated = await attempt(
    () => updateSpecKeeperTaskStatus(taskId, "done", "Task completed.", lifecycleOptions, client),
    diagnostics,
  );
  const noteRecorded = await attempt(
    () => postSpecKeeperTaskNote(taskId, "Task completed.", lifecycleOptions, client),
    diagnostics,
  );

  const proofResult = await attachSpecKeeperTaskProof(taskId, proof, lifecycleOptions, client);
  if (!proofResult.attached) {
    diagnostics.push(`proof not attached: ${proofResult.error ?? "unknown error"}`);
  }

  return {
    taskId,
    status: "done",
    statusUpdated,
    noteRecorded,
    proofAttached: proofResult.attached,
    proofMethod: proofResult.method,
    diagnostics,
  };
}

/**
 * Mark a claimed task failed or blocked with a bounded diagnostic and note.
 *
 * The diagnostic is embedded in the status note, the task note, and the proof
 * payload so the failure is durable on the task. Use `failureStatus` to choose
 * the blocked (default) or failed terminal state.
 */
export async function failSpecKeeperTask(
  taskId: string,
  diagnostic: string,
  options: SpecKeeperTaskCompletionOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SpecKeeperTaskCompletionResult> {
  const {
    failureStatus = "blocked",
    maxDiagnosticLength = DEFAULT_MAX_DIAGNOSTIC_LENGTH,
    ...lifecycleOptions
  } = options;
  const status: SpecKeeperTaskFinalStatus =
    failureStatus === "failed" ? "failed" : "blocked";
  const safeDiagnostic = diagnosticText(diagnostic, maxDiagnosticLength);
  const statusNote = `Task ${status}: ${safeDiagnostic}`;
  const diagnostics: string[] = [];

  const statusUpdated = await attempt(
    () => updateSpecKeeperTaskStatus(taskId, status, statusNote, lifecycleOptions, client),
    diagnostics,
  );
  const noteRecorded = await attempt(
    () => postSpecKeeperTaskNote(taskId, `Task ${status}: ${safeDiagnostic}`, lifecycleOptions, client),
    diagnostics,
  );

  const proof: SpecKeeperTaskProof = {
    outcome: status === "failed" ? "failed" : "blocked",
    diagnostic: safeDiagnostic,
  };
  const proofResult = await attachSpecKeeperTaskProof(taskId, proof, lifecycleOptions, client);
  if (!proofResult.attached) {
    diagnostics.push(`proof not attached: ${proofResult.error ?? "unknown error"}`);
  }

  return {
    taskId,
    status,
    statusUpdated,
    noteRecorded,
    proofAttached: proofResult.attached,
    proofMethod: proofResult.method,
    diagnostics,
  };
}

/**
 * Mark a claimed task blocked with an abort note in the exact form
 * `Aborted (<kind>): <bounded reason>` for the status note, task note, and
 * proof diagnostic. Aborts are always `blocked` (never `failed`) and the
 * update sequence matches `failSpecKeeperTask`: status, note, then proof.
 */
export async function abortSpecKeeperTask(
  taskId: string,
  kind: string,
  reason: string,
  options: SpecKeeperTaskCompletionOptions = {},
  client: (opts: SpecKeeperOptions) => Promise<SpecKeeperResult> = specKeeperDefault,
): Promise<SpecKeeperTaskCompletionResult> {
  const {
    failureStatus: _failureStatus,
    maxDiagnosticLength = DEFAULT_MAX_DIAGNOSTIC_LENGTH,
    ...lifecycleOptions
  } = options;
  const safeKind = String(kind ?? "unknown").trim() || "unknown";
  const note = `Aborted (${safeKind}): ${diagnosticText(reason, maxDiagnosticLength)}`;
  const diagnostics: string[] = [];

  const statusUpdated = await attempt(
    () => updateSpecKeeperTaskStatus(taskId, "blocked", note, lifecycleOptions, client),
    diagnostics,
  );
  const noteRecorded = await attempt(
    () => postSpecKeeperTaskNote(taskId, note, lifecycleOptions, client),
    diagnostics,
  );

  const proof: SpecKeeperTaskProof = { outcome: "blocked", diagnostic: note };
  const proofResult = await attachSpecKeeperTaskProof(taskId, proof, lifecycleOptions, client);
  if (!proofResult.attached) {
    diagnostics.push(`proof not attached: ${proofResult.error ?? "unknown error"}`);
  }

  return {
    taskId,
    status: "blocked",
    statusUpdated,
    noteRecorded,
    proofAttached: proofResult.attached,
    proofMethod: proofResult.method,
    diagnostics,
  };
}
