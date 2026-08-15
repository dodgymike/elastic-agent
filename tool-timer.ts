import chalk from "chalk";

/**
 * In-place ticking timer for tool command execution.
 *
 * The agent loop starts a timer when a tool command begins and stops it when
 * the command completes or fails. While a command runs, the timer writes one
 * terminal line and keeps updating it in place using ANSI line clearing and a
 * carriage return. When the command stops, the timer replaces the ticking line
 * with the final elapsed time and terminates the line so the tool result
 * rendered by tool-renderer.ts starts on a fresh line.
 *
 * In non-TTY contexts (redirected logs, CI, tests) the timer never emits ANSI
 * cursor escapes or an in-place ticking line; it only prints a plain elapsed
 * time line on stop, so logs still record how long each tool command took.
 *
 * The timer never emits `[SUCCESS]` or `[ERROR]` text prefixes; success and
 * failure status are owned by the tool-command renderer.
 */

const CLEAR_LINE = "\x1b[2K";
const CARRIAGE_RETURN = "\r";

/** Options controlling one tool-command timer. */
export interface ToolTimerOptions {
    /** Write target for timer output. Defaults to `process.stdout.write`. */
    write?: (text: string) => void;
    /** True when output is attached to a TTY. Defaults to `process.stdout.isTTY`. */
    isTTY?: boolean;
    /** True when the terminal supports color. Defaults to the `isTTY` value. */
    color?: boolean;
    /** Ticking interval in milliseconds. Defaults to 100. */
    intervalMs?: number;
    /** Monotonic-ish clock used for elapsed time. Defaults to `Date.now`. */
    now?: () => number;
    /** Interval scheduler used for ticking. Defaults to global `setInterval`. */
    schedule?: (callback: () => void, intervalMs: number) => unknown;
    /** Interval cancellation used for cleanup. Defaults to global `clearInterval`. */
    cancel?: (handle: unknown) => void;
    /** Optional indentation/hierarchy prefix prepended to every timer line. */
    prefix?: string;
}

/** A started tool-command timer. */
export interface ToolTimer {
    /** True between `start()` and `stop()`. */
    readonly active: boolean;
    /** Start ticking. Repeated calls while active are ignored. */
    start(): void;
    /**
     * Stop ticking, print the final elapsed time, and clean up terminal state.
     * Returns elapsed milliseconds. Repeated calls are ignored.
     */
    stop(): number;
    /** Elapsed milliseconds since `start()`, or 0 when never started. */
    elapsedMs(): number;
}

/**
 * Format a millisecond duration for terminal display. Durations under a minute
 * use two decimals (for example `0.50s` or `1.23s`), and longer durations use
 * `Xm Ys`.
 */
export function formatElapsed(milliseconds: number): string {
    const safeMs = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
    if (safeMs < 60_000) return `${(safeMs / 1000).toFixed(2)}s`;
    const totalSeconds = Math.floor(safeMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
}

/** Start an in-place tool-command timer. */
export function startToolTimer(options: ToolTimerOptions = {}): ToolTimer {
    return new ToolTimer(options);
}

/** Concrete in-place timer implementation. */
export class ToolTimer implements ToolTimer {
    private readonly write: (text: string) => void;
    private readonly isTTY: boolean;
    private readonly color: boolean;
    private readonly intervalMs: number;
    private readonly now: () => number;
    private readonly schedule: (callback: () => void, intervalMs: number) => unknown;
    private readonly cancel: (handle: unknown) => void;
    private readonly prefix: string;

    private startedAt: number | null = null;
    private intervalHandle: unknown = null;
    private exitCleanupHandler: (() => void) | undefined;

    constructor(options: ToolTimerOptions = {}) {
        this.write = options.write ?? ((text) => process.stdout.write(text));
        this.isTTY = options.isTTY ?? (typeof process.stdout.isTTY === "boolean" && process.stdout.isTTY);
        this.color = options.color ?? this.isTTY;
        this.intervalMs = options.intervalMs ?? 100;
        this.now = options.now ?? Date.now;
        this.schedule = options.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
        this.cancel = options.cancel ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
        this.prefix = options.prefix ?? "";
    }

    get active(): boolean {
        return this.intervalHandle !== null;
    }

    start(): void {
        if (this.active) return;
        this.startedAt = this.now();
        this.writeTickLine();
        this.intervalHandle = this.schedule(() => this.writeTickLine(), this.intervalMs);
        this.installExitCleanup();
    }

    stop(): number {
        if (!this.active) return this.elapsedMs();
        const elapsed = this.elapsedMs();
        if (this.intervalHandle !== null) {
            this.cancel(this.intervalHandle);
            this.intervalHandle = null;
        }
        this.removeExitCleanup();
        this.writeFinalLine();
        return elapsed;
    }

    elapsedMs(): number {
        if (this.startedAt === null) return 0;
        return Math.max(0, this.now() - this.startedAt);
    }

    private elapsedText(): string {
        const elapsed = formatElapsed(this.elapsedMs());
        if (this.color) return chalk.gray(`⏱ ${elapsed}`);
        return `elapsed ${elapsed}`;
    }

    private writeTickLine(): void {
        if (!this.isTTY) return;
        this.write(`${CLEAR_LINE}${CARRIAGE_RETURN}${this.prefix}${this.elapsedText()}`);
    }

    private writeFinalLine(): void {
        if (this.isTTY) {
            this.write(`${CLEAR_LINE}${CARRIAGE_RETURN}${this.prefix}${this.elapsedText()}\n`);
            return;
        }
        this.write(`${this.prefix}${this.elapsedText()}\n`);
    }

    private installExitCleanup(): void {
        if (typeof process === "undefined" || typeof process.once !== "function") return;
        this.removeExitCleanup();
        this.exitCleanupHandler = () => {
            if (this.active && this.isTTY) {
                this.write(`${CLEAR_LINE}${CARRIAGE_RETURN}${this.prefix}`);
            }
        };
        process.once("exit", this.exitCleanupHandler);
    }

    private removeExitCleanup(): void {
        if (typeof process === "undefined" || typeof process.removeListener !== "function") return;
        if (this.exitCleanupHandler) {
            process.removeListener("exit", this.exitCleanupHandler);
            this.exitCleanupHandler = undefined;
        }
    }
}
