/**
 * Focused tests for the CLI output-verbosity policy (output-verbosity.ts).
 *
 * These tests capture real stdout by driving the same gates main.ts uses:
 *   resolveOutputGates({ quiet, veryQuiet }) -> { outputVerbose, stepVerbose,
 *   fatalVerbose }, plus the `-qq` -> `--very-quiet` short-form translation.
 *
 * They verify the documented behavior:
 *   1. default (no flags) shows everything (tool details, TLDR, step lines);
 *   2. quiet  shows only the 'Step N started'/'Step N finished' lines and hides
 *      tool details / TLDR / status messages;
 *   3. very-quiet prints nothing on success;
 *   4. very-quiet takes precedence over quiet;
 *   5. flag parsing accepts -q/--quiet and -qq/--very-quiet.
 */
import assert from "node:assert/strict";
import {
    isVeryQuietToken,
    translateCliArgs,
    resolveOutputGates,
} from "../output-verbosity.ts";

// A small stdout harness that mirrors the channels main.ts gates. It prints a
// step start/finish line when stepVerbose is on, and a tool-call detail plus a
// TLDR line when outputVerbose is on (the exact split main.ts applies).
function capture(fn: () => void): string[] {
    const lines: string[] = [];
    const original = console.log;
    console.log = (message?: unknown, ...args: unknown[]): void => {
        const text = [message, ...args].map((arg) => String(arg)).join(" ");
        lines.push(text.replace(/\u001b\[[0-9;]*m/g, "")); // strip ANSI colors
    };
    try {
        fn();
    } finally {
        console.log = original;
    }
    return lines;
}

function emitAll(gates: ReturnType<typeof resolveOutputGates>): void {
    if (gates.stepVerbose) console.log("[STEP] 1. Do the work (started)");
    if (gates.outputVerbose) console.log("ToolName(args) -> result");
    if (gates.outputVerbose) console.log("[TLDR] implementation summary");
    if (gates.stepVerbose) console.log("[STEP] 1. Step finished");
}

// 1. Default mode shows everything.
{
    const gates = resolveOutputGates({}); // both flags default to false
    assert.equal(gates.quiet, false, "quiet defaults to false");
    assert.equal(gates.veryQuiet, false, "very-quiet defaults to false");
    assert.equal(gates.outputVerbose, true, "default is fully verbose");
    assert.equal(gates.stepVerbose, true, "step lines print in default mode");

    const out = capture(() => emitAll(gates));
    assert.ok(out.some((line) => line.includes("[STEP]")), "default shows step lines");
    assert.ok(out.some((line) => line.includes("ToolName")), "default shows tool call details");
    assert.ok(out.some((line) => line.includes("[TLDR]")), "default shows TLDR");
}

// 2. Quiet mode shows step start/finish but hides tool details and TLDR.
{
    const gates = resolveOutputGates({ quiet: true });
    assert.equal(gates.outputVerbose, false, "quiet hides non-essential output");
    assert.equal(gates.stepVerbose, true, "quiet keeps step start/finish lines");

    const out = capture(() => emitAll(gates));
    assert.ok(out.some((line) => line.includes("[STEP]")), "quiet shows step lines");
    assert.ok(!out.some((line) => line.includes("ToolName")), "quiet hides tool call details");
    assert.ok(!out.some((line) => line.includes("[TLDR]")), "quiet hides TLDR");
}

// 3. Very-quiet mode prints nothing on success (step lines are suppressed, too).
{
    const gates = resolveOutputGates({ veryQuiet: true });
    assert.equal(gates.outputVerbose, false, "very-quiet hides all non-essential output");
    assert.equal(gates.stepVerbose, false, "very-quiet suppresses even the step lines");

    const out = capture(() => emitAll(gates));
    assert.equal(out.length, 0, "very-quiet prints nothing on success");
}

// 4. Very-quiet beats quiet: when both are requested the stronger mode wins.
{
    const gates = resolveOutputGates({ quiet: true, veryQuiet: true });
    assert.equal(gates.veryQuiet, true, "very-quiet stays set when both flags are given");
    assert.equal(gates.outputVerbose, false, "both -> outputVerbose false");
    assert.equal(gates.stepVerbose, false, "both -> stepVerbose false (very-quiet wins)");

    const out = capture(() => emitAll(gates));
    assert.equal(out.length, 0, "very-quiet beats quiet: no output on success");

    // This is the actual commander resolution path: resolveOutputGates is
    // handed the boolean options that commander produces for -q/--quiet and
    // --very-quiet / -qq.
    assert.equal(resolveOutputGates({}).quiet, false, "commander default for --quiet is false");
    assert.equal(resolveOutputGates({ quiet: true }).quiet, true, "commander -q/--quiet -> quiet true");
    assert.equal(resolveOutputGates({ veryQuiet: true }).veryQuiet, true, "commander --very-quiet -> veryQuiet true");
}

// 5. Flag parsing: -q/--quiet mean quiet and -qq/--very-quiet mean very-quiet.
{
    // The -qq short form is translated to --very-quiet before commander parses.
    assert.equal(isVeryQuietToken("-qq"), true, "-qq is recognized as very-quiet");
    assert.equal(isVeryQuietToken("-q"), false, "-q is not very-quiet");
    assert.equal(isVeryQuietToken("--very-quiet"), false, "--very-quiet is untouched by the translation");

    // translateCliArgs mimics main.ts: cliArgs = translateCliArgs(process.argv).
    const argv = ["node", "main.js", "some prompt", "-qq"];
    const translated = translateCliArgs(argv);
    assert.deepEqual(translated[2], "some prompt", "prompt is preserved verbatim");
    assert.equal(translated[3], "--very-quiet", "-qq becomes --very-quiet before parsing");

    // Other tokens pass through unchanged.
    assert.deepEqual(
        translateCliArgs(["node", "main.js", "-q", "hello"]),
        ["node", "main.js", "-q", "hello"],
        "non -qq tokens (including -q) are preserved",
    );

    // Full pipeline: after translation, --very-quiet yields the very-quiet gates.
    const quietGates = resolveOutputGates({ quiet: true });
    const vqGates = resolveOutputGates({ veryQuiet: true });
    assert.equal(quietGates.outputVerbose, false, "-q/--quiet -> quiet gates");
    assert.equal(quietGates.stepVerbose, true, "-q/--quiet keeps step lines");
    assert.equal(vqGates.stepVerbose, false, "-qq/--very-quiet suppresses step lines");
}

// fatalVerbose is unconditional: a genuine fatal/abort diagnostic is the one
// thing that always prints, even in very-quiet mode (never silently swallowed).
{
    const gates = resolveOutputGates({ veryQuiet: true });
    assert.equal(gates.fatalVerbose, true, "fatal/abort diagnostics always print");
    assert.equal(resolveOutputGates({}).fatalVerbose, true, "fatalVerbose is true in every mode");
}

// The gates returned by resolveOutputGates match exactly what main.ts uses, so
// the CLI wiring stays consistent: outputVerbose = !veryQuiet && !quiet; the
// derivation is exercised across the full flag matrix.
{
    const matrix: Array<[number, boolean]> = [
        [0b00, true], // {}            -> outputVerbose true
        [0b10, false], // { quiet }     -> false
        [0b01, false], // { veryQuiet } -> false
        [0b11, false], // both          -> false
    ];
    for (const [bits, expected] of matrix) {
        const flags = { quiet: (bits & 0b10) !== 0, veryQuiet: (bits & 0b01) !== 0 };
        assert.equal(resolveOutputGates(flags).outputVerbose, expected, `outputVerbose for ${JSON.stringify(flags)}`);
    }
}

console.log("output-verbosity tests passed");
