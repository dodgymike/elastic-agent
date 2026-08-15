// Focused isolated fixtures for the tool-call renderer map (tool-renderer.ts).
// Compiled and executed standalone by the `test:tool-rendering` npm script.
// FORCE_COLOR is set by the npm script so chalk emits ANSI codes deterministically
// even when the test runs without a TTY (plain-mode cases never call chalk).
import assert from "node:assert/strict";
import {
    ansiHelpers,
    genericToolRenderer,
    renderToolPhase,
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

// 1. The generic fallback preserves the historical pending/succeeded/failed text.
{
    assertLines(
        renderToolPhase("pending", { name: "Read", arguments: '{"path":"/tmp/example.txt"}' }, undefined, plain),
        ['Pending: Read {"path":"/tmp/example.txt"}'],
    );
    assertLines(
        renderToolPhase("succeeded", { name: "Read" }, { content: "hello" }, plain),
        ['Succeeded: Read → {"content":"hello"}'],
    );
    assertLines(
        renderToolPhase("failed", { name: "Read" }, "permission denied", plain),
        ["Failed: Read: permission denied"],
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
    assertLines(renderToolPhase("pending", { name: "UnknownTool" }, undefined, plain), ["Pending: UnknownTool"]);
}

// 4. A specialized renderer can suppress output by returning an empty array.
{
    const original = toolRenderers.Read;
    toolRenderers.Read = { ...genericToolRenderer, succeeded: () => [] };
    try {
        assertLines(renderToolPhase("succeeded", { name: "Read" }, { content: "hello" }, plain), []);
        assertLines(renderToolPhase("pending", { name: "Read" }, undefined, plain), ["Pending: Read"]);
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
    assert.ok(!plainHelpers.green("ok").includes("\u001b"), "plain helpers must not emit ANSI");
    assert.ok(coloredHelpers.green("ok").includes("\u001b"), "colored helpers must emit ANSI");
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

// 8. Edit succeeded colors additions green and deletions red; context stays neutral.
{
    const ch = ansiHelpers(true);
    const editCall = { name: "Edit", arguments: '{"path":"/tmp/a.txt","old_string":"x","new_string":"y"}' };
    const result = { content: "alpha\ny\ngamma\n", previous_content: "alpha\nx\ngamma\n", applied: 1 };
    const lines = renderToolPhase("succeeded", editCall, result, colored);
    assertLines(lines, [
        `${ch.bold("Edit")} '/tmp/a.txt' applied 1 replacement`,
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
        ['Succeeded: Edit → {"content":"new"}'],
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
        ["● git status --porcelain=v1 --branch failed (exit 128)", "fatal: not a git repository"],
    );
}

// 19. Git stage/commit success preserves the exact command.
{
    const gitCall = { name: "Git", arguments: '{"action":"stage"}' };
    assertLines(
        renderToolPhase("succeeded", gitCall, { command: ["add", "--all"], exitCode: 0, stdout: "", stderr: "" }, plain),
        ["● git add --all"],
    );
    assertLines(
        renderToolPhase("succeeded", gitCall, { command: ["add", "--", "a.txt"], exitCode: 0, stdout: "staged\n", stderr: "" }, plain),
        ["● git add -- a.txt", "staged"],
    );
}

// 20. Git errors render with a red circle through the failed phase.
{
    const gitCall = { name: "Git", arguments: '{"action":"commit"}' };
    assertLines(
        renderToolPhase("failed", gitCall, "The Git tool cannot commit during the execution phase.", plain),
        ["● The Git tool cannot commit during the execution phase."],
    );
}

// 21. A serialized `{ error }` Git result is surfaced as an error line.
{
    const gitCall = { name: "Git", arguments: '{"action":"commit"}' };
    assertLines(
        renderToolPhase("succeeded", gitCall, { error: "commit refused" }, plain),
        ["● commit refused"],
    );
}

// 22. A Git result without an exit code defers to the generic renderer.
{
    const gitCall = { name: "Git", arguments: '{"action":"list"}' };
    assertLines(
        renderToolPhase("succeeded", gitCall, { something: true }, plain),
        ['Succeeded: Git → {"something":true}'],
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

// 25. ExecuteCommand success shows a green circle with captured stdout only;
// empty stdout is suppressed to leave just the circle.
{
    const execCall = { name: "ExecuteCommand" };
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 0, stdout: "hello\nworld\n", stderr: "" }, plain),
        ["● hello", "world"],
    );
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 0, stdout: "", stderr: "" }, plain),
        ["●"],
    );
}

// 26. ExecuteCommand error shows the exit code, then stderr, then stdout
// because stdout can contain useful diagnostics even on failure.
{
    const execCall = { name: "ExecuteCommand" };
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 1, stdout: "out-line\n", stderr: "err-line\n" }, plain),
        ["● exit 1", "err-line", "out-line"],
    );
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 2, stdout: "", stderr: "err-line\n" }, plain),
        ["● exit 2", "err-line"],
    );
    assertLines(
        renderToolPhase("succeeded", execCall, { exitCode: 3, stdout: "out-line\n", stderr: "" }, plain),
        ["● exit 3", "out-line"],
    );
}

// 27. ExecuteCommand failure renders a red circle with the thrown error message.
{
    const execCall = { name: "ExecuteCommand" };
    assertLines(
        renderToolPhase("failed", execCall, "Bash was terminated by signal SIGTERM", plain),
        ["● Bash was terminated by signal SIGTERM"],
    );
}

// 28. ExecuteCommand colored output applies green/red circles; plain mode
// degrades to the same marker without ANSI escapes.
{
    const ch = ansiHelpers(true);
    const execCall = { name: "ExecuteCommand" };
    const successLines = renderToolPhase(
        "succeeded",
        execCall,
        { exitCode: 0, stdout: "ok\n", stderr: "" },
        colored,
    );
    assertLines(successLines, [`${ch.green("●")} ok`]);
    assert.ok(successLines[0].includes("\u001b"), "success circle must be colored green");

    const errorLines = renderToolPhase(
        "succeeded",
        execCall,
        { exitCode: 1, stdout: "", stderr: "bad\n" },
        colored,
    );
    assertLines(errorLines, [`${ch.red("●")} exit 1`, "bad"]);
    assert.ok(errorLines[0].includes("\u001b"), "error circle must be colored red");
}

// 29. ExecuteCommand result without a numeric exit code defers to the generic renderer.
{
    assertLines(
        renderToolPhase("succeeded", { name: "ExecuteCommand" }, undefined, plain),
        ["Succeeded: ExecuteCommand"],
    );
}

console.log("Tool-call renderer fixtures passed.");
