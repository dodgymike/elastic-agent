// Regression tests for tools/AgentBus.ts: the tool now talks to the bus ONLY
// through the local `./agent-busctl` CLI for whoami / watch (long-poll wait) /
// send. There is no HTTP/fetch path at all. These tests drive a fake
// `agent-busctl` executable and assert:
//   1. the tool invokes the CLI for each action (whoami / watch / send);
//   2. the default flags `--identity <dir>` and `--persist-session` are always
//      prepended (and can be overridden);
//   3. no HTTP request is ever made (the tool never constructs a fetch/HTTP
//      client — verified by arming globalThis.fetch to throw);
//   4. watch NDJSON is parsed into message records.
//
// Compiled and executed standalone by the `test:agent-bus` npm script.
import agentBus from "../tools/AgentBus.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-bus-test-"));

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

/** Assert an observed argv vector equals the expected one, in order. */
function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Create a fake `agent-busctl` executable that (a) appends every argv it
 * receives to FAKE_LOG and (b) prints canned output depending on the
 * subcommand it recognises. Returns the paths to the binary and the log.
 */
function makeFakeAgentBusctl(outputByAction: Record<string, string>): { binary: string; log: string } {
  const binary = join(dir, `agent-busctl-${Math.random().toString(36).slice(2)}.sh`);
  const log = join(dir, `calls-${Math.random().toString(36).slice(2)}.log`);
  const script = [
    "#!/bin/sh",
    // Record the whole argv (skipping our own script path at $0).
    'LOG="' + log + '"',
    'for a in "$@"; do printf "%s\\n" "$a" >> "$LOG"; done',
    'printf "\\n" >> "$LOG"',
    // Decide output from the recognised subcommand string in argv.
    'if printf "%s\\n" "$@" | grep -q "whoami"; then',
    '  cat <<\'EOF\'',
    outputByAction.whoami ?? '{"agent_id":"bus-a.agent-1"}',
    "EOF",
    'elif printf "%s\\n" "$@" | grep -q "watch"; then',
    '  cat <<\'EOF\'',
    outputByAction.watch ?? '{"message_id":"m1","from":"bus-a.agent-2","body":"aGk=","seq":1}',
    "EOF",
    'elif printf "%s\\n" "$@" | grep -q "send"; then',
    '  cat <<\'EOF\'',
    outputByAction.send ?? '{"ok":true,"message_id":"abc123"}',
    "EOF",
    'else',
    "  echo 'no action' >&2",
    "  exit 3",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(binary, script, { mode: 0o755 });
  chmodSync(binary, 0o755);
  return { binary, log };
}

/** Read the concatenated argv records from the fake's log file. */
function readCallLog(log: string): string[][] {
  const raw = readFileSync(log, "utf8");
  return raw
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => block.split("\n").filter((line) => line.trim() !== ""));
}

