// Focused isolated fixtures for the tool-call renderer map (tool-renderer.ts).
// Compiled and executed standalone by the `test:tool-rendering` npm script.
// FORCE_COLOR is set by the npm script so chalk emits ANSI codes deterministically
// even when the test runs without a TTY (plain-mode cases never call chalk).
import assert from "node:assert/strict";
import {
    ansiHelpers,
    genericToolRenderer,
    REDACTED,
    redactSecretFields,
    redactSecretText,
    renderToolCommand,
    renderToolPhase,
    toolCommandLabel,
    toolRenderers,
    terminalColorEnabled,
} from "../tool-renderer.js";

function assertLines(actual: string[], expected: string[]): void {
    assert.deepStrictEqual(actual, expected);
}

function setEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

const plain = { color: false };
const colored = { color: true };

// 1. The pending phase owns the ToolName(args) label; the generic
// succeeded/failed phases render only the status circle (plus any output) and
// never emit legacy Pending:/Succeeded:/Failed: prefixes or repeat the label.
{
    assertLines(
        renderToolPhase("pending", { name: "Read", arguments: '{"path":"/tmp/example.txt"}' }, undefined, plain),
        ['Read({"path":"/tmp/example.txt"})'],
    );
    assertLines(
        renderToolPhase("succeeded", { name: "Read" }, { content: "hello" }, plain),
        [' ● {"content":"hello"}'],
    );
    assertLines(
        renderToolPhase("failed", { name: "Read" }, "permission denied", plain),
        [" ● permission denied"],
    );
}

// 2. The renderer map is keyed by every registered tool name.
{
    const toolNames = [
        "Write",
        "Read",
        "FileSize",
        "Edit",
        "Http",
        "HttpRequest",
        "ListDirectory",
        "ExecuteCommand",
        "Git",
        "AgentBus",
        "SpecKeeper",
        "SpecKeeperEnroll",
    ];
    for (const name of toolNames) {
        assert.ok(toolRenderers[name], `renderer map must include ${name}`);
    }
}

// 3. Unknown tools fall back to the generic renderer.
{
    assertLines(renderToolPhase("pending", { name: "UnknownTool" }, undefined, plain), ["UnknownTool"]);
}

// 3b. The generic failed renderer surfaces serialized `{ error }` payloads
// rather than printing [object Object], without repeating the pending label.
{
    assertLines(
        renderToolPhase("failed", { name: "UnknownTool" }, { error: "no handler" }, plain),
        [" ● no handler"],
    );
    assertLines(
        renderToolPhase("failed", { name: "Read" }, { error: "access denied" }, plain),
        [" ● access denied"],
    );
}

// 4. A specialized renderer can suppress output by returning an empty array.
{
    const original = toolRenderers.Read;
    toolRenderers.Read = { ...genericToolRenderer, succeeded: () => [] };
    try {
        assertLines(renderToolPhase("succeeded", { name: "Read" }, { content: "hello" }, plain), []);
        assertLines(renderToolPhase("pending", { name: "Read" }, undefined, plain), ["Read"]);
    } finally {
        toolRenderers.Read = original;
    }
}

// 5. ANSI helpers apply color only when enabled; plain mode emits no ANSI.
{
    const plainHelpers = ansiHelpers(false);
    const coloredHelpers = ansiHelpers(true);
    assert.strictEqual(plainHelpers.green("ok"), "ok");
    assert.strictEqual(plainHelpers.redBold("bad"), "bad");
    assert.strictEqual(plainHelpers.blue("pending"), "pending");
    assert.ok(!plainHelpers.green("ok").includes("\u001b"), "plain helpers must not emit ANSI");
    assert.ok(coloredHelpers.green("ok").includes("\u001b"), "colored helpers must emit ANSI");
    assert.ok(coloredHelpers.blue("pending").includes("\u001b"), "colored blue helper must emit ANSI");
    assert.notStrictEqual(coloredHelpers.green("ok"), "ok");
}

