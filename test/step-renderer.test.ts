// Focused isolated fixtures for the plan-step pretty-printer (step-renderer.ts).
// Compiled and executed standalone by the `test:step-renderer` npm script.
// FORCE_COLOR is set by the npm script so chalk emits ANSI codes deterministically
// even when the test runs without a TTY (the plain-mode cases never call chalk).
import { buildPrettyStepLines } from "../step-renderer.js";
import assert from "node:assert/strict";

function assertLines(actual: string[], expected: string[]): void {
    assert.deepStrictEqual(actual, expected);
}

// chalk 4 constant open/close sequences (FORCE_COLOR=1).
const CYAN_OPEN = "\u001b[36m", YELLOW_BOLD_OPEN = "\u001b[33m\u001b[1m", CYAN_BOLD_OPEN = "\u001b[36m\u001b[1m";
const BOLD_CLOSE = "\u001b[22m", CLOSE = "\u001b[39m";

// 1. Plain (non-TTY) rendering: no ANSI escapes, ASCII glyphs, full description.
{
    const baseStep = "A long step description that must never be truncated, and runs well beyond eighty characters so no truncation is silently applied even for very long plan steps.";
    const lines = buildPrettyStepLines(0, 3, baseStep, { color: false, remainingSteps: ["second", "third"] });
    assertLines(lines, [
        "-- Step 1/3 -- in progress --",
        `   ${baseStep}`,
        "   -> Next: second",
    ]);
    assert.ok(lines.every((l) => !l.includes("\u001b")), "plain output must contain no ANSI escapes");
    assert.ok(lines.every((l) => !l.includes("─") && !l.includes("→") && !l.includes("—")), "plain output must use ASCII glyphs");
    assert.ok(lines[1].includes("eighty") && lines[1].length > 80, "step description must be full and untruncated");
}

// 2. Colored (TTY) rendering: includes ANSI escapes and box-drawing/arrow glyphs.
{
    const lines = buildPrettyStepLines(0, 2, "Do the first thing", { color: true, remainingSteps: ["Do the second thing"] });
    assert.ok(lines[0].startsWith(`${YELLOW_BOLD_OPEN}──${BOLD_CLOSE}${CLOSE} ${CYAN_BOLD_OPEN}Step 1/2${BOLD_CLOSE}${CLOSE}`), "step number should be bold cyan");
    assert.ok(lines[0].includes("in progress"), "status tag present");
    assert.ok(lines[2].startsWith(`   ${CYAN_OPEN}→ Next:${CLOSE}`) && lines[2].endsWith("Do the second thing"), "next hint colored");
    assertLines(lines.slice(1, 2), ["   Do the first thing"]);
}

// 3. Last step: no next-step hint.
{
    const lines = buildPrettyStepLines(2, 3, "Final step", { color: false, remainingSteps: [] });
    assertLines(lines, ["-- Step 3/3 -- in progress --", "   Final step"]);
    assert.ok(!lines.some((l) => l.includes("Next")), "no next hint for the final step");
}

// 4. Single-step plan: step 1/1, no next hint (colored header exact match).
{
    const lines = buildPrettyStepLines(0, 1, "Solo step", { color: true, remainingSteps: [] });
    assertLines(lines, [
        `${YELLOW_BOLD_OPEN}──${BOLD_CLOSE}${CLOSE} ${CYAN_BOLD_OPEN}Step 1/1${BOLD_CLOSE}${CLOSE} ${YELLOW_BOLD_OPEN}—${BOLD_CLOSE}${CLOSE} ${YELLOW_BOLD_OPEN}in progress${BOLD_CLOSE}${CLOSE} ${YELLOW_BOLD_OPEN}──${BOLD_CLOSE}${CLOSE}`,
        "   Solo step",
    ]);
}

// 5. remainingSteps omitted entirely behaves like no remaining steps.
{
    const lines = buildPrettyStepLines(0, 2, "Step A", { color: false });
    assertLines(lines, ["-- Step 1/2 -- in progress --", "   Step A"]);
}

// 6. Multi-line / large step description is surfaced verbatim on one indented line.
{
    const big = "line one\nline two\nline three\n".repeat(40); // multi-line, >1KB
    const lines = buildPrettyStepLines(1, 4, big, { color: false, remainingSteps: ["next"] });
    assertLines([lines[1]], [`   ${big}`]);
}

console.log("Plan-step pretty-printer fixtures passed.");
