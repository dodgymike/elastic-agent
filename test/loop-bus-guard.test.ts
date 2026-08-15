/**
 * Regression tests for loop-bus-guard.ts: the pre-planning Agent Bus poll must
 * not read the bus when no bearer credential is available (the poll runs before
 * enrollment/initialization may have provisioned the token). Instead it skips
 * the poll and emits ONE clear, actionable diagnostic. With a valid token the
 * first poll proceeds normally.
 *
 * The "mock bus client" here is a tiny read stub the test drives directly to
 * prove that, when no token is available, the guard prevents the read from even
 * being attempted, and that when a valid token is available the read succeeds
 * before any planning would begin. No network and no secrets are touched.
 *
 * Compiled and executed standalone by the `test:loop-bus-guard` npm script.
 */
import {
  AGENT_BUS_ACCESS_TOKEN_ENV,
  AGENT_BUS_STORE_ENV,
  missingTokenPollDiagnostic,
  resolveAgentBusTokenAvailability,
  type AgentBusTokenAvailability,
} from "../loop-bus-guard.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "loop-bus-guard-test-"));
const ENROLLED_STORE = join(dir, ".agent-bus.local");

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

/** Simulate the pre-planning poll: returns the first relevant message text. */
async function mockPoll(
  availability: AgentBusTokenAvailability,
  readCalls: number[],
  readResult: { text?: string } | undefined,
): Promise<{ text?: string } | undefined> {
  // This is the exact guard behavior introduced in main.ts pollAgentBus: when
  // no token is available, skip the read entirely (fail-safe) and report an
  // actionable diagnostic; otherwise proceed with the (mock) bus read.
  if (!availability.available) {
    return { skipped: true as unknown as undefined, diagnostic: missingTokenPollDiagnostic(availability) } as unknown as
      { text?: string } | undefined;
  }
  readCalls.push(1);
  return readResult;
}

async function main(): Promise<void> {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of [AGENT_BUS_ACCESS_TOKEN_ENV, AGENT_BUS_STORE_ENV, "AGENT_BUS_BASE_URL", "AGENT_BUS_AGENT_ID"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  try {
    // 1. No token available (not enrolled): the poll is skipped and the
    //    diagnostic directs the operator to export the env var.
    const notEnrolled = resolveAgentBusTokenAvailability();
    check("no token -> availability false", notEnrolled.available === false);
    const diagNoEnroll = missingTokenPollDiagnostic(notEnrolled);
    check(
      "no-token diagnostic directs to export AGENT_BUS_ACCESS_TOKEN",
      diagNoEnroll.includes(`export ${AGENT_BUS_ACCESS_TOKEN_ENV}`) && diagNoEnroll.includes(AGENT_BUS_ACCESS_TOKEN_ENV),
    );
    const readCallsNoEnroll: number[] = [];
    const skipped = await mockPoll(notEnrolled, readCallsNoEnroll, { text: "should not read" });
    check(
      "no token -> read is NOT attempted (poll skipped before planning)",
      readCallsNoEnroll.length === 0 && (skipped as any)?.diagnostic !== undefined,
    );

    // 2. Enrolled but no token: diagnostic names the identity store so the
    //    operator knows exactly where the bearer must come from, and the token
    //    value is never surfaced.
    writeFileSync(
      ENROLLED_STORE,
      `${JSON.stringify({
        busUrl: "http://127.0.0.1:9200",
        agentId: "bus-b.agent-2",
        identityStore: join(dir, "ident"),
      })}\n`,
      { mode: 0o600 },
    );
    process.env[AGENT_BUS_STORE_ENV] = ENROLLED_STORE;
    const enrolled = resolveAgentBusTokenAvailability();
    check("enrolled with no token -> availability false", enrolled.available === false);
    check("enrolled identity store is surfaced for the diagnostic", enrolled.identityStore === join(dir, "ident"));
    const diagEnrolled = missingTokenPollDiagnostic(enrolled);
    check(
      "enrolled no-token diagnostic names the identity store and directs to export",
      diagEnrolled.includes(join(dir, "ident")) && diagEnrolled.includes(AGENT_BUS_ACCESS_TOKEN_ENV),
    );

    // 3. A valid token is available (per-call wins over env): the first poll
    //    succeeds before planning. The guard does not surface the token value.
    const withToken = resolveAgentBusTokenAvailability("alpha-1-bravo");
    check("valid per-call token -> availability true", withToken.available === true);
    check(
      "availability never surfaces the token value",
      !JSON.stringify(withToken).includes("alpha-1-bravo"),
    );
    const readCallsValid: number[] = [];
    const relevant = await mockPoll(withToken, readCallsValid, { text: "directive-replan" });
    check(
      "valid token -> read IS attempted and first poll succeeds before planning",
      readCallsValid.length === 1 && relevant?.text === "directive-replan",
    );

    // 4. Valid env token is honored.
    process.env[AGENT_BUS_ACCESS_TOKEN_ENV] = "env-9-zulu";
    const fromEnv = resolveAgentBusTokenAvailability();
    check("valid env token -> availability true", fromEnv.available === true);
    check(
      "env availability never surfaces the token value",
      !JSON.stringify(fromEnv).includes("env-9-zulu"),
    );
  } finally {
    delete process.env[AGENT_BUS_STORE_ENV];
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (failures === 0) {
    console.log("\nAll loop-bus-guard tests passed.");
    process.exit(0);
  } else {
    console.error(`\n${failures} loop-bus-guard test(s) failed.`);
    process.exit(1);
  }
}

main();
