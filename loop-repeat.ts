/**
 * loop-repeat.ts — repeating prompt loop (`--loop`).
 *
 * The CLI's `--loop` option runs the single prompt execution pass
 * (`runPromptOnce`) indefinitely: run, await completion, pause for a fixed
 * interval, then repeat. A failed iteration is logged and still followed by
 * the pause and a retry; only an abort (SIGINT/SIGTERM via the caller's
 * AbortSignal) terminates the loop, interrupting both an active run and the
 * pause cleanly.
 *
 * This module is intentionally independent of the main entrypoint so the
 * scheduling/termination behavior is unit-testable without importing main.ts:
 * callers inject `runOnce`, the pause implementation, the pause duration, and
 * a logging hook. main.ts wires these to `runPromptOnce`, an abort-aware
 * timer, the 60-second default, and the shared status logger.
 */

import { RunAbortError, runAbortErrorFromSignal, throwIfAborted } from "./llm/run-abort.js";

/** Default pause between repeated prompt runs: 60 seconds. */
export const DEFAULT_REPEAT_PAUSE_MS = 60_000;

export type RepeatLoopLogLevel = "info" | "warning" | "error";

export interface RepeatLoopRunResult {
    success: boolean;
}

export interface RepeatLoopOptions {
    /** Abort signal that interrupts both an active run and the pause. */
    signal: AbortSignal;
    /** One prompt execution pass. Returns success=false for a failed iteration. */
    runOnce: () => Promise<RepeatLoopRunResult>;
    /** Pause between iterations in milliseconds; injectable for tests. */
    pauseMs?: number;
    /**
     * Pause implementation. Defaults to an abort-aware timer that rejects with
     * a RunAbortError when the signal fires before the pause elapses.
     */
    pause?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Log an iteration lifecycle event. Defaults to console output. */
    log?: (level: RepeatLoopLogLevel, message: string) => void;
}

function defaultLog(level: RepeatLoopLogLevel, message: string): void {
    if (level === "error") console.error(message);
    else if (level === "warning") console.warn(message);
    else console.log(message);
}

/**
 * Abort-aware pause. Resolves after `ms` milliseconds, or rejects with a
 * RunAbortError as soon as `signal` aborts so Ctrl-C/SIGTERM interrupts the
 * pause immediately instead of waiting out the timer.
 */
export function pauseAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            reject(runAbortErrorFromSignal(signal, "cleanup"));
        };

        if (signal.aborted) {
            reject(runAbortErrorFromSignal(signal, "cleanup"));
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            // Aborted while the listener was being registered; the listener
            // cannot fire for an already-aborted signal, so reject here.
            signal.removeEventListener("abort", onAbort);
            reject(runAbortErrorFromSignal(signal, "cleanup"));
            return;
        }

        timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, Math.max(0, ms));
    });
}

/**
 * Run one prompt pass after another until the supplied signal aborts. A thrown
 * RunAbortError always propagates immediately (no pause, no retry) so the
 * caller's abort handler can finalize. Any other thrown error — or a run that
 * resolves with `success: false` — is logged as a failed iteration, followed
 * by the configured pause and a retry.
 */
export async function runRepeatLoop(options: RepeatLoopOptions): Promise<{ success: boolean }> {
    const pauseMs = options.pauseMs ?? DEFAULT_REPEAT_PAUSE_MS;
    const pause = options.pause ?? pauseAbortable;
    const log = options.log ?? defaultLog;

    let iteration = 0;
    while (true) {
        throwIfAborted(options.signal, "cleanup");
        iteration += 1;
        log("info", `Repeat loop: iteration ${iteration} starting.`);

        let iterationSucceeded: boolean;
        try {
            const outcome = await options.runOnce();
            iterationSucceeded = outcome.success !== false;
        } catch (error) {
            if (error instanceof RunAbortError) throw error;
            const reason = error instanceof Error ? error.message : String(error);
            log("error", `Repeat loop: iteration ${iteration} failed: ${reason}`);
            iterationSucceeded = false;
        }

        if (iterationSucceeded) {
            log("info", `Repeat loop: iteration ${iteration} completed successfully.`);
        } else {
            log("warning", `Repeat loop: iteration ${iteration} did not complete successfully; retrying after the pause.`);
        }

        log("info", `Repeat loop: pausing for ${pauseMs} ms before the next run (Ctrl-C stops).`);
        await pause(pauseMs, options.signal);
    }
}
