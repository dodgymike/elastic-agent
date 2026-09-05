import assert from "node:assert/strict";
import {
  DEFAULT_REPEAT_PAUSE_MS,
  pauseAbortable,
  runRepeatLoop,
} from "../loop-repeat.js";
import { RunAbortError } from "../llm/run-abort.js";

async function main(): Promise<void> {
  // Scheduling: each iteration runs once, then pauses; an abort ends the loop
  // cleanly by rejecting with RunAbortError (no retry after the abort).
  {
    const controller = new AbortController();
    const runs: number[] = [];
    let pauses = 0;
    const outcome = runRepeatLoop({
      signal: controller.signal,
      runOnce: async () => {
        runs.push(runs.length + 1);
        return { success: true };
      },
      pauseMs: 1,
      pause: async () => {
        pauses += 1;
        if (pauses >= 2) controller.abort();
      },
      log: () => undefined,
    });
    await assert.rejects(outcome, RunAbortError);
    assert.deepEqual(runs, [1, 2]);
    assert.equal(pauses, 2);
  }

  // Default pause duration is the documented 60 seconds.
  {
    const controller = new AbortController();
    let observedPauseMs = -1;
    const outcome = runRepeatLoop({
      signal: controller.signal,
      runOnce: async () => ({ success: true }),
      pause: async (ms) => {
        observedPauseMs = ms;
        controller.abort();
      },
      log: () => undefined,
    });
    await assert.rejects(outcome, RunAbortError);
    assert.equal(observedPauseMs, DEFAULT_REPEAT_PAUSE_MS);
    assert.equal(DEFAULT_REPEAT_PAUSE_MS, 60000);
  }

  // A run resolving with success:false is a failed iteration: logged, paused,
  // then retried.
  {
    const controller = new AbortController();
    const logs: string[] = [];
    let attempts = 0;
    let pauses = 0;
    const outcome = runRepeatLoop({
      signal: controller.signal,
      runOnce: async () => {
        attempts += 1;
        return attempts === 1 ? { success: false } : { success: true };
      },
      pauseMs: 5,
      pause: async () => {
        pauses += 1;
        if (pauses >= 2) controller.abort();
      },
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
    await assert.rejects(outcome, RunAbortError);
    assert.equal(attempts, 2);
    assert.equal(pauses, 2);
    assert.ok(
      logs.some((entry) => entry.includes("iteration 1 did not complete successfully")),
      "failed iteration is logged before the retry",
    );
  }

  // A thrown (non-abort) error is a failed iteration: logged, paused, retried.
  {
    const controller = new AbortController();
    const logs: string[] = [];
    let attempts = 0;
    let pauses = 0;
    const outcome = runRepeatLoop({
      signal: controller.signal,
      runOnce: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
        return { success: true };
      },
      pauseMs: 5,
      pause: async () => {
        pauses += 1;
        if (pauses >= 2) controller.abort();
      },
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
    await assert.rejects(outcome, RunAbortError);
    assert.equal(attempts, 2);
    assert.equal(pauses, 2);
    assert.ok(
      logs.some((entry) => entry.includes("iteration 1 failed: boom")),
      "thrown failure is logged with its reason",
    );
  }

  // A RunAbortError thrown by runOnce propagates immediately: no pause, no retry.
  {
    const controller = new AbortController();
    let runs = 0;
    let pauses = 0;
    const outcome = runRepeatLoop({
      signal: controller.signal,
      runOnce: async () => {
        runs += 1;
        throw new RunAbortError("user", "execution", "stop now");
      },
      pauseMs: 5,
      pause: async () => {
        pauses += 1;
      },
      log: () => undefined,
    });
    await assert.rejects(
      outcome,
      (error: unknown) => error instanceof RunAbortError && error.kind === "user",
    );
    assert.equal(runs, 1);
    assert.equal(pauses, 0);
  }

  // pauseAbortable resolves after a short live wait.
  await pauseAbortable(2, new AbortController().signal);

  // pauseAbortable rejects immediately when the signal is already aborted.
  {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pauseAbortable(60000, controller.signal), RunAbortError);
  }

  // pauseAbortable rejects as soon as the signal aborts mid-pause.
  {
    const controller = new AbortController();
    const pending = pauseAbortable(60000, controller.signal);
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof RunAbortError && error.phase === "cleanup",
    );
  }

  console.log("Repeat-loop scheduling/termination tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
