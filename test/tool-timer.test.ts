// Focused isolated fixtures for the in-place tool-command timer (tool-timer.ts).
// Compiled and executed standalone by the `test:tool-timer` npm script. A fake
// scheduler and clock keep the tests deterministic: ticks are invoked manually
// instead of waiting for real timers.
import assert from "node:assert/strict";
import { formatElapsed, startToolTimer, ToolTimer } from "../tool-timer.js";

function createHarness(options: {
    isTTY?: boolean;
    color?: boolean;
    intervalMs?: number;
    initialNow?: number;
} = {}) {
    const writes: string[] = [];
    let now = options.initialNow ?? 0;
    let tickCallback: (() => void) | null = null;
    let scheduledIntervalMs = 0;
    let cancelled = false;

    const timer = startToolTimer({
        write: (text) => writes.push(text),
        isTTY: options.isTTY ?? true,
        color: options.color ?? false,
        intervalMs: options.intervalMs ?? 100,
        now: () => now,
        schedule: (callback, intervalMs) => {
            tickCallback = callback;
            scheduledIntervalMs = intervalMs;
            return { handle: 1 };
        },
        cancel: () => {
            tickCallback = null;
            cancelled = true;
        },
    });

    return {
        timer,
        writes,
        setNow(value: number) {
            now = value;
        },
        advance(ms: number) {
            now += ms;
        },
        tick() {
            assert.ok(tickCallback, "timer must have scheduled a tick");
            tickCallback?.();
        },
        get scheduledIntervalMs() {
            return scheduledIntervalMs;
        },
        get cancelled() {
            return cancelled;
        },
        tickScheduled() {
            return tickCallback !== null;
        },
    };
}

function joinedWrites(writes: string[]): string {
    return writes.join("");
}

// 1. formatElapsed renders sub-second, sub-minute, and minute+ durations.
{
    assert.strictEqual(formatElapsed(0), "0.00s");
    assert.strictEqual(formatElapsed(500), "0.50s");
    assert.strictEqual(formatElapsed(1234), "1.23s");
    assert.strictEqual(formatElapsed(65_000), "1m 5s");
    assert.strictEqual(formatElapsed(3 * 60_000 + 42_000), "3m 42s");
    assert.strictEqual(formatElapsed(-5), "0.00s");
}

// 2. A TTY timer starts by drawing one line and updates that same line in
// place with ANSI line clearing plus a carriage return.
{
    const harness = createHarness({ isTTY: true, color: false });
    harness.timer.start();
    assert.strictEqual(harness.scheduledIntervalMs, 100, "timer must schedule ticks at the requested interval");
    assert.ok(harness.writes.length === 1, "start must draw the initial tick line exactly once");
    assert.ok(harness.writes[0].startsWith("\x1b[2K\r"), "TTY ticks must clear the line and return the carriage");
    assert.ok(!harness.writes[0].includes("\n"), "tick lines must not terminate the line");

    harness.advance(100);
    harness.tick();
    assert.strictEqual(harness.writes.length, 2, "each tick must update the same line");
    assert.ok(harness.writes[1].startsWith("\x1b[2K\r"), "later ticks must keep using in-place line clearing");
    assert.ok(harness.writes[1].includes("elapsed 0.10s"), "tick line must show the current elapsed time");
    assert.ok(!harness.writes[1].includes("\n"), "tick lines must stay on the same terminal line");
}

// 3. stop() cancels the interval, terminates the final line, prints elapsed
// time, returns elapsed milliseconds, and emits no status prefixes.
{
    const harness = createHarness({ isTTY: true, color: false });
    harness.timer.start();
    harness.advance(1234);
    harness.tick();
    const beforeStop = harness.writes.length;
    const elapsed = harness.timer.stop();
    assert.strictEqual(elapsed, 1234, "stop must return elapsed milliseconds");
    assert.strictEqual(harness.timer.active, false, "timer must be inactive after stop");
    assert.strictEqual(harness.cancelled, true, "stop must clear the tick interval");
    assert.strictEqual(harness.writes.length, beforeStop + 1, "stop must write exactly one final line");
    assert.ok(harness.writes[harness.writes.length - 1].startsWith("\x1b[2K\r"), "final line must clear the ticking line");
    assert.ok(harness.writes[harness.writes.length - 1].includes("elapsed 1.23s"), "final line must show the elapsed time");
    assert.ok(harness.writes[harness.writes.length - 1].endsWith("\n"), "final line must terminate so result output starts fresh");
    const allOutput = joinedWrites(harness.writes);
    assert.ok(!allOutput.includes("[SUCCESS]"), "timer must never emit [SUCCESS]");
    assert.ok(!allOutput.includes("[ERROR]"), "timer must never emit [ERROR]");
}

