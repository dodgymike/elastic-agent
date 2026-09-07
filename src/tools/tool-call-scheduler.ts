/**
 * Dependency-aware tool-call scheduling for one model response.
 *
 * This module owns the pure scheduling policy described in
 * docs/tools/TOOL_CALL_SCHEDULING.md: target-key extraction, the conflict predicate, the
 * forward-only dependency DAG, and the bounded-concurrency topological runner.
 * It deliberately contains no I/O, no renderers, and no config-shared state so
 * the rule set can be unit tested without booting main.ts.
 *
 * The dispatch side (src/main.ts) is responsible for the shared-state guards the
 * design document calls out: denial tracking, terminal rendering, --start-dir
 * cwd switching, the shared LLM runtime, and tool-call history all live in
 * serial prepare/result phases. Only the exec_handler runs concurrently, and
 * this module only decides *when* each call may run.
 */

import { resolve, sep } from "node:path";
import { toolRiskLevel } from "../safety/tool-safety-classifier.js";

/** Canonical target-key kind produced by {@link extractToolTargetKey}. */
export type ToolTargetKind = "file" | "dir" | "url" | "global";

/** A normalized resource target for one tool call. */
export interface ToolTargetKey {
    readonly kind: ToolTargetKind;
    /** Normalized absolute path or trimmed URL; "global" for global keys. */
    readonly value: string;
}

/** Options controlling path normalization. */
export interface ToolCallSchedulingOptions {
    /**
     * Base directory used to resolve relative paths. Defaults to
     * `process.cwd()` so the policy matches the directory the tools actually
     * execute from when --start-dir is not configured.
     */
    readonly cwd?: string;
    /** When true, relative paths resolve against `startDir` instead of cwd. */
    readonly startDirConfigured?: boolean;
    /** The configured --start-dir (already validated absolute path). */
    readonly startDir?: string;
}

/** One tool call in the order the model emitted it. */
export interface ScheduledToolCallDescriptor {
    readonly toolName: string;
    readonly arguments: unknown;
}

/** A forward-only dependency edge: `to` must wait for `from`. */
export interface ToolCallDependencyEdge {
    readonly from: number;
    readonly to: number;
}

/** The global key used for unclassifiable calls and shared-resource tools. */
function globalTargetKey(): ToolTargetKey {
    return { kind: "global", value: "global" };
}

/**
 * Resolve a path-like target into an absolute path key. Non-string, empty, or
 * whitespace-only values fall back to `global`, matching the fail-closed
 * rule in docs/tools/TOOL_CALL_SCHEDULING.md section 3.1.
 */
function pathTargetKey(
    value: unknown,
    kind: "file" | "dir",
    options: ToolCallSchedulingOptions,
): ToolTargetKey {
    if (typeof value !== "string") return globalTargetKey();
    const trimmed = value.trim();
    if (trimmed === "") return globalTargetKey();
    const base = options.startDirConfigured && options.startDir ? options.startDir : options.cwd ?? process.cwd();
    try {
        // `resolve` handles absolute values unchanged and resolves relative
        // values against `base`; the result is a normalized absolute path.
        return { kind, value: resolve(base, trimmed) };
    } catch {
        return globalTargetKey();
    }
}

/** Resolve a URL target; only the trimmed exact string is compared. */
function urlTargetKey(value: unknown): ToolTargetKey {
    if (typeof value !== "string") return globalTargetKey();
    const trimmed = value.trim();
    if (trimmed === "") return globalTargetKey();
    return { kind: "url", value: trimmed };
}

/**
 * Extract the canonical target key for a tool call. The per-tool mapping is
 * the single source of truth from docs/tools/TOOL_CALL_SCHEDULING.md section 3.2.
 */
export function extractToolTargetKey(
    toolName: string,
    toolArguments: unknown,
    options: ToolCallSchedulingOptions = {},
): ToolTargetKey {
    const args = toolArguments && typeof toolArguments === "object" && !Array.isArray(toolArguments)
        ? toolArguments as Record<string, unknown>
        : {};
    switch (toolName) {
        case "Read":
        case "FileSize":
            return pathTargetKey(args.path, "file", options);
        case "ListDirectory":
            return pathTargetKey(args.directory, "dir", options);
        case "Find":
        case "Grep":
            return pathTargetKey(args.path, "dir", options);
        case "Write":
        case "Edit":
        case "Delete":
            return pathTargetKey(args.path, "file", options);
        case "Mkdir":
        case "Rmdir":
            return pathTargetKey(args.path, "dir", options);
        case "Http":
        case "HttpRequest":
            return urlTargetKey(args.url);
        default:
            return globalTargetKey();
    }
}

