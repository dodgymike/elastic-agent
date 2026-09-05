import assert from "node:assert/strict";
import { Command } from "commander";
import { addLoopOptions } from "../cli-loop-options.js";
import { resolveCliRunMode } from "../cli-task-mode.js";

interface ParsedLoopOptions {
  loop?: boolean;
  agentBusLoop?: boolean;
  respondAll?: boolean;
  args: string[];
}

function parseLoopArgs(args: readonly string[]): ParsedLoopOptions {
  const program = new Command();
  program
    .name("elastic-agent")
    .description("test program")
    .argument("[prompt]", "task or request to plan and execute")
    .exitOverride();
  addLoopOptions(program);
  program.parse(["node", "elastic-agent", ...args]);
  const opts = program.opts() as {
    loop?: boolean;
    agentBusLoop?: boolean;
    respondAll?: boolean;
  };
  return {
    loop: opts.loop,
    agentBusLoop: opts.agentBusLoop,
    respondAll: opts.respondAll,
    args: [...program.args],
  };
}

// --loop is accepted as the repeating prompt loop and must not enable the
// Agent Bus loop.
const repeat = parseLoopArgs(["--loop", "summarize this"]);
assert.equal(repeat.loop, true);
assert.ok(!repeat.agentBusLoop, "--loop must not enable the Agent Bus loop");
assert.equal(repeat.args[0], "summarize this");

// --agent-bus-loop is accepted and preserved for the existing Agent Bus loop.
const agentBus = parseLoopArgs(["--agent-bus-loop", "summarize this"]);
assert.equal(agentBus.agentBusLoop, true);
assert.ok(!agentBus.loop, "--agent-bus-loop must not enable the repeating prompt loop");

// --respond-all still travels with --agent-bus-loop and maps through
// resolveCliRunMode exactly as main.ts wires it.
const agentBusAll = parseLoopArgs(["--agent-bus-loop", "--respond-all", "summarize this"]);
assert.equal(agentBusAll.agentBusLoop, true);
assert.equal(agentBusAll.respondAll, true);
const agentBusMode = resolveCliRunMode(
  undefined,
  "summarize this",
  agentBusAll.agentBusLoop === true,
  agentBusAll.respondAll === true,
);
assert.equal(agentBusMode.loop, true);
assert.equal(agentBusMode.respondAll, true);

// The repeat loop is a separate boolean: --loop never feeds resolveCliRunMode's
// Agent Bus loop flag, so the old --loop spelling no longer selects Agent Bus
// loop mode.
const repeatMode = resolveCliRunMode(
  undefined,
  "summarize this",
  repeat.agentBusLoop === true,
  repeat.respondAll === true,
);
assert.equal(repeatMode.loop, false);
assert.equal(repeatMode.respondAll, false);

// Both loop flags are independent and may be supplied together.
const both = parseLoopArgs(["--loop", "--agent-bus-loop", "summarize this"]);
assert.equal(both.loop, true);
assert.equal(both.agentBusLoop, true);

// Help text distinguishes the two loop flags and no longer advertises the old
// --loop spelling for Agent Bus loop mode.
const helpProgram = new Command();
helpProgram
  .name("elastic-agent")
  .description("test program")
  .argument("[prompt]", "task or request to plan and execute");
addLoopOptions(helpProgram);
const help = helpProgram.helpInformation();
// Commander wraps long option descriptions across lines, so collapse all
// whitespace before matching phrases that may span a wrap boundary.
const normalizedHelp = help.replace(/\s+/g, " ");
assert.ok(help.includes("--agent-bus-loop"), "help lists --agent-bus-loop");
assert.ok(help.includes("--loop"), "help lists --loop");
assert.ok(
  normalizedHelp.includes("only meaningful together with --agent-bus-loop"),
  "--respond-all help points at --agent-bus-loop",
);
assert.ok(
  !normalizedHelp.includes("only meaningful together with --loop"),
  "old --loop Agent Bus spelling is gone from --respond-all help",
);

console.log("CLI loop-option argument parsing tests passed.");
