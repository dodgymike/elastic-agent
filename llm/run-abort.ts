/**
 * Abort plumbing shared by the CLI entrypoint, planner/replanner loops, and
 * the LLM adapter runtime. `RunAbortError` is the single error type used to
 * distinguish a deliberate abort (user interrupt, unable-to-complete, or stuck
 * plan) from an unexpected crash. The shape is defined by ABORT_SEMANTICS.md
 * section 2 and is deliberately provider-neutral.
 */

export type RunAbortKind = "user" | "unable-to-complete" | "stuck";

export type RunAbortPhase =
  | "planning"
  | "planning-necessity"
  | "execution"
  | "replan"
  | "review-plan"
  | "review"
  | "task-mode-setup"
  | "cleanup";

export interface RunAbortErrorOptions {
  /** 1-based plan step when the abort happened inside a step; absent otherwise. */
  readonly step?: number;
  /** Exit code override. Defaults to the code associated with `kind` and the reason. */
  readonly exitCode?: number;
  readonly cause?: unknown;
}

function defaultExitCode(kind: RunAbortKind, reason: string): number {
  if (kind === "user") return /\bSIGTERM\b/i.test(reason) ? 143 : 130;
  if (kind === "unable-to-complete") return 2;
  return 3;
}

/**
 * A deliberate run abort. The top-level handler uses this type to choose the
 * abort exit code and to avoid printing a stack trace for expected aborts.
 */
export class RunAbortError extends Error {
  override readonly name = "RunAbortError";
  readonly kind: RunAbortKind;
  readonly phase: RunAbortPhase;
  readonly step?: number;
  readonly exitCode: number;

  constructor(kind: RunAbortKind, phase: RunAbortPhase, reason: string, options: RunAbortErrorOptions = {}) {
    super(reason, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunAbortError";
    this.kind = kind;
    this.phase = phase;
    if (options.step !== undefined) this.step = options.step;
    this.exitCode = options.exitCode ?? defaultExitCode(kind, reason);
  }
}

/** Build a user-triggered RunAbortError from an AbortSignal's reason. */
export function runAbortErrorFromSignal(signal: AbortSignal, phase: RunAbortPhase, step?: number): RunAbortError {
  const reason = typeof signal.reason === "string" && signal.reason.trim()
    ? signal.reason.trim()
    : "aborted";
  return new RunAbortError("user", phase, reason, step === undefined ? undefined : { step });
}

/** Throw a RunAbortError when `signal` is already aborted; otherwise no-op. */
export function throwIfAborted(signal: AbortSignal | undefined, phase: RunAbortPhase, step?: number): void {
  if (signal?.aborted) throw runAbortErrorFromSignal(signal, phase, step);
}