/** Absolute path the tool resolves for a root-relative identity override. */
function abs(root: string, rel: string): string {
  return join(root, rel);
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const boomFetch: typeof fetch = (async () => {
    throw new Error("AgentBus must never issue an HTTP request");
  }) as typeof fetch;

  try {
    // ---- 0. whoami ---------------------------------------------------------
    const whoami = makeFakeAgentBusctl({});
    const whoamiResult = await agentBus({
      action: "whoami",
      binary: whoami.binary,
      root: dir,
      identity: "tmp/elastic-identity",
    });
    const whoamiCalls = readCallLog(whoami.log);
    check("whoami invokes exactly one agent-busctl process", whoamiCalls.length === 1);
    check(
      "whoami argv carries the default flags and whitelisted action flags",
      sameArgs(whoamiCalls[0] ?? [], [
        "--identity", abs(dir, "tmp/elastic-identity"),
        "--persist-session",
        "whoami",
        "--json",
      ]),
    );
    check("whoami returns the CLI stdout", (whoamiResult.stdout ?? "").includes("bus-a.agent-1"));
    check("whoami produces no parsed messages", whoamiResult.messages.length === 0);
    check("whoami records the resolved identity", whoamiResult.identity === abs(dir, "tmp/elastic-identity"));
    check("whoami applies --persist-session by default", whoamiResult.persistSession === true);

    // ---- 1. watch (long-poll wait) -----------------------------------------
    const watch = makeFakeAgentBusctl({});
    const watchResult = await agentBus({
      action: "watch",
      binary: watch.binary,
      root: dir,
      forDuration: "30s",
      count: 5,
    });
    const watchCalls = readCallLog(watch.log);
    check("watch invokes exactly one agent-busctl process", watchCalls.length === 1);
    check(
      "watch argv carries defaults plus --for/--count",
      sameArgs(watchCalls[0] ?? [], [
        "--identity", abs(dir, "tmp/elastic-identity"),
        "--persist-session",
        "watch",
        "--json",
        "--for", "30s",
        "--count", "5",
      ]),
    );
    check("watch parses the NDJSON message into a record", watchResult.messages.length === 1);
    check("watch message exposes its id and base64 body", (watchResult.messages[0]?.message_id as string) === "m1");

    // ---- 2. send ------------------------------------------------------------
    const send = makeFakeAgentBusctl({});
    const sendResult = await agentBus({
      action: "send",
      binary: send.binary,
      root: dir,
      to: "bus-a.agent-2",
      message: "hello from agent-1",
    });
    const sendCalls = readCallLog(send.log);
    check("send invokes exactly one agent-busctl process", sendCalls.length === 1);
    check(
      "send argv carries defaults plus recipient and body",
      sameArgs(sendCalls[0] ?? [], [
        "--identity", abs(dir, "tmp/elastic-identity"),
        "--persist-session",
        "send",
        "bus-a.agent-2",
        "hello from agent-1",
        "--json",
      ]),
    );
    check("send returns the CLI success output", (sendResult.stdout ?? "").includes('"ok":true'));
    check("send produces no parsed messages", sendResult.messages.length === 0);

    // ---- 3. default flags: identity default + --persist-session -------------
    const defaulted = makeFakeAgentBusctl({});
    await agentBus({ action: "whoami", binary: defaulted.binary, root: dir });
    const defaultedCalls = readCallLog(defaulted.log);
    check(
      "default identity resolves to <root>/tmp/elastic-identity",
      sameArgs(defaultedCalls[0]?.slice(0, 2) ?? [], [
        "--identity", abs(dir, "tmp/elastic-identity"),
      ]),
    );

    // ---- 4. explicit overrides win over the defaults ------------------------
    const overridden = makeFakeAgentBusctl({});
    await agentBus({
      action: "whoami",
      binary: overridden.binary,
      root: dir,
      identity: "custom-store",
      persistSession: false,
      busUrl: "https://bus.example",
    });
    const overriddenCalls = readCallLog(overridden.log);
    check(
      "explicit identity / persistSession=false / --bus override the defaults",
      sameArgs(overriddenCalls[0] ?? [], [
        "--identity", abs(dir, "custom-store"),
        "--bus", "https://bus.example",
        "whoami",
        "--json",
      ]),
    );

    // ---- 5. no HTTP is ever made --------------------------------------------
    globalThis.fetch = boomFetch;
    let httpThrew = false;
    try {
      await agentBus({
        action: "send",
        binary: makeFakeAgentBusctl({}).binary,
        root: dir,
        to: "bus-a.agent-2",
        message: "ping",
      });
    } catch (error) {
      httpThrew = error instanceof Error && /HTTP request/.test(error.message);
    }
    check("send with fetch armed to throw completes without any HTTP request", httpThrew === false);

    // ---- 6. fail-fast when a non-zero exit code is returned ------------------
    const failing = join(dir, "failing-busctl.sh");
    writeFileSync(
      failing,
      ["#!/bin/sh", "echo 'boom diagnostic' >&2", "exit 4", ""].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(failing, 0o755);
    let failErr: Error | undefined;
    try {
      await agentBus({ action: "whoami", binary: failing, root: dir, identity: "tmp/elastic-identity" });
    } catch (error) {
      failErr = error as Error;
    }
    check(
      "a non-zero agent-busctl exit is surfaced as a clear error with the CLI diagnostic",
      failErr !== undefined && /failed \(exit 4\)/.test(failErr.message) && /boom diagnostic/.test(failErr.message),
    );
  } finally {
    if (globalThis.fetch !== originalFetch && originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      try {
        delete (globalThis as { fetch?: unknown }).fetch;
      } catch {
        // best-effort
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (failures === 0) {
    console.log("\nAll AgentBus tests passed.");
    process.exit(0);
  } else {
    console.error(`\n${failures} AgentBus test(s) failed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("AgentBus test harness crashed:", error);
  process.exit(1);
});
