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

console.log("Tool-call renderer fixtures passed.");
