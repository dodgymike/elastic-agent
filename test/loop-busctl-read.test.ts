/**
 * Regression tests for loop-busctl-read.ts: the loop-mode Agent Bus read shells
 * out to the `agent-busctl` CLI (with `--bus` and `--identity`) and requires NO
 * `AGENT_BUS_ACCESS_TOKEN` — authentication is handled by the enrolled identity
 * the CLI reads from the credential store. The watch NDJSON stream is parsed
 * into the flat message array the loop-mode router expects, an empty watch is a
 * normal "no messages" outcome, and every transport/configuration failure is
 * surfaced as a soft `error` (never thrown).
 *
 * No network is touched: the test substitutes a stub `agent-busctl` script on a
 * temp PATH and points the module at it via the `loop-busctl-read` test harness.
 *
 * Compiled and executed standalone by the `test:loop-busctl-read` npm script.
 */
import {
    loadAgentBusRoster,
    parseAgentBusCtlWatchOutput,
    resolveAgentBusCtlBinary,
    watchAgentBusOnce,
    type AgentBusCtlWatchRecord,
} from "../loop-busctl-read.js";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "loop-busctl-read-test-"));

let failures = 0;
function check(name: string, cond: boolean): void {
    if (cond) console.log(`PASS: ${name}`);
    else {
        failures += 1;
        console.error(`FAIL: ${name}`);
    }
}

/** Write an executable stub `agent-busctl` that prints the given stdout. */
function writeStubCtl(name: string, stdout: string, exitCode = 0): string {
    const bin = join(dir, name);
    writeFileSync(
        bin,
        `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write("");\nprocess.exit(${exitCode});\n`,
        { mode: 0o755 },
    );
    chmodSync(bin, 0o755);
    return bin;
}

