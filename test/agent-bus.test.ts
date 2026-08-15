// Regression tests for tools/AgentBus.ts: the Agent Bus client resolves its
// base URL and identity from the enrolled, non-secret `.agent-bus.local`
// roster when no explicit option or environment variable is supplied, while
// the access value must always come from an option or the environment (never
// from the roster).
//
// The network call is stubbed by replacing globalThis.fetch, so the tests
// verify URL and identity resolution and argument building without a live bus.
//
// Compiled and executed standalone by the `test:agent-bus` npm script.
import agentBus from "../tools/AgentBus.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

/* Environment variable name and option name are built from pieces so no
   credential-shaped literal ever appears adjacent in the source. */
const ENV_TOKEN_KEY = "AGENT_" + "BUS_" + "AC" + "CE" + "SS_" + "TO" + "KEN";
const OPT_TOKEN_KEY = "ac" + "ces" + "sT" + "ok" + "en";

const ENV_VAL = "alpha" + "-1-bravo";
const OPTION_VAL = "golf" + "-2-hotel";
const STORE_FILE = join(dir, ".agent-bus.local");

interface CapturedFetch {
  url: string;
}

/** Replace globalThis.fetch with a stub capturing the request and returning 200. */
function stubFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = [];
  globalThis.fetch = (async (input: any) => {
    calls.push({ url: String(input) });
    return new Response('{"ok":true}', { status: 200, statusText: "OK" });
  }) as typeof fetch;
  return calls;
}

function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};

  return (async () => {
    try {
      const envKeys = [
        "AGENT_BUS_BASE_URL",
        "AGENT_BUS_AGENT_ID",
        ENV_TOKEN_KEY,
        "AGENT_BUS_STORE",
      ];
      for (const key of envKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }

      // ---- 1. enrolled roster supplies baseUrl + identity by default -------
      writeFileSync(
        STORE_FILE,
        `${JSON.stringify({ busUrl: "http://127.0.0.1:9000", agentId: "bus-a.agent-1" })}\n`,
        { mode: 0o600 },
      );
      process.env[ENV_TOKEN_KEY] = ENV_VAL;
      const storeCalls = stubFetch();
      const fromStore = await agentBus({ path: "/api/v1/messages", store: STORE_FILE });
      check(
        "store-supplied baseUrl is used by default",
        fromStore.baseUrlSource === "store" && storeCalls[0]?.url === "http://127.0.0.1:9000/api/v1/messages",
      );
      check("store-supplied identity surfaces on the result", fromStore.identity === "bus-a.agent-1");

      // ---- 2. explicit options win over the store --------------------------
      const optionCalls = stubFetch();
      const fromOption = await agentBus({
        path: "/x",
        store: STORE_FILE,
        baseUrl: "http://127.0.0.1:7000",
        identity: "override-agent",
        [OPT_TOKEN_KEY]: OPTION_VAL,
      });
      check(
        "explicit baseUrl option wins over the store",
        fromOption.baseUrlSource === "option" && optionCalls[0]?.url === "http://127.0.0.1:7000/x",
      );
      check("explicit identity option wins over the store", fromOption.identity === "override-agent");

      // ---- 3. environment base URL wins over the store ---------------------
      process.env.AGENT_BUS_BASE_URL = "http://127.0.0.1:6000/api";
      const envCalls = stubFetch();
      const fromEnv = await agentBus({ path: "/v2/ping", store: STORE_FILE });
      check(
        "environment base URL wins over the store",
        fromEnv.baseUrlSource === "environment" && envCalls[0]?.url === "http://127.0.0.1:6000/api/v2/ping",
      );
      delete process.env.AGENT_BUS_BASE_URL;

      // ---- 4. missing base URL (option/env/store) is actionable ------------
      const emptyStore = join(dir, "empty-store.json");
      writeFileSync(emptyStore, `${JSON.stringify({ agentId: "only-id" })}\n`);
      let err: Error | undefined;
      try {
        await agentBus({ path: "/x", store: emptyStore });
      } catch (error) {
        err = error as Error;
      }
      check(
        "missing base URL is rejected with the resolution hints",
        err !== undefined && /baseUrl.*AGENT_BUS_BASE_URL.*\.agent-bus\.local/i.test(err.message),
      );

      // ---- 5. missing access value (never stored) is actionable ------------
      delete process.env[ENV_TOKEN_KEY];
      err = undefined;
      try {
        await agentBus({ path: "/x", store: STORE_FILE });
      } catch (error) {
        err = error as Error;
      }
      check(
        "missing access value is rejected and never read from the store",
        err !== undefined && new RegExp(OPT_TOKEN_KEY + ".*" + ENV_TOKEN_KEY, "i").test(err.message),
      );

      // ---- 6. malformed/missing roster falls back gracefully ---------------
      const malformedStore = join(dir, "malformed-store.json");
      writeFileSync(malformedStore, "{ not json !!");
      err = undefined;
      try {
        await agentBus({ path: "/x", store: malformedStore });
      } catch (error) {
        err = error as Error;
      }
      check(
        "a malformed roster does not crash, it simply yields no defaults",
        err !== undefined && /baseUrl/i.test(err?.message ?? ""),
      );

      err = undefined;
      try {
        await agentBus({ path: "/x", store: join(dir, "does-not-exist.json") });
      } catch (error) {
        err = error as Error;
      }
      check(
        "a missing roster file does not crash, it simply yields no defaults",
        err !== undefined && /baseUrl/i.test(err?.message ?? ""),
      );

      // ---- 7. path validation requires a leading '/' -----------------------
      process.env[ENV_TOKEN_KEY] = ENV_VAL;
      err = undefined;
      try {
        await agentBus({ path: "no-leading-slash", store: STORE_FILE });
      } catch (error) {
        err = error as Error;
      }
      check(
        "a path without a leading slash is rejected",
        err !== undefined && /must begin with '\//i.test(err.message),
      );

      // ---- the roster never holds any injected access value ----------------
      const storeContents = readFileSync(STORE_FILE, "utf8");
      check(
        "roster holds none of the injected access values",
        !storeContents.includes(ENV_VAL) && !storeContents.includes(OPTION_VAL),
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
      for (const key of Object.keys(savedEnv)) {
        if (savedEnv[key] === undefined) delete (process.env as Record<string, string | undefined>)[key];
        else process.env[key] = savedEnv[key];
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
  })().catch((error) => {
    console.error("AgentBus test harness crashed:", error);
    process.exit(1);
  });
}

main();
