/**
 * Abort console reporting helpers shared by the CLI entrypoint. The block
 * shape and bounded reason are defined by ABORT_SEMANTICS.md sections 2 and 6
 * and are kept provider-neutral so tests can assert the exact abort message
 * without importing the side-effecting main.ts entrypoint.
 */

import { indent } from "../plan-printer.js";
import { truncate } from "../tool-renderer.js";
import type { RunAbortError, RunAbortKind } from "./run-abort.js";

/** Maximum printed/stored abort reason length. */
export const abortReasonMaxLength = 400;

export const ABORT_STATE_LABELS: Readonly<Record<RunAbortKind, string>> = {
    user: "Aborted by user",
    "unable-to-complete": "LLM could not complete the request",
    stuck: "Plan is stuck",
};

/**
 * Bound and flatten an abort reason before it is printed or stored. Abort
 * reasons must never leak secrets or unbounded response bodies, and the
 * single-line replacement keeps the indented [ABORT] block intact.
 */
export function boundedAbortReason(reason: string, maxLength = abortReasonMaxLength): string {
    return truncate(String(reason).replace(/\s+/g, " ").trim(), maxLength);
}

/**
 * Render the concise indented abort block defined by ABORT_SEMANTICS.md
 * section 6. `detailIndent` defaults to the plan-level indentation owned by
 * plan-printer.ts.
 */
export function abortBlockText(error: RunAbortError, detailIndent = indent("plan")): string {
    return [
        ABORT_STATE_LABELS[error.kind],
        `${detailIndent}phase: ${error.phase}`,
        `${detailIndent}step: ${error.step ?? "-"}`,
        `${detailIndent}reason: ${boundedAbortReason(error.message)}`,
        `${detailIndent}exit code: ${error.exitCode}`,
    ].join("\n");
}