/**
 * True when `child` is equal to `ancestor` or resides somewhere under it.
 * The root separator is an ancestor of every absolute path, so a directory
 * read of "/" conflicts with every path-like call (correct and conservative).
 */
export function isSameOrUnderPath(child: string, ancestor: string): boolean {
    if (child === ancestor) return true;
    const prefix = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
    return child.startsWith(prefix);
}

/**
 * Conflict predicate from docs/tools/TOOL_CALL_SCHEDULING.md section 4. Global keys
 * conflict with everything; URLs conflict only with the same exact URL;
 * path-like keys conflict when either is the same as or an ancestor of the
 * other.
 */
export function toolTargetKeysConflict(a: ToolTargetKey, b: ToolTargetKey): boolean {
    if (a.kind === "global" || b.kind === "global") return true;
    if (a.kind === "url" || b.kind === "url") {
        return a.kind === "url" && b.kind === "url" && a.value === b.value;
    }
    return isSameOrUnderPath(a.value, b.value) || isSameOrUnderPath(b.value, a.value);
}

/**
 * Build the forward-only dependency DAG for one model response. For every
 * pair `i < j`, edge `i -> j` exists when at least one call is not read-only
 * and their target keys conflict. Edges always point from an earlier index to
 * a later index, so the graph is acyclic by construction; read/read pairs
 * never receive an edge even for the same target.
 */
export function buildToolCallDag(
    calls: readonly ScheduledToolCallDescriptor[],
    options: ToolCallSchedulingOptions = {},
): ToolCallDependencyEdge[] {
    const keys = calls.map((call) => extractToolTargetKey(call.toolName, call.arguments, options));
    const risks = calls.map((call) => toolRiskLevel(call.toolName));
    const edges: ToolCallDependencyEdge[] = [];
    for (let i = 0; i < calls.length; i++) {
        for (let j = i + 1; j < calls.length; j++) {
            const pairHasWriter = risks[i] !== "readonly" || risks[j] !== "readonly";
            if (pairHasWriter && toolTargetKeysConflict(keys[i], keys[j])) {
                edges.push({ from: i, to: j });
            }
        }
    }
    return edges;
}

/**
 * Run tool calls under a bounded greedy topological scheduler. A call is
 * runnable once all of its predecessors have settled; as many runnable calls
 * as possible are started without exceeding `maxParallelism` in flight.
 * Results are returned in original index order, never in completion order.
 *
 * `run` receives the call and its original index and must return a settled
 * value (success or failure) rather than throwing; the scheduler treats a
 * rejection as a fatal error and re-throws the first one after in-flight work
 * settles.
 */
export async function runScheduledToolCalls<T, R>(
    calls: readonly T[],
    edges: readonly ToolCallDependencyEdge[],
    maxParallelism: number,
    run: (call: T, index: number) => Promise<R>,
): Promise<R[]> {
    const n = calls.length;
    const results = new Array<R>(n);
    if (n === 0) return results;

    const safeMax = Number.isFinite(maxParallelism) && maxParallelism >= 1
        ? Math.floor(maxParallelism)
        : 1;

    const indegree = new Array<number>(n).fill(0);
    const dependents: number[][] = Array.from({ length: n }, () => []);
    for (const edge of edges) {
        const { from, to } = edge;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n || from >= to) {
            // Ignore invalid or backward edges; valid DAGs are forward-only.
            continue;
        }
        indegree[to] += 1;
        dependents[from].push(to);
    }

    const ready: number[] = [];
    for (let i = 0; i < n; i++) {
        if (indegree[i] === 0) ready.push(i);
    }

    let inFlight = 0;
    let settled = 0;
    let firstError: unknown = null;

    return new Promise<R[]>((resolvePromise, rejectPromise) => {
        const settle = (index: number, value: R | undefined, error: unknown) => {
            if (error !== null) {
                if (firstError === null) firstError = error;
            } else {
                results[index] = value as R;
            }
            inFlight -= 1;
            settled += 1;
            for (const next of dependents[index]) {
                indegree[next] -= 1;
                if (indegree[next] === 0) ready.push(next);
            }
            pump();
            if (settled === n) {
                if (firstError !== null) rejectPromise(firstError);
                else resolvePromise(results);
            }
        };

        const pump = () => {
            while (inFlight < safeMax && ready.length > 0) {
                const index = ready.shift() as number;
                inFlight += 1;
                run(calls[index], index).then(
                    (value) => settle(index, value, null),
                    (error) => settle(index, undefined, error),
                );
            }
        };

        pump();
    });
}
