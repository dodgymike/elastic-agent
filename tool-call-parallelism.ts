/**
 * Tool-call parallelism policy for the CLI.
 *
 * This module owns the `--max-tool-call-parallelism` validation policy so
 * main.ts and its tests share a single source of truth. The resolved value is
 * carried on `runtimeConfig.maxToolCallParallelism` and consumed by the
 * dependency-aware tool-dispatch scheduler described in
 * TOOL_CALL_SCHEDULING.md.
 *
 * Default is 4. Minimum is 1 (which reproduces the historical fully-sequential
 * dispatch exactly). Maximum is 16, a conservative ceiling for read-only
 * concurrency: values outside [1, 16] fail fast with a usage error.
 */

/** Conservative default used when the option is omitted. */
export const DEFAULT_MAX_TOOL_CALL_PARALLELISM = 4;

/** Lower bound: 1 reproduces today's exact sequential dispatch semantics. */
export const MIN_TOOL_CALL_PARALLELISM = 1;

/** Suggested upper bound from TOOL_CALL_SCHEDULING.md (validated, not clamped). */
export const MAX_TOOL_CALL_PARALLELISM = 16;

/**
 * Validate and normalize a user-supplied `--max-tool-call-parallelism` value.
 *
 * Accepts commander's raw string, a number (useful for tests and programmatic
 * callers), or `undefined`/`null` (falls back to the default). Returns an
 * integer in [MIN_TOOL_CALL_PARALLELISM, MAX_TOOL_CALL_PARALLELISM], or throws
 * a clear usage error for any invalid value.
 */
export function resolveMaxToolCallParallelism(value: unknown): number {
    if (value === undefined || value === null) {
        return DEFAULT_MAX_TOOL_CALL_PARALLELISM;
    }

    let numeric: number;
    if (typeof value === "number") {
        numeric = value;
    } else if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "" || !/^\d+$/.test(trimmed)) {
            throw invalidMaxToolCallParallelism(value);
        }
        numeric = Number.parseInt(trimmed, 10);
    } else {
        throw invalidMaxToolCallParallelism(value);
    }

    if (
        !Number.isInteger(numeric) ||
        numeric < MIN_TOOL_CALL_PARALLELISM ||
        numeric > MAX_TOOL_CALL_PARALLELISM
    ) {
        throw invalidMaxToolCallParallelism(value);
    }

    return numeric;
}

/** Build the shared usage error for invalid values. */
function invalidMaxToolCallParallelism(value: unknown): Error {
    return new Error(
        `Usage: --max-tool-call-parallelism must be an integer between ` +
            `${MIN_TOOL_CALL_PARALLELISM} and ${MAX_TOOL_CALL_PARALLELISM}; got '${String(value)}'.`,
    );
}