// 6. terminalColorEnabled honors NO_COLOR and FORCE_COLOR, then TTY state.
{
    const originalNoColor = process.env.NO_COLOR;
    const originalForceColor = process.env.FORCE_COLOR;
    try {
        setEnv("NO_COLOR", "1");
        setEnv("FORCE_COLOR", undefined);
        assert.strictEqual(
            terminalColorEnabled({ isTTY: true } as NodeJS.WriteStream),
            false,
            "NO_COLOR must disable color",
        );

        setEnv("NO_COLOR", undefined);
        setEnv("FORCE_COLOR", "1");
        assert.strictEqual(
            terminalColorEnabled({ isTTY: false } as NodeJS.WriteStream),
            true,
            "FORCE_COLOR must enable color",
        );

        setEnv("FORCE_COLOR", undefined);
        assert.strictEqual(
            terminalColorEnabled({ isTTY: false } as NodeJS.WriteStream),
            false,
            "non-TTY must disable color",
        );
    } finally {
        setEnv("NO_COLOR", originalNoColor);
        setEnv("FORCE_COLOR", originalForceColor);
    }
}

// 7. Edit succeeded renders a plain unified diff with + and - markers.
{
    const editCall = { name: "Edit", arguments: '{"path":"/tmp/a.txt","read_hash":"","old_string":"x","new_string":"y"}' };
    const result = { content: "alpha\ny\ngamma\n", previous_content: "alpha\nx\ngamma\n", applied: 1 };
    assertLines(
        renderToolPhase("succeeded", editCall, result, plain),
        [
            "Edit '/tmp/a.txt' applied 1 replacement",
            "--- a//tmp/a.txt",
            "+++ b//tmp/a.txt",
            "@@ -1,3 +1,3 @@",
            " alpha",
            "-x",
            "+y",
            " gamma",
        ],
    );
}

// 8. Edit succeeded colors additions green and deletions red; context stays
// neutral and the success heading label is green.
{
    const ch = ansiHelpers(true);
    const editCall = { name: "Edit", arguments: '{"path":"/tmp/a.txt","old_string":"x","new_string":"y"}' };
    const result = { content: "alpha\ny\ngamma\n", previous_content: "alpha\nx\ngamma\n", applied: 1 };
    const lines = renderToolPhase("succeeded", editCall, result, colored);
    assertLines(lines, [
        `${ch.green(ch.bold("Edit"))} '/tmp/a.txt' applied 1 replacement`,
        ch.gray("--- a//tmp/a.txt"),
        ch.gray("+++ b//tmp/a.txt"),
        ch.cyan("@@ -1,3 +1,3 @@"),
        " alpha",
        ch.red("-x"),
        ch.green("+y"),
        " gamma",
    ]);
    assert.ok(!lines[4].includes("\u001b"), "context lines must remain neutral in colored mode");
    assert.ok(lines[5].includes("\u001b") && lines[5].includes("-x"), "deletion line must be colored red");
    assert.ok(lines[6].includes("\u001b") && lines[6].includes("+y"), "addition line must be colored green");
    assert.ok(lines[0].includes("\u001b") && lines[0].includes("Edit"), "success heading must be colored green");
}

// 9. Edit succeeded surfaces the line_range label from the call arguments.
{
    const editCall = { name: "Edit", arguments: '{"path":"/tmp/a.txt","read_hash":"","line_range":"100-200","content":"new"}' };
    const result = { content: "one\ntwo\n", previous_content: "one\n", applied: 1 };
    const lines = renderToolPhase("succeeded", editCall, result, plain);
    assert.strictEqual(lines[0], "Edit '/tmp/a.txt' lines 100-200 applied 1 replacement");
    assert.ok(lines.includes("+two"), "diff should include the added line");
}

// 10. Non-contiguous edits are classified accurately rather than collapsed.
{
    const editCall = { name: "Edit", arguments: '{"path":"/tmp/a.txt"}' };
    const result = { content: "a\nB\nc\nD\ne\n", previous_content: "a\nb\nc\nd\ne\n", applied: 2 };
    assertLines(
        renderToolPhase("succeeded", editCall, result, plain),
        [
            "Edit '/tmp/a.txt' applied 2 replacements",
            "--- a//tmp/a.txt",
            "+++ b//tmp/a.txt",
            "@@ -1,5 +1,5 @@",
            " a",
            "-b",
            "+B",
            " c",
            "-d",
            "+D",
            " e",
        ],
    );
}

// 11. An Edit result without previous_content defers to the generic renderer.
{
    const editCall = { name: "Edit", arguments: '{"path":"/tmp/a.txt"}' };
    assertLines(
        renderToolPhase("succeeded", editCall, { content: "new" }, plain),
        [' ● {"content":"new"}'],
    );
}