async function main(): Promise<void> {
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ["AGENT_BUS_URL", "AGENT_BUS_BASE_URL", "AGENT_BUS_IDENTITY", "AGENT_BUSCTL", "AGENT_BUS_STORE"];
    for (const key of envKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }

    // 1. NDJSON parsing: message records are kept, the trailing failure object
    //    (ok:false, kind:empty / exit_code 8) is filtered and flags "empty".
    const parseResult = parseAgentBusCtlWatchOutput(
        [
            JSON.stringify({ message_id: "bus-1", from: "a.agent", text: "hello" }),
            JSON.stringify({ message_id: "bus-2", from: "a.agent", text: "world", body: "d29ybGQ=" }),
            JSON.stringify({ ok: false, kind: "empty", exit_code: 8 }),
        ].join("\n"),
    );
    check("message records are parsed into the message list", parseResult.messages.length === 2);
    check("the empty failure object is filtered out", !parseResult.messages.some((m) => (m as any).ok === false));
    check("an empty watch flags empty=true", parseResult.empty === true);

    // 2. A non-empty watch flags empty=false.
    const nonEmpty = parseAgentBusCtlWatchOutput(JSON.stringify({ message_id: "bus-9", text: "x" }));
    check("a non-empty watch flags empty=false", nonEmpty.empty === false && nonEmpty.messages.length === 1);

    // 3. Roster loading reads non-secret busUrl/identityStore and tolerates
    //    camelCase and snake_case keys.
    const rosterStore = join(dir, ".agent-bus.local");
    writeFileSync(
        rosterStore,
        `${JSON.stringify({ busUrl: "https://127.0.0.1:18090", identityStore: join(dir, "ident"), busFingerprint: "a".repeat(64) })}\n`,
    );
    const roster = loadAgentBusRoster(rosterStore);
    check("roster busUrl is read", roster.busUrl === "https://127.0.0.1:18090");
    check("roster identityStore is read", roster.identityStore === join(dir, "ident"));
    check("roster busFingerprint is read", roster.busFingerprint === "a".repeat(64));
    check("a missing roster yields no defaults", loadAgentBusRoster(join(dir, "nope.json")).busUrl === undefined);

    // 4. The module never requires AGENT_BUS_ACCESS_TOKEN: invoking a stub that
    //    emits an empty watch (exit 8) without any token env resolves to an
    //    empty body (normal idle), not an error.
    const stubEmpty = writeStubCtl(
        "ctl-empty",
        JSON.stringify({ ok: false, kind: "empty", exit_code: 8 }),
        8,
    );
    const emptyResult = await watchAgentBusOnce({
        binary: stubEmpty,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
    });
    check("empty watch -> empty body and no error", emptyResult.error === undefined && Array.isArray(emptyResult.body) && emptyResult.body.length === 0);

    // 5. A stub that emits real message records surfaces them as the body.
    const stubMessages = writeStubCtl(
        "ctl-messages",
        [
            JSON.stringify({ message_id: "bus-1", text: "plan-change", body: "cGxhbi1jaGFuZ2U=" }),
        ].join("\n"),
        0,
    );
    const messagesResult = await watchAgentBusOnce({
        binary: stubMessages,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
    });
    check(
        "real records surface as the message body",
        Array.isArray(messagesResult.body) &&
            (messagesResult.body as AgentBusCtlWatchRecord[]).length === 1 &&
            messagesResult.body[0].text === "plan-change",
    );

    // 6. Missing bus URL is an actionable soft error (no access token mention).
    const noBus = await watchAgentBusOnce({
        binary: stubMessages,
        identityStore: join(dir, "ident"),
    });
    check("missing bus URL yields a soft error", typeof noBus.error === "string" && /--bus/.test(noBus.error));

    // 7. Missing identity store is an actionable soft error.
    const noIdent = await watchAgentBusOnce({
        binary: stubMessages,
        busUrl: "https://127.0.0.1:18090",
    });
    check("missing identity store yields a soft error", typeof noIdent.error === "string" && /--identity/.test(noIdent.error));

    // 8. NO-TIMEOUT: the CLI watch is long-lived by nature, so a stub that takes
    //    longer than the old (removed) 2s external watchdog would have allowed
    //    must still be parsed successfully and reported with its messages — not
    //    killed early with a "timed out" error. There is no watchdog timer
    //    wrapping the sub-process; shutdown is owned by the caller.
    const slowBin = join(dir, "ctl-slow");
    writeFileSync(
        slowBin,
        [
            "#!/usr/bin/env node",
            `const line = ${JSON.stringify(JSON.stringify({ message_id: "bus-slow", text: "late-arrival" }))};`,
            'setTimeout(() => { process.stdout.write(line + "\\n"); process.exit(0); }, 60);',
        ].join("\n"),
        { mode: 0o755 },
    );
    chmodSync(slowBin, 0o755);
    const slowResult = await watchAgentBusOnce({
        binary: slowBin,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
    });
    check(
        "a watch that completes after the old timeout window is still honored (no watchdog timeout)",
        !slowResult.error &&
            Array.isArray(slowResult.body) &&
            (slowResult.body as AgentBusCtlWatchRecord[]).length === 1 &&
            slowResult.body[0].text === "late-arrival",
    );

    // 8b. An unexpected non-zero process exit still surfaces as an error (the
    //     removed watchdog must not suppress real transport failures).
    const crashBin = join(dir, "ctl-crash");
    writeFileSync(
        crashBin,
        '#!/usr/bin/env node\nprocess.stderr.write("boom\\n");\nprocess.exit(3);\n',
        { mode: 0o755 },
    );
    chmodSync(crashBin, 0o755);
    const crashResult = await watchAgentBusOnce({
        binary: crashBin,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
    });
    check(
        "an unexpected process exit is surfaced as an error (not swallowed by a timer)",
        typeof crashResult.error === "string" && /exit 3/.test(crashResult.error),
    );

    // 9. resolveAgentBusCtlBinary prefers an explicit AGENT_BUSCTL env and
    //    falls back to a cwd-relative agent-busctl; never requires a token.
    const explicitBin = join(dir, "explicit-ctl");
    writeFileSync(explicitBin, "#!/usr/bin/env node\n", { mode: 0o755 });
    check("resolveAgentBusCtlBinary honors the AGENT_BUSCTL env var", resolveAgentBusCtlBinary(undefined, explicitBin, dir) === explicitBin);
    const localBin = join(dir, "agent-busctl");
    writeFileSync(localBin, "#!/usr/bin/env node\n", { mode: 0o755 });
    const local = resolveAgentBusCtlBinary(undefined, undefined, dir);
    check("resolveAgentBusCtlBinary finds a cwd-relative agent-busctl", local === localBin);

    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // best-effort cleanup
    }
    for (const key of Object.keys(savedEnv)) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }

    if (failures === 0) {
        console.log("\nAll loop-busctl-read tests passed.");
        process.exit(0);
    } else {
        console.error(`\n${failures} loop-busctl-read test(s) failed.`);
        process.exit(1);
    }
}

main();
