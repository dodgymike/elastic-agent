/**
 * Output-verbosity policy for the CLI.
 *
 * This module owns the quiet / very-quiet filtering policy (and the `-qq`
 * short-form translation) so that main.ts and its tests share a single source
 * of truth. main.ts wires the two flags from commander into resolveOutputGates
 * and gates every stdout write through the returned booleans; the unit tests in
 * test/output-verbosity.test.ts capture real stdout by driving the same gates.
 *
 * Both flags default to false. `--very-quiet` takes precedence over `--quiet`:
 * when both are requested the stronger very-quiet mode wins.
 */

/** Raw command-line flags as commander exposes them (both optional booleans). */
export interface OutputVerbosityFlags {
    quiet?: boolean;
    veryQuiet?: boolean;
}

/** Effective per-channel write gates resolved from the raw flags. */
export interface OutputGates {
    /** Whether --quiet was requested (and not overridden by very-quiet). */
    quiet: boolean;
    /** Whether --very-quiet was requested. */
    veryQuiet: boolean;
    /**
     * Gate for all non-essential output except the 'Step N started'/'Step N
     * finished' header lines: tool call params/results, plan summaries, TLDR,
     * responses, success/feedback/warning/status lines. true only when neither
     * quiet nor very-quiet is active.
     */
    outputVerbose: boolean;
    /**
     * Gate for the 'Step N started'/'Step N finished' header lines, the only
     * nice-to-have output that survives quiet mode. Blanked only by
     * --very-quiet (stepVerbose = !veryQuiet).
     */
    stepVerbose: boolean;
    /**
     * Gate for fatal error/abort diagnostics (the top-level catch for
     * unhandled exceptions / deliberate aborts). Always true: a genuine
     * catastrophic/fatal failure must never be silently swallowed, even in
     * very-quiet mode.
     */
    fatalVerbose: boolean;
}

/**
 * True exactly for the `-qq` token. commander treats one-char short flags, so
 * `-qq` would otherwise collapse to `-q -q` == `--quiet`; this translation lets
 * `-qq` behave exactly like `--very-quiet` while `-q` stays `--quiet`.
 */
export function isVeryQuietToken(arg: string): boolean {
    return arg === "-qq";
}

/**
 * Rewrite a raw argv (process.argv) so the `-qq` token becomes `--very-quiet`
 * before commander parses it. Every other argument is preserved verbatim.
 */
export function translateCliArgs(argv: string[]): string[] {
    return argv.map((arg) => (isVeryQuietToken(arg) ? "--very-quiet" : arg));
}

/**
 * Resolve the effective per-channel write gates from the raw flags, with a
 * single source of truth for quiet/very-quiet precedence.
 *
 *   outputVerbose - everything except step start/finish lines and fatal
 *                   diagnostics (tool params/results, plan summaries, TLDR,
 *                   responses, success/feedback/warning/status lines).
 *   stepVerbose   - the 'Step N started'/'Step N finished' header lines; the
 *                   only nice-to-have output kept in quiet mode.
 *   fatalVerbose  - fatal error/abort diagnostics, always visible.
 */
export function resolveOutputGates(flags: OutputVerbosityFlags = {}): OutputGates {
    const quiet = flags.quiet === true;
    const veryQuiet = flags.veryQuiet === true;
    return {
        quiet,
        veryQuiet,
        outputVerbose: !veryQuiet && !quiet,
        stepVerbose: !veryQuiet,
        fatalVerbose: true,
    };
}