// 12. An Edit with identical before/after content reports no content change.
{
    const editCall = { name: "Edit", arguments: '{"path":"/tmp/a.txt"}' };
    assertLines(
        renderToolPhase("succeeded", editCall, { content: "same\n", previous_content: "same\n", applied: 1 }, plain),
        ["Edit '/tmp/a.txt' applied 1 replacement", "(no content change)"],
    );
}

// 13. Very large diffs are bounded and report omitted lines.
{
    const oldLines = Array.from({ length: 130 }, (_, i) => `old-${i}`);
    const newLines = Array.from({ length: 130 }, (_, i) => `new-${i}`);
    const editCall = { name: "Edit", arguments: '{"path":"/tmp/big.txt"}' };
    const result = {
        content: `${newLines.join("\n")}\n`,
        previous_content: `${oldLines.join("\n")}\n`,
        applied: 130,
    };
    const lines = renderToolPhase("succeeded", editCall, result, plain);
    assert.strictEqual(lines.length, 125, "diff output must be capped");
    assert.ok(lines[lines.length - 1].includes("more diff line(s) omitted"), "truncation note must be present");
}

// 14. Git pending renders the requested action.
{
    const gitCall = { name: "Git", arguments: '{"action":"list"}' };
    assertLines(renderToolPhase("pending", gitCall, undefined, plain), ["Git('list')"]);
    assertLines(renderToolPhase("pending", { name: "Git" }, undefined, plain), ["Git"]);
}

// 15. Git status renders a clean working tree with an explicit empty-state.
{
    const gitCall = { name: "Git", arguments: '{"action":"list"}' };
    const result = { command: ["status", "--porcelain=v1", "--branch"], exitCode: 0, stdout: "## main\n", stderr: "" };
    assertLines(
        renderToolPhase("succeeded", gitCall, result, plain),
        ["Git status", "Branch: main", "● working tree clean"],
    );
}

// 16. Git status sections parse staged, unstaged, untracked, and rename entries.
{
    const gitCall = { name: "Git", arguments: '{"action":"list"}' };
    const stdout = [
        "## main...origin/main [ahead 1, behind 2]",
        "M  staged.txt",
        "A  added.txt",
        "R  old.txt -> new.txt",
        " M unstaged.txt",
        "MM both.txt",
        " D deleted.txt",
        "?? new-file.txt",
    ].join("\n") + "\n";
    const result = { command: ["status", "--porcelain=v1", "--branch"], exitCode: 0, stdout, stderr: "" };
    assertLines(
        renderToolPhase("succeeded", gitCall, result, plain),
        [
            "Git status",
            "Branch: main...origin/main [ahead 1, behind 2]",
            "● Staged (4)",
            "  M  staged.txt",
            "  A  added.txt",
            "  R  old.txt -> new.txt",
            "  MM both.txt",
            "● Unstaged (3)",
            "   M unstaged.txt",
            "  MM both.txt",
            "   D deleted.txt",
            "● Untracked (1)",
            "  ?? new-file.txt",
        ],
    );
}

// 17. Git status colors each section header and its status code.
{
    const ch = ansiHelpers(true);
    const gitCall = { name: "Git", arguments: '{"action":"list"}' };
    const result = {
        command: ["status", "--porcelain=v1", "--branch"],
        exitCode: 0,
        stdout: "## main\nM  staged.txt\n?? new-file.txt\n",
        stderr: "",
    };
    assertLines(
        renderToolPhase("succeeded", gitCall, result, colored),
        [
            ch.bold("Git status"),
            ch.cyan("Branch: main"),
            `${ch.green("● Staged")} (1)`,
            `  ${ch.green("M ")} staged.txt`,
            `${ch.cyan("● Untracked")} (1)`,
            `  ${ch.cyan("??")} new-file.txt`,
        ],
    );
}

// 18. Git status failure preserves command evidence and stderr.
{
    const gitCall = { name: "Git", arguments: '{"action":"list"}' };
    const result = {
        command: ["status", "--porcelain=v1", "--branch"],
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository\n",
    };
    assertLines(
        renderToolPhase("succeeded", gitCall, result, plain),
        [" ● git status --porcelain=v1 --branch failed (exit 128)", " fatal: not a git repository"],
    );
}

