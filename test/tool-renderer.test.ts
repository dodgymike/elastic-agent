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

console.log("Tool-call renderer fixtures passed.");