// 3b. stop() cleans up scheduled tick and interval state, leaving the timer
// inactive so no further output can occur after completion.
{
    const harness = createHarness({ isTTY: true, color: false });
    harness.timer.start();
    assert.strictEqual(harness.tickScheduled(), true, "active timer must have a scheduled tick");
    harness.timer.stop();
    assert.strictEqual(harness.tickScheduled(), false, "stopped timer must clear its scheduled tick");
    assert.strictEqual(harness.cancelled, true, "stopped timer must clear its interval");
    assert.strictEqual(harness.timer.active, false, "stopped timer must be inactive");
}

// 4. stop() is idempotent: a second stop neither rewrites the final line nor
// changes the returned elapsed time.
{
    const harness = createHarness({ isTTY: true, color: false });
    harness.timer.start();
    harness.advance(200);
    harness.timer.stop();
    const writesAfterFirstStop = harness.writes.length;
    const secondElapsed = harness.timer.stop();
    assert.strictEqual(secondElapsed, 200, "second stop must return the same elapsed time");
    assert.strictEqual(harness.writes.length, writesAfterFirstStop, "second stop must not write again");
}

// 5. Non-TTY timers do not draw or tick with ANSI escapes, but still print a
// plain elapsed line when stopped.
{
    const harness = createHarness({ isTTY: false, color: false });
    harness.timer.start();
    assert.strictEqual(harness.writes.length, 0, "non-TTY start must not emit ticking output");
    assert.strictEqual(harness.timer.active, true, "non-TTY timer must still track active state");
    harness.advance(5000);
    const elapsed = harness.timer.stop();
    assert.strictEqual(elapsed, 5000);
    assert.strictEqual(harness.writes.length, 1, "non-TTY stop must print exactly one elapsed line");
    assert.ok(!harness.writes[0].includes("\x1b"), "non-TTY output must not contain ANSI escapes");
    assert.ok(!harness.writes[0].includes("\r"), "non-TTY output must not contain carriage returns");
    assert.ok(harness.writes[0].includes("elapsed 5.00s"), "non-TTY output must show the elapsed time");
    assert.ok(harness.writes[0].endsWith("\n"), "non-TTY elapsed line must terminate with a newline");
}

// 6. Color mode uses the stopwatch glyph; plain mode uses the ASCII "elapsed"
// label so no-color terminals still read clearly.
{
    const colored = createHarness({ isTTY: true, color: true });
    colored.timer.start();
    colored.advance(250);
    colored.timer.stop();
    assert.ok(colored.writes.some((text) => text.includes("⏱")), "color mode must use the stopwatch glyph");

    const plain = createHarness({ isTTY: true, color: false });
    plain.timer.start();
    plain.advance(250);
    plain.timer.stop();
    assert.ok(plain.writes.every((text) => !text.includes("⏱")), "plain mode must not use the stopwatch glyph");
    assert.ok(plain.writes.some((text) => text.includes("elapsed 0.25s")), "plain mode must use the ASCII elapsed label");
}

// 7. start() can be reused after stop() and the constructed timer is the
// exported ToolTimer implementation.
{
    const harness = createHarness({ isTTY: true, color: false });
    assert.ok(harness.timer instanceof ToolTimer, "startToolTimer must return a ToolTimer");
    harness.timer.start();
    harness.advance(100);
    harness.timer.stop();
    harness.timer.start();
    assert.strictEqual(harness.timer.active, true, "timer must restart after stop");
    harness.advance(100);
    const elapsed = harness.timer.stop();
    assert.strictEqual(elapsed, 100, "restarted timer must measure from the new start time");
}

console.log("Tool timer fixtures passed.");