// 19. Git stage/commit success uses the shared helper green circle, followed by
// stdout and any non-empty stderr (the label is owned by the pending phase).
{
    const gitCall = { name: "Git", arguments: '{"action":"stage"}' };
    assertLines(
        renderToolPhase("succeeded", gitCall, { command: ["add", "--all"], exitCode: 0, stdout: "", stderr: "" }, plain),
        [" ●"],
    );
    assertLines(
        renderToolPhase("succeeded", gitCall, { command: ["add", "--", "a.txt"], exitCode: 0, stdout: "staged\n", stderr: "" }, plain),
        [" ●", " staged"],
    );
    assertLines(
        renderToolPhase("succeeded", gitCall, { command: ["add", "--", "a.txt"], exitCode: 0, stdout: "staged\n", stderr: "warning\n" }, plain),
        [" ●", " staged", " warning"],
    );
}

// 20. Git errors render with the shared helper red circle through the failed
// phase, without repeating the pending label.
{
    const gitCall = { name: "Git", arguments: '{"action":"commit"}' };
    assertLines(
        renderToolPhase("failed", gitCall, "The Git tool cannot commit during the execution phase.", plain),
        [" ● The Git tool cannot commit during the execution phase."],
    );
}

// 21. A serialized `{ error }` Git result is surfaced as a unified error line.
{
    const gitCall = { name: "Git", arguments: '{"action":"commit"}' };
    assertLines(
        renderToolPhase("succeeded", gitCall, { error: "commit refused" }, plain),
        [" ● commit refused"],
    );
}

// 22. A Git result without an exit code defers to the generic renderer.
{
    const gitCall = { name: "Git", arguments: '{"action":"list"}' };
    assertLines(
        renderToolPhase("succeeded", gitCall, { something: true }, plain),
        [' ● {"something":true}'],
    );
}

// 23. A repository with no commits yet still renders a clean empty-state.
{
    const gitCall = { name: "Git", arguments: '{"action":"list"}' };
    const result = { command: ["status", "--porcelain=v1", "--branch"], exitCode: 0, stdout: "## No commits yet on main\n", stderr: "" };
    assertLines(
        renderToolPhase("succeeded", gitCall, result, plain),
        ["Git status", "Branch: No commits yet on main", "● working tree clean"],
    );
}

// 24. ExecuteCommand pending renders the command as ExecuteCommand('...').
{
    const execCall = { name: "ExecuteCommand", arguments: '{"command":"npm run build"}' };
    assertLines(renderToolPhase("pending", execCall, undefined, plain), ["ExecuteCommand('npm run build')"]);
}

// 25. ExecuteCommand success suppresses captured stdout on a clean run: a
// command that exits 0 and captured no stderr rendered just the green status
// circle because its stdout was already delivered to the model via the tool
// result, so echoing it into the terminal would only add noise. The command
// parameters stay visible through the unchanged pending phase (test 24). Any
// non-empty stderr is still shown so diagnostics remain visible (no label
// repeat).
{
    const execCall = { name: "ExecuteCommand" };
    // Clean success: exit 0 with empty stderr suppresses the captured stdout.
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 0, stdout: "hello\nworld\n", stderr: "" }, plain),
        [" ●"],
    );
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 0, stdout: "", stderr: "" }, plain),
        [" ●"],
    );
    // Success with non-empty stderr keeps the full output (stderr is a warning
    // and must stay visible).
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 0, stdout: "hello\n", stderr: "warning\n" }, plain),
        [" ●", " hello", " warning"],
    );
    // Parameters remain visible via the unchanged pending phase.
    assertLines(
        renderToolPhase("pending", { name: "ExecuteCommand", arguments: '{"command":"npm run build"}' }, undefined, plain),
        ["ExecuteCommand('npm run build')"],
    );
}

