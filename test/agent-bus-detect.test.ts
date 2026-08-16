// Unit tests for the agent-bus command refusal implemented in
// tools/agent-bus-detect.ts (the detector) and tools/ExecuteCommand.ts (the
// defense-in-depth guard). Together they guarantee that `ExecuteCommand` never
// runs a shell command that invokes an agent-bus binary; all agent-bus activity
// is owned by the dedicated `AgentBus` (whoami/watch/send) and `AgentBusEnrol`
// (enroll) tools.
//
// Coverage requested by the plan step:
//   (a) 'agent-busctl enrol ...' is refused.
//   (b) 'agentbus enrol' is refused.
//   (c) a benign command that merely mentions 'agentbus' in a non-executable
//       context is allowed (not refused).
//   (d) no shell command executes when a command is refused.
//
// Compiled and executed standalone by the `test:agent-bus-detect` npm script.
import { detectAgentBusCommand } from "../tools/agent-bus-detect.js";
import { executeCommand } from "../tools/ExecuteCommand.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-bus-detect-test-"));
  const marker = join(tmpDir, "marker-should-not-exist");
  try {
    // ------------------------------------------------------------------
    // 1. Detector: agent-bus binaries are refused (pure string logic, no I/O).
    //    Covers (a) and (b) plus variants.
    // ------------------------------------------------------------------
    const refusedCommands: Array<[string, string, RegExp]> = [
      ["agent-busctl enrol https://invite.example/x#token=abc", "agent-busctl", /Refused: agent-bus actions are handled by the AgentBus tool/],
      ["agentbus enrol https://invite.example/x#token=abc", "agentbus", /Refused: agent-bus actions are handled by the AgentBus tool/],
      ["agent-bus enrol --name agent", "agent-bus", /Refused: agent-bus actions/],
      ["agent-busctl whoami", "agent-busctl", /Refused: agent-bus actions/],
      ["agent-busctl watch --for 30s", "agent-busctl", /Refused: agent-bus actions/],
      ["agent-busctl send foo.bar 'hello'", "agent-busctl", /Refused: agent-bus actions/],
      ["./agent-busctl enrol x", "./agent-busctl", /Refused: agent-bus actions/],
      ["bin/agentbus enrol x", "bin/agentbus", /Refused: agent-bus actions/],
      ["/usr/local/bin/agent-bus enrol x", "/usr/local/bin/agent-bus", /Refused: agent-bus actions/],
      ["AGENT_BUSCTL=/opt/bin agent-busctl whoami", "agent-busctl", /Refused: agent-bus actions/],
      // Compound commands are fail-closed: any agent-bus segment refuses all.
      ["echo hi && agent-busctl enrol x", "agent-busctl", /Refused: agent-bus actions/],
      ["agentbus enrol x; echo done", "agentbus", /Refused: agent-bus actions/],
      ["agent-busctl enrol x || true", "agent-busctl", /Refused: agent-bus actions/],
    ];
    for (const [command, executable, pattern] of refusedCommands) {
      const detection = detectAgentBusCommand(command);
      check(
        `detector refuses agent-bus invocation: ${command}`,
        detection.action === "refuse" &&
          detection.reason.includes(`'${executable}'`) &&
          pattern.test(detection.reason),
      );
    }

    // ------------------------------------------------------------------
    // 2. Detector: benign non-executable references are ALLOWED. Covers (c).
    //    The token 'agentbus' appears as an argument, not as the executable.
    // ------------------------------------------------------------------
    const allowedCommands = [
      "echo agent-busctl",                                        // argument to echo
      "grep agentbus file",                                       // argument to grep
      "cat .agent-bus.local",                                     // roster/config data path
      "git agent-busctl",                                         // git subcommand arg
      "node test/agent-bus-detect.test.ts",                       // unrelated executable
      "npm run test:agent-bus-detect",                            // unrelated executable
      "ls agents",                                                // unrelated executable
      "",                                                          // empty
    ];
    for (const command of allowedCommands) {
      const detection = detectAgentBusCommand(command);
      check(
        `detector allows benign reference to agentbus: ${JSON.stringify(command)}`,
        detection.action === "none",
      );
    }

    // ------------------------------------------------------------------
    // 3. ExecuteCommand refuses AND never spawns a shell. Covers (d).
    //    If the guard failed, the second segment (`touch <marker>`) would run
    //    and create the marker. Refusal means no process is ever spawned.
    // ------------------------------------------------------------------
    const refusedExecCommands: Array<[string, string]> = [
      ["agent-busctl enrol placeholder && touch " + marker, "agent-busctl"],
      ["agentbus enrol placeholder && touch " + marker, "agentbus"],
      ["agent-bus whoami && touch " + marker, "agent-bus"],
    ];
    for (const [command, executable] of refusedExecCommands) {
      let rejectedWithError: Error | undefined;
      try {
        await executeCommand(command);
      } catch (error) {
        rejectedWithError = error as Error;
      }
      check(
        `executeCommand rejects refused agent-bus command without spawning: ${command}`,
        rejectedWithError !== undefined &&
          rejectedWithError.name === "AgentBusCommandRefused" &&
          /handled by the AgentBus tool/.test(rejectedWithError.message) &&
          rejectedWithError.message.includes(`'${executable}'`),
      );
      // A side-effect would only exist if a shell had actually executed the
      // second segment (`touch <marker>`). Refusal guarantees it never runs,
      // so the marker is never created — proof that no shell command executes.
      check(
        `no shell side-effect ran for refused command (marker absent): ${command}`,
        !existsSync(marker),
      );
    }

    // A benign command does run through executeCommand and is NOT refused.
    const peace = await executeCommand(`printf ok > "${join(tmpDir, "benign.txt")}"`);
    check(
      "benign command is not refused by the agent-bus guard",
      peace.exitCode === 0 && (!peace.stderr || peace.stderr === ""),
    );
    check(
      "benign command side-effect ran",
      existsSync(join(tmpDir, "benign.txt")),
    );
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (failures === 0) {
    console.log("\nAll agent-bus command refusal tests passed.");
    process.exit(0);
  } else {
    console.error(`\n${failures} agent-bus command refusal test(s) failed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Agent-bus command refusal test harness crashed:", error);
  process.exit(1);
});
