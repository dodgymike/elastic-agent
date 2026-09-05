/**
 * cli-loop-options.ts — the CLI loop flags, shared by main.ts and the CLI
 * parsing tests.
 *
 * The runtime has two different loop features that must stay clearly distinct:
 *
 *   - `--agent-bus-loop` — Agent Bus loop mode. The runtime keeps watching the
 *     Agent Bus between execution steps and while idle between plans so
 *     incoming coordination messages can trigger a re-plan or be queued.
 *   - `--loop` — repeating prompt loop. The runtime runs the single prompt
 *     execution pass, waits a fixed pause, then runs it again until the process
 *     is interrupted.
 *
 * Keeping the commander option definitions here (instead of only inside
 * main.ts, which executes at import time) lets the parsing rules be unit-tested
 * without booting the agent runtime, mirroring how cli-task-mode.ts owns the
 * mode rules and llm/cli-provider-selection.ts owns provider parsing.
 */

import { Command } from "commander";

/**
 * Register the two loop flags and the loop-mode `--respond-all` modifier on a
 * commander program. Help text is the single source of truth for the CLI.
 */
export function addLoopOptions(program: Command): Command {
  return program
    .option(
      "--agent-bus-loop",
      "keep running in Agent Bus loop mode: watch the Agent Bus between execution steps and classify incoming messages (relevant messages trigger a re-plan; others are queued)",
      false,
    )
    .option(
      "--respond-all",
      "loop-mode no-filter: treat every Agent Bus message as relevant so the agent responds to all of them instead of filtering irrelevant ones; only meaningful together with --agent-bus-loop",
      false,
    )
    .option(
      "--loop",
      "repeat indefinitely: run the prompt, wait 60 seconds, then run it again until interrupted (Ctrl-C interrupts both the active run and the wait)",
      false,
    );
}