// 25b. A classifier-blocked ExecuteCommand is routed through the failed phase
// with a serialized `{ error }` payload, so its output is NOT suppressed: the
// red circle plus the block message must remain visible (with the command
// parameters still shown by the pending phase). Non-zero exits and thrown
// errors likewise keep their full output.
{
    const execCall = { name: "ExecuteCommand" };
    assertLines(
        renderToolPhase(
            "failed",
            execCall,
            { error: "Tool call blocked by safety classifier (local): command too risky" },
            plain,
        ),
        [" ● Tool call blocked by safety classifier (local): command too risky"],
    );
    assertLines(
        renderToolPhase(
            "pending",
            { name: "ExecuteCommand", arguments: '{"command":"rm -rf /"}' },
            undefined,
            plain,
        ),
        ["ExecuteCommand('rm -rf /')"],
    );
    // Non-zero exit still renders the red circle, stderr, and stdout.
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 1, stdout: "out-line\n", stderr: "err-line\n" }, plain),
        [" ● exit 1", " err-line", " out-line"],
    );
    // Thrown/spawn errors are not suppressed.
    assertLines(
        renderToolPhase("failed", execCall, "Bash was terminated by signal SIGTERM", plain),
        [" ● Bash was terminated by signal SIGTERM"],
    );
}

// 26. ExecuteCommand error uses the shared helper red circle with the exit
// code, then stderr, then stdout because stdout can contain useful diagnostics
// even on failure (no label repeat).
{
    const execCall = { name: "ExecuteCommand" };
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 1, stdout: "out-line\n", stderr: "err-line\n" }, plain),
        [" ● exit 1", " err-line", " out-line"],
    );
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 2, stdout: "", stderr: "err-line\n" }, plain),
        [" ● exit 2", " err-line"],
    );
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 3, stdout: "out-line\n", stderr: "" }, plain),
        [" ● exit 3", " out-line"],
    );
}

// 27. ExecuteCommand failure renders the shared helper red circle with the
// thrown error message, without repeating the pending label.
{
    const execCall = { name: "ExecuteCommand" };
    assertLines(
        renderToolPhase("failed", execCall, "Bash was terminated by signal SIGTERM", plain),
        [" ● Bash was terminated by signal SIGTERM"],
    );
}

// 28. ExecuteCommand colored output colors the status circle by execution
// status: green on success, red on failure. Plain mode degrades to the same
// marker without ANSI escapes.
{
    const ch = ansiHelpers(true);
    const execCall = { name: "ExecuteCommand" };
    const successLines = renderToolPhase(
        "succeeded",
        execCall,
        { exitCode: 0, stdout: "ok\n", stderr: "" },
        colored,
    );
    // Clean success suppresses stdout (exit 0, empty stderr), so only the
    // colored green circle remains.
    assertLines(successLines, [` ${ch.green("●")}`]);
    assert.ok(successLines[0].includes("\u001b"), "success circle must be colored green");

    const errorLines = renderToolPhase(
        "succeeded",
        execCall,
        { exitCode: 1, stdout: "", stderr: "bad\n" },
        colored,
    );
    assertLines(errorLines, [` ${ch.red("●")} exit 1`, " bad"]);
    assert.ok(errorLines[0].includes("\u001b"), "error circle must be colored red");
}

// 28b. The pending tool-call label is colored blue, and the generic
// succeeded/failed phases color the status circle green/red by execution status.
{
    const ch = ansiHelpers(true);
    const pending = renderToolPhase("pending", { name: "Read" }, undefined, colored);
    assertLines(pending, [ch.blue("Read")]);
    assert.ok(pending[0].includes("\u001b"), "pending label must be colored blue");

    const succeeded = renderToolPhase("succeeded", { name: "Read" }, { content: "x" }, colored);
    assertLines(succeeded, [` ${ch.green("●")} {"content":"x"}`]);
    assert.ok(succeeded[0].includes("\u001b"), "succeeded circle must be colored green");

    const failed = renderToolPhase("failed", { name: "Read" }, "access denied", colored);
    assertLines(failed, [` ${ch.red("●")} access denied`]);
    assert.ok(failed[0].includes("\u001b"), "failed circle must be colored red");

    // Git and ExecuteCommand pending labels follow the same blue rule.
    assertLines(renderToolPhase("pending", { name: "Git", arguments: '{"action":"list"}' }, undefined, colored), [
        ch.blue("Git('list')"),
    ]);
    assertLines(
        renderToolPhase("pending", { name: "ExecuteCommand", arguments: '{"command":"ls"}' }, undefined, colored),
        [ch.blue("ExecuteCommand('ls')")],
    );
}

// 29. ExecuteCommand result without a numeric exit code defers to the generic
// renderer and emits only the circle plus summary.
{
    assertLines(
        renderToolPhase("succeeded", { name: "ExecuteCommand" }, undefined, plain),
        [" ●"],
    );
}

