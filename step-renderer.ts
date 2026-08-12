import chalk from "chalk";

/**
 * Options controlling how a plan-step header is rendered.
 */
export interface PrettyStepOptions {
    /** True when the output is attached to a TTY, enabling ANSI color. */
    color: boolean;
    /** Remaining plan steps after the current one (used for the next-step hint). */
    remainingSteps?: string[];
}

/**
 * Build the `[STEP]`-labelled lines that pretty-print a plan step header.
 *
 * The returned array omits the `[STEP]` label itself (the caller routes each
 * line through its existing `status.step` helper). The current step's
 * description is emitted in full and is never truncated. When `color` is true
 * ANSI escapes (via chalk) are used and the layout uses `─`/`→`/`—`; when it is
 * false the layout degrades to plain ASCII (`--`/`->`/`--`, no color).
 *
 * Dependencies are not conveyed because the active plan representation (an
 * array of step strings) has no explicit dependency metadata today; the next
 * step is surfaced as a hint when one exists.
 */
export function buildPrettyStepLines(index: number, totalSteps: number, stepText: string, options: PrettyStepOptions): string[] {
    const remaining = options.remainingSteps ?? [];
    const stepNo = `Step ${index + 1}/${totalSteps}`;
    const tag = "in progress";
    const rule = options.color ? "─".repeat(2) : "--";
    const dash = options.color ? "—" : "--";
    const lines: string[] = [];

    lines.push(options.color
        ? `${chalk.yellow.bold(rule)} ${chalk.cyan.bold(stepNo)} ${chalk.yellow.bold(dash)} ${chalk.yellow.bold(tag)} ${chalk.yellow.bold(rule)}`
        : `${rule} ${stepNo} ${dash} ${tag} ${rule}`);
    lines.push(`   ${stepText}`);
    if (remaining.length > 0) {
        lines.push(options.color
            ? `   ${chalk.cyan("→ Next:")} ${remaining[0]}`
            : `   -> Next: ${remaining[0]}`);
    }
    return lines;
}
