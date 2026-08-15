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
    buildResumeCursor,
    captureAndPersistCursor,
    clearInMemoryCursor,
    defaultBusCursorFilePath,
    extractCursorId,
    getLastCursorId,
    isInvalidCursorFailure,
    loadAgentBusRoster,
    loadCursor,
    parseAgentBusCtlWatchOutput,
    resolveAgentBusCtlBinary,
    resolveStartCursorId,
    saveCursor,
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

    // 2a. Cursor extraction: a message's resume cursor is built from its bus id
    //     and sequence as the base64-encoded `v2|<bus-id>|<seq>` token that
    //     `agent-busctl watch --cursor` expects. The bus id is read from
    //     `bus_path` or derived from `message_id` (the stable `<bus-id>-<seq>`
    //     position), and the sequence from `seq` (falling back to the
    //     `message_id` suffix). Because a cursor needs BOTH a bus id and a
    //     sequence, a bare `seq` without any bus id — or a bare id without a
    //     sequence — yields nothing rather than a malformed cursor.
    check(
        "resume cursor from message_id+seq is the base64 v2|<bus>|<seq> token",
        extractCursorId({ message_id: "bus-1", seq: 1 }) === "djJ8YnVzfDE=",
    );
    check(
        "no cursor when a seq is present but no bus id is resolvable",
        extractCursorId({ seq: 42 }) === undefined,
    );
    check("no cursor id when neither field is present", extractCursorId({ text: "x" } as any) === undefined);

    // 2a-1. Realistic resume cursor: a message whose bus id is
    //     `bus-matv6xu7ronvdq7o.elastic-agent-1` (dot separator) at seq 100 is
    //     encoded as the exact base64 `v2|<bus-id>|<seq>` token the CLI accepts
    //     (`djJ8YnVzLW1hdHY2eHU3cm9udmRxN28uZWxhc3RpYy1hZ2VudC0xfDEwMA==`).
    const realisticBusId = "bus-matv6xu7ronvdq7o.elastic-agent-1";
    check(
        "a realistic message resumes at the base64 v2|<bus-id>|<seq> token",
        extractCursorId({
            message_id: `${realisticBusId}-100`,
            seq: 100,
        }) === "djJ8YnVzLW1hdHY2eHU3cm9udmRxN28uZWxhc3RpYy1hZ2VudC0xfDEwMA==",
    );
    // The bus_path field supplies the bus id directly (takes precedence over
    // the message_id-derived id) and combines with seq the same way.
    check(
        "bus_path supplies the bus id for the resume cursor",
        extractCursorId({
            message_id: "unrelated-99",
            bus_path: realisticBusId,
            seq: 100,
        }) === "djJ8YnVzLW1hdHY2eHU3cm9udmRxN28uZWxhc3RpYy1hZ2VudC0xfDEwMA==",
    );

    // 2a-2. Edge cases: a missing bus id OR a missing seq must yield no cursor
    //     (never a malformed token). buildResumeCursor is the shared helper so
    //     these guard both extraction paths.
    check("no cursor when the bus id is missing", extractCursorId({ seq: 100 } as any) === undefined);
    check("no cursor when the bus id is blank", extractCursorId({ message_id: "", seq: 100 } as any) === undefined);
    check("no cursor when the seq is missing", extractCursorId({ message_id: "nobus" } as any) === undefined);
    check(
        "buildResumeCursor yields nothing for a missing bus id",
        buildResumeCursor(undefined, 100) === undefined,
    );
    check(
        "buildResumeCursor yields nothing for a blank bus id",
        buildResumeCursor("  ", 100) === undefined,
    );
    check(
        "buildResumeCursor yields nothing for a missing seq",
        buildResumeCursor(realisticBusId, undefined) === undefined,
    );
    check(
        "buildResumeCursor yields nothing for a null seq",
        buildResumeCursor(realisticBusId, null as unknown as undefined) === undefined,
    );

    // 2b. Cursor capture advances to the LAST message that yields a valid
    //     cursor in a batch (arrival order = sequence order) and updates the
    //     in-process cursor. The trailing `{ seq: 99 }` record has no bus id, so
    //     it produces no cursor and the last captured value is bus-2's
    //     `v2|bus|2` resume token.
    const cursorCapture = captureAndPersistCursor([
        { message_id: "bus-1" },
        { message_id: "bus-2" },
        { seq: 99 },
    ] as AgentBusCtlWatchRecord[]);
    check("capturing a batch advances to the last message's cursor", getLastCursorId() === "djJ8YnVzfDI=");

    // 2c. Cursor persistence: saveCursor writes to a state file (atomic
    //     temp+rename) and loadCursor reads it back; a missing file yields no
    //     cursor and a malformed file yields a warning, never a throw.
    const cursorFile = join(dir, "bus-cursor.json");
    check("defaultBusCursorFilePath resolves beside the repo root", defaultBusCursorFilePath(dir) === cursorFile);
    check("saveCursor persists without diagnostic", saveCursor(cursorFile, "bus-77") === undefined);
    const loaded = loadCursor(cursorFile);
    check("loadCursor reads back the persisted cursor", loaded.cursor === "bus-77" && loaded.warnings.length === 0);
    check("loadCursor on a missing file yields no cursor", loadCursor(join(dir, "nope-cursor.json")).cursor === undefined);
    const malformedCursor = join(dir, "bad-cursor.json");
    writeFileSync(malformedCursor, "{ not json", "utf-8");
    const badLoad = loadCursor(malformedCursor);
    check(
        "loadCursor on a malformed file yields a warning, not a throw",
        badLoad.cursor === undefined && badLoad.warnings.length === 1 && /not valid JSON/.test(badLoad.warnings[0]),
    );

    // 2d. captureAndPersistCursor with a cursorFilePath both updates the
    //     in-process cursor AND persists it; persistence failures are surfaced
    //     as a diagnostic string, never thrown (in-memory tracking still works).
    const captureFile = join(dir, "persist-cursor.json");
    const persistDiag = captureAndPersistCursor([{ message_id: "bus-5" }] as AgentBusCtlWatchRecord[], captureFile);
    check("capture+p: no diagnostic on success", persistDiag === undefined);
    check("capture+p: persisted cursor is readable", loadCursor(captureFile).cursor === "djJ8YnVzfDU=");
    check("capture+p: in-memory cursor matches", getLastCursorId() === "djJ8YnVzfDU=");
    // A parent that is an existing FILE makes the recursive mkdir fail
    // (ENOTDIR), driving the fail-soft diagnostic path.
    const fileAsDir = join(dir, "not-a-dir");
    writeFileSync(fileAsDir, "x", "utf-8");
    const unwritable = join(fileAsDir, "cursor.json");
    const unwritableDiag = saveCursor(unwritable, "bus-6");
    check(
        "saveCursor surfaces an unwritable path as a diagnostic, not a throw",
        typeof unwritableDiag === "string" && /could not persist bus cursor/.test(unwritableDiag),
    );

    // 2e. A real watch pass that receives messages persists the cursor id when a
    //     cursorFilePath is supplied (the close handler wires cursor capture).
    const stubCursor = writeStubCtl(
        "ctl-cursor",
        [JSON.stringify({ message_id: "bus-1" }), JSON.stringify({ message_id: "bus-2" })].join("\n"),
        0,
    );
    const cursorWatchFile = join(dir, "watch-cursor.json");
    const cursorWatchResult = await watchAgentBusOnce({
        binary: stubCursor,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
        cursorFilePath: cursorWatchFile,
    });
    check(
        "a watch that receives messages persists the last message's cursor",
        !cursorWatchResult.error &&
            Array.isArray(cursorWatchResult.body) &&
            (cursorWatchResult.body as AgentBusCtlWatchRecord[]).length === 2 &&
            loadCursor(cursorWatchFile).cursor === "djJ8YnVzfDI=",
    );

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

    // 5a. CURSOR RESUME — in-memory cursor: after a poll that captured a cursor
    //     id in memory (getLastCursorId()), the NEXT poll must pass `--cursor
    //     <id>` to `agent-busctl watch` so it resumes rather than re-reading the
    //     retained window. A stub that records its argv proves the flag is
    //     supplied. The in-memory cursor is the base64 resume token for
    //     `v2|resume|42` (djJ8cmVzdW1lfDQy).
    const argvRecorder = join(dir, "ctl-argv-capture");
    writeFileSync(
        argvRecorder,
        [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(join(dir, "captured-args.json"))}, JSON.stringify(process.argv.slice(2)));`,
            // Emit the bounded-watch empty failure object so the read is a clean
            // "no messages" outcome (not a soft transport error) while the real
            // signal under test is the captured argv (--cursor flag).
            `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: false, kind: "empty", exit_code: 8 }))} + "\\n");`,
            "process.exit(8);",
        ].join("\n"),
        { mode: 0o755 },
    );
    chmodSync(argvRecorder, 0o755);
    // Reset to a known in-memory cursor for an unambiguous assertion.
    captureAndPersistCursor([{ message_id: "resume-42" }] as AgentBusCtlWatchRecord[]);
    const resumeResult = await watchAgentBusOnce({
        binary: argvRecorder,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
    });
    const capturedArgs = JSON.parse(
        (await import("node:fs")).readFileSync(join(dir, "captured-args.json"), "utf-8"),
    ) as string[];
    check(
        "subsequent poll passes --cursor with the in-memory cursor id",
        !resumeResult.error &&
            capturedArgs.includes("--cursor") &&
            capturedArgs[capturedArgs.indexOf("--cursor") + 1] === "djJ8cmVzdW1lfDQy",
    );

    // 5b. CURSOR RESUME — persisted cursor file: with NO in-memory cursor but a
    //     cursorFilePath that holds a saved cursor, the poll loads it and passes
    //     `--cursor <id>`. A missing file yields NO --cursor flag (first run).
    //     Reset the in-memory cursor to undefined to isolate the file source.
    clearInMemoryCursor();
    const resumeFile = join(dir, "resume-cursor.json");
    saveCursor(resumeFile, "resume-file-7");
    const resumeFileResult = await watchAgentBusOnce({
        binary: argvRecorder,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
        cursorFilePath: resumeFile,
    });
    const capturedFromFile = JSON.parse(
        (await import("node:fs")).readFileSync(join(dir, "captured-args.json"), "utf-8"),
    ) as string[];
    check(
        "a poll with a persisted cursor file passes --cursor from the file",
        !resumeFileResult.error &&
            capturedFromFile.includes("--cursor") &&
            capturedFromFile[capturedFromFile.indexOf("--cursor") + 1] === "resume-file-7",
    );

    // 5c. CURSOR RESUME — no cursor anywhere: when neither an in-memory cursor
    //     nor a persisted cursor exists, the poll must NOT pass --cursor.
    clearInMemoryCursor();
    const freshCursorFile = join(dir, "fresh-cursor.json"); // does not exist -> no cursor
    const noCursorResult = await watchAgentBusOnce({
        binary: argvRecorder,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
        cursorFilePath: freshCursorFile,
    });
    const capturedNoCursor = JSON.parse(
        (await import("node:fs")).readFileSync(join(dir, "captured-args.json"), "utf-8"),
    ) as string[];
    check(
        "a poll with no cursor anywhere omits the --cursor flag",
        !noCursorResult.error && !capturedNoCursor.includes("--cursor"),
    );

    // 5d. resolveStartCursorId precedence: in-memory cursor wins over a
    //     persisted file cursor; a persisted file cursor is used when there is
    //     no in-memory cursor; and "none" when neither exists. The in-memory
    //     cursor is the base64 token for `v2|mem|1` (djJ8bWVtfDE=).
    captureAndPersistCursor([{ message_id: "mem-1" }] as AgentBusCtlWatchRecord[]);
    const memVsFile = resolveStartCursorId(resumeFile);
    check(
        "resolveStartCursorId prefers the in-memory cursor over the file cursor",
        memVsFile.cursor === "djJ8bWVtfDE=" && memVsFile.source === "memory",
    );
    clearInMemoryCursor();
    const fileOnly = resolveStartCursorId(resumeFile);
    check(
        "resolveStartCursorId uses the file cursor when no in-memory cursor",
        fileOnly.cursor === "resume-file-7" && fileOnly.source === "file",
    );
    const noneOnly = resolveStartCursorId(freshCursorFile);
    check(
        "resolveStartCursorId yields none when no cursor is available",
        noneOnly.cursor === undefined && noneOnly.source === "none",
    );
    // Re-establish a known in-memory cursor (the base64 token for `v2|bus|1`,
    // djJ8YnVzfDE=) for the remaining tests. Its exact value is not asserted
    // downstream, but a definite value keeps later assertions deterministic.
    captureAndPersistCursor([{ message_id: "bus-1" }] as AgentBusCtlWatchRecord[]);

    // 5e. INVALID-CURSOR DIAGNOSTIC: the isInvalidCursorFailure helper must spot
    //     a cursor-rejection phrase in any of the supplied signals (stderr text
    //     or the closing failure object), case-insensitively, and ignore
    //     unrelated failure text.
    check(
        "isInvalidCursorFailure flags an 'invalid cursor' diagnostic",
        isInvalidCursorFailure("agent-busctl: invalid cursor: stuck at 100") === true,
    );
    check(
        "isInvalidCursorFailure flags a trailing failure object's invalid-cursor message",
        isInvalidCursorFailure(JSON.stringify({ ok: false, error: "invalid cursor" })) === true,
    );
    check(
        "isInvalidCursorFailure is case-insensitive",
        isInvalidCursorFailure("Invalid Cursor") === true,
    );
    check(
        "isInvalidCursorFailure ignores unrelated failures",
        isInvalidCursorFailure("could not connect: ECONNREFUSED") === false,
    );
    check("isInvalidCursorFailure ignores undefined signals", isInvalidCursorFailure(undefined) === false);

    // 5f. CURSOR RETRY — when a watch launched WITH a resume cursor fails because
    //     the CLI rejects the cursor as invalid, the poll must retry the watch
    //     WITHOUT --cursor and surface the retry's result (so a stale/pruned
    //     cursor never hard-stalls a poll). A stub that fails with "invalid
    //     cursor" only when --cursor is present, and otherwise emits a real
    //     message, proves both the retry happens and its result is returned.
    const retryStub = join(dir, "ctl-invalid-cursor-retry");
    writeFileSync(
        retryStub,
        [
            "#!/usr/bin/env node",
            "const hasCursor = process.argv.includes('--cursor');",
            // With a cursor: reject it (emit the closing failure object carrying
            // the diagnostic from a non-zero process). Without a cursor: emit a
            // genuine message so the retried poll has a body to return.
            "if (hasCursor) {",
            "  process.stderr.write('agent-busctl: invalid cursor\\n');",
            `  process.stdout.write(${JSON.stringify(JSON.stringify({ ok: false, error: "invalid cursor", exit_code: 4 }))} + "\\n");`,
            "  process.exit(4);",
            "} else {",
            `  process.stdout.write(${JSON.stringify(JSON.stringify({ message_id: "retried-1", text: "after-retry" }))} + "\\n");`,
            "  process.exit(0);",
            "}",
        ].join("\n"),
        { mode: 0o755 },
    );
    chmodSync(retryStub, 0o755);
    // An in-memory cursor must be present so the first attempt passes --cursor.
    captureAndPersistCursor([{ message_id: "stale-7" }] as AgentBusCtlWatchRecord[]);
    const retryResult = await watchAgentBusOnce({
        binary: retryStub,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
    });
    check(
        "an invalid-cursor watch is retried WITHOUT --cursor and its result is returned",
        !retryResult.error &&
            Array.isArray(retryResult.body) &&
            (retryResult.body as AgentBusCtlWatchRecord[]).length === 1 &&
            (retryResult.body as AgentBusCtlWatchRecord[])[0].text === "after-retry",
    );

    // 5g. CURSOR RETRY — a non-cursor failure must NOT trigger the retry: the
    //     single failed attempt's error is returned as-is (no second spawn).
    //     A stub that always fails with an unrelated error proves we don't
    //     double-run or mask genuine transport failures.
    const noRetryStub = join(dir, "ctl-no-retry");
    writeFileSync(
        noRetryStub,
        '#!/usr/bin/env node\nprocess.stderr.write("could not connect: ECONNREFUSED\\n");\nprocess.exit(5);\n',
        { mode: 0o755 },
    );
    chmodSync(noRetryStub, 0o755);
    captureAndPersistCursor([{ message_id: "keep-3" }] as AgentBusCtlWatchRecord[]);
    const noRetryResult = await watchAgentBusOnce({
        binary: noRetryStub,
        busUrl: "https://127.0.0.1:18090",
        identityStore: join(dir, "ident"),
    });
    check(
        "a non-invalid-cursor watch failure is returned as-is (no retry)",
        typeof noRetryResult.error === "string" && /exit 5/.test(noRetryResult.error),
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