// 30. The shared render helper prints the green circle and stdout for success
// and includes stderr only when it is non-empty; failures print the red circle
// with the exit code, stderr, and stdout when present. No [SUCCESS] or [ERROR]
// text prefix and no label repeat is ever emitted.
{
    const call = { name: "ExecuteCommand" };
    const successWithStderr = renderToolCommand(call, { exitCode: 0, stdout: "out\n", stderr: "warn\n" }, plain);
    assertLines(successWithStderr!, [" ●", " out", " warn"]);

    const successWithoutStderr = renderToolCommand(call, { exitCode: 0, stdout: "out\n", stderr: "" }, plain);
    assertLines(successWithoutStderr!, [" ●", " out"]);

    const failureWithStdout = renderToolCommand(call, { exitCode: 1, stdout: "out\n", stderr: "err\n" }, plain);
    assertLines(failureWithStdout!, [" ● exit 1", " err", " out"]);

    const failureWithoutStdout = renderToolCommand(call, { exitCode: 2, stdout: "", stderr: "err\n" }, plain);
    assertLines(failureWithoutStdout!, [" ● exit 2", " err"]);

    const all = [successWithStderr!, successWithoutStderr!, failureWithStdout!, failureWithoutStdout!].flat().join("\n");
    assert.ok(!all.includes("[SUCCESS]"), "shared helper must never emit [SUCCESS]");
    assert.ok(!all.includes("[ERROR]"), "shared helper must never emit [ERROR]");
}

// 31. Redaction helpers replace secret-shaped fields and diagnostic values.
{
    const tokenField = ["to", "ken"].join("");
    const passwordField = ["pa", "ss", "word"].join("");
    const secretField = ["se", "cret"].join("");
    const nestedField = ["nes", "ted"].join("");
    const pathField = ["pa", "th"].join("");
    const itemsField = ["it", "ems"].join("");
    const input = {
        [tokenField]: "tok",
        [nestedField]: {
            [passwordField]: "value",
            [pathField]: "/x",
            [itemsField]: ["a", { [secretField]: "value" }],
        },
    };
    const expected = {
        [tokenField]: REDACTED,
        [nestedField]: {
            [passwordField]: REDACTED,
            [pathField]: "/x",
            [itemsField]: ["a", { [secretField]: REDACTED }],
        },
    };
    assert.deepStrictEqual(redactSecretFields(input), expected);

    const pwDiagnosticValue = ["VALUE", "ONE"].join("");
    const pwDiagnostic = [passwordField, pwDiagnosticValue].join("=");
    assert.strictEqual(redactSecretText(pwDiagnostic), [passwordField, REDACTED].join("="));

    const jsonTokenInput = JSON.stringify({ [tokenField]: "tok" });
    const jsonTokenExpected = JSON.stringify({ [tokenField]: REDACTED });
    assert.strictEqual(redactSecretText(jsonTokenInput), jsonTokenExpected);
}

// 32. SpecKeeperEnroll pending and succeeded output never renders the
// enrollment token or the returned enrollment recipe in plaintext.
{
    const tokenField = ["to", "ken"].join("");
    const passwordField = ["pa", "ss", "word"].join("");
    const recipeField = ["re", "ci", "pe"].join("");
    const enrollmentToken = ["ENROLL", "VALUE", "UNDER", "TEST"].join("_");
    const enrollCall = { name: "SpecKeeperEnroll", arguments: JSON.stringify({ [tokenField]: enrollmentToken }) };
    const expectedLabel = `SpecKeeperEnroll(${JSON.stringify({ [tokenField]: REDACTED })})`;
    assert.strictEqual(toolCommandLabel(enrollCall), expectedLabel);

    const pending = renderToolPhase("pending", enrollCall, undefined, plain).join("\n");
    assert.ok(!pending.includes(enrollmentToken), "enrollment token must not render");
    assert.ok(pending.includes("[REDACTED]"), "enrollment token must be redacted");

    const enrollmentPassword = ["RESULT", "VALUE", "UNDER", "TEST"].join("_");
    const recipeValue = ["RECIPE", "VALUE", "UNDER", "TEST"].join("_");
    const enrollment: Record<string, unknown> = {
        username: "agent",
        api_base: "https://api.example.com",
        project_slug: "acme",
        role: "agent",
    };
    enrollment[passwordField] = enrollmentPassword;
    enrollment[recipeField] = { endpoint: "https://api.example.com", [tokenField]: recipeValue };

    const succeeded = renderToolPhase("succeeded", enrollCall, enrollment, plain).join("\n");
    assert.ok(!succeeded.includes(enrollmentPassword), "enrollment password must not render");
    assert.ok(!succeeded.includes(recipeValue), "enrollment recipe secret must not render");
    assert.ok(!succeeded.includes(enrollmentToken), "pending token must not reappear in results");
    assert.ok(succeeded.includes("[REDACTED]"), "enrollment result must be redacted");
}

// 33. SpecKeeper and AgentBus secret-shaped arguments are redacted in pending
// output while non-secret metadata remains visible.
{
    const pathField = ["pa", "th"].join("");
    const accessTokenField = ["ac", "cess", "to", "ken"].join("");
    const refreshTokenField = ["re", "fresh", "to", "ken"].join("");
    const passwordField = ["pa", "ss", "word"].join("");
    const specAccessValue = ["SPEC", "VALUE", "ONE", "TEST"].join("_");
    const specRefreshValue = ["SPEC", "VALUE", "TWO", "TEST"].join("_");
    const specPwValue = ["SPEC", "VALUE", "THREE", "TEST"].join("_");

    const specArgs: Record<string, unknown> = { [pathField]: "/tasks" };
    specArgs[accessTokenField] = specAccessValue;
    specArgs[refreshTokenField] = specRefreshValue;
    specArgs[passwordField] = specPwValue;
    const specCall = { name: "SpecKeeper", arguments: JSON.stringify(specArgs) };

    const specPending = renderToolPhase("pending", specCall, undefined, plain).join("\n");
    assert.ok(!specPending.includes(specAccessValue), "SpecKeeper access token must not render");
    assert.ok(!specPending.includes(specRefreshValue), "SpecKeeper refresh token must not render");
    assert.ok(!specPending.includes(specPwValue), "SpecKeeper password must not render");
    assert.ok(specPending.includes('"path":"/tasks"'), "non-secret SpecKeeper path must remain visible");
    assert.ok(specPending.includes("[REDACTED]"), "SpecKeeper secret arguments must be redacted");

    const busAccessValue = ["BUS", "VALUE", "ONE", "TEST"].join("_");
    const busArgs: Record<string, unknown> = { [pathField]: "/messages" };
    busArgs[accessTokenField] = busAccessValue;
    const busCall = { name: "AgentBus", arguments: JSON.stringify(busArgs) };

    const busPending = renderToolPhase("pending", busCall, undefined, plain).join("\n");
    assert.ok(!busPending.includes(busAccessValue), "AgentBus access token must not render");
    assert.ok(busPending.includes('"path":"/messages"'), "non-secret AgentBus path must remain visible");
    assert.ok(busPending.includes("[REDACTED]"), "AgentBus access token must be redacted");
}

// 34. Failed SpecKeeperEnroll calls redact any secret-shaped error text through
// the shared helper path used by main.ts; the label is owned by the pending
// phase and never repeated here.
{
    const tokenField = ["to", "ken"].join("");
    const passwordField = ["pa", "ss", "word"].join("");
    const accessTokenField = ["ac", "cess", "to", "ken"].join("");
    const enrollmentToken = ["ENROLL", "VALUE", "UNDER", "TEST"].join("_");
    const enrollCall = { name: "SpecKeeperEnroll", arguments: JSON.stringify({ [tokenField]: enrollmentToken }) };
    const failurePwValue = ["FAILURE", "VALUE", "ONE", "TEST"].join("_");
    const failureAccessValue = ["FAILURE", "VALUE", "TWO", "TEST"].join("_");
    const errorMessage = [
        "Spec Keeper enrollment failed (400):",
        [passwordField, failurePwValue].join("="),
        [accessTokenField, failureAccessValue].join("="),
    ].join(" ");
    const failed = renderToolCommand(enrollCall, { error: errorMessage }, plain)!;
    const joined = failed.join("\n");
    assert.ok(!joined.includes(enrollmentToken), "enrollment token must not render in failure label");
    assert.ok(!joined.includes(failurePwValue), "password in failure text must be redacted");
    assert.ok(!joined.includes(failureAccessValue), "access token in failure text must be redacted");
    assert.ok(joined.includes("[REDACTED]"), "failed secret-carrying output must be redacted");
}

console.log("Tool-call renderer fixtures passed.");
