import chalk from "chalk";

/**
 * Tool-call terminal rendering.
 *
 * This module is the single place that decides how a function-call is rendered
 * to the console. The agent loop dispatches each tool-call event (pending,
 * succeeded, or failed) through `renderToolPhase`, which selects a per-tool
 * renderer from `toolRenderers` and falls back to `genericToolRenderer` when a
 * tool has no specialized renderer for that phase.
 *
 * Renderer functions return plain, unindented strings (one per output line).
 * Color is applied by the renderer itself through the `ansiHelpers` returned
 * from `ansiHelpers(options.color)`, so callers only have to supply whether
 * the current terminal supports color. The caller (main.ts) owns console
 * labels, indentation prefixes, and the actual write target.
 *
 * A renderer can suppress a section entirely by returning an empty array;
 * returning `undefined` defers to the generic renderer for that phase.
 */

export type ToolRenderPhase = "pending" | "succeeded" | "failed";

/** Minimal shape of a function-call record needed for terminal rendering. */
export interface ToolCallDescriptor {
    name: string;
    arguments?: string;
}

/** Options controlling a single tool-call render. */
export interface ToolRendererOptions {
    /** True when the terminal supports color; false degrades to plain text. */
    color: boolean;
}

/** A per-tool renderer may implement any subset of the three phases. */
export interface ToolRenderer {
    pending?(toolCall: ToolCallDescriptor, options: ToolRendererOptions): string[] | undefined;
    succeeded?(toolCall: ToolCallDescriptor, result: unknown, options: ToolRendererOptions): string[] | undefined;
    failed?(toolCall: ToolCallDescriptor, error: unknown, options: ToolRendererOptions): string[] | undefined;
}

/** A renderer with all three phases implemented. */
export type CompleteToolRenderer = Required<ToolRenderer>;

/** Shared ANSI color helpers that degrade to plain text when color is false. */
export interface AnsiHelpers {
    green(text: string): string;
    red(text: string): string;
    yellow(text: string): string;
    cyan(text: string): string;
    gray(text: string): string;
    bold(text: string): string;
    greenBold(text: string): string;
    redBold(text: string): string;
    cyanBold(text: string): string;
    yellowBold(text: string): string;
}

/**
 * Return bound color helpers for one render. When `color` is false every helper
 * returns its input unchanged, so renderers stay plain in non-TTY/no-color
 * contexts without conditional calls at each rendering site.
 */
export function ansiHelpers(color: boolean): AnsiHelpers {
    return {
        green: (text) => (color ? chalk.green(text) : text),
        red: (text) => (color ? chalk.red(text) : text),
        yellow: (text) => (color ? chalk.yellow(text) : text),
        cyan: (text) => (color ? chalk.cyan(text) : text),
        gray: (text) => (color ? chalk.gray(text) : text),
        bold: (text) => (color ? chalk.bold(text) : text),
        greenBold: (text) => (color ? chalk.green.bold(text) : text),
        redBold: (text) => (color ? chalk.red.bold(text) : text),
        cyanBold: (text) => (color ? chalk.cyan.bold(text) : text),
        yellowBold: (text) => (color ? chalk.yellow.bold(text) : text),
    };
}

/**
 * Determine whether terminal color should be enabled for the supplied stream.
 * Honors the NO_COLOR convention (when set and non-empty, color is disabled)
 * and FORCE_COLOR (when set to a non-empty value other than "0", color is
 * forced on), then falls back to the stream's TTY state.
 */
export function terminalColorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
    const noColor = process.env.NO_COLOR;
    if (noColor !== undefined && noColor !== "") return false;
    const forceColor = process.env.FORCE_COLOR;
    if (forceColor !== undefined && forceColor !== "" && forceColor !== "0") return true;
    return typeof stream.isTTY === "boolean" && stream.isTTY;
}

/** Collapse whitespace and bound a value to a single, terminal-friendly line. */
export function truncate(value: unknown, maxLength = 240): string {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Best-effort JSON serialization that never throws. */
export function stringify(value: unknown): string {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value) : serialized;
    } catch {
        return String(value);
    }
}

/** Summarize a raw tool-call arguments JSON string for the pending line. */
export function toolCallArgumentSummary(argumentsText: unknown): string {
    if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
    try {
        return truncate(stringify(JSON.parse(argumentsText)), 160);
    } catch {
        return truncate(argumentsText, 160);
    }
}

function renderGenericPending(toolCall: ToolCallDescriptor, _options: ToolRendererOptions): string[] {
    const argumentsSummary = toolCallArgumentSummary(toolCall.arguments);
    return [`Pending: ${toolCall.name}${argumentsSummary ? ` ${argumentsSummary}` : ""}`];
}

function renderGenericSucceeded(toolCall: ToolCallDescriptor, result: unknown, _options: ToolRendererOptions): string[] {
    return [`Succeeded: ${toolCall.name}${result === undefined ? "" : ` → ${truncate(stringify(result), 160)}`}`];
}

function renderGenericFailed(toolCall: ToolCallDescriptor, error: unknown, _options: ToolRendererOptions): string[] {
    return [`Failed: ${toolCall.name}: ${String(error)}`];
}

/**
 * Fallback renderer that preserves the historical generic tool-call output.
 * It is also the base every specialized renderer builds on.
 */
export const genericToolRenderer: CompleteToolRenderer = {
    pending: renderGenericPending,
    succeeded: renderGenericSucceeded,
    failed: renderGenericFailed,
};

/** Extract the `command` field from a raw tool-call arguments JSON string. */
function executeCommandText(argumentsText: unknown): string {
    if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
    try {
        const parsed = JSON.parse(argumentsText) as { command?: unknown };
        return typeof parsed?.command === "string" ? parsed.command : "";
    } catch {
        return "";
    }
}

/** Convert captured stdout/stderr into non-empty display lines. */
function executeCommandOutputLines(text: unknown): string[] {
    if (typeof text !== "string") return [];
    if (text.trim() === "") return [];
    return text.split(/\r?\n/).filter((line) => line.length > 0);
}

interface ExecuteCommandResultLike {
    exitCode?: unknown;
    stdout?: unknown;
    stderr?: unknown;
}

function renderExecuteCommandPending(toolCall: ToolCallDescriptor, _options: ToolRendererOptions): string[] {
    const command = truncate(executeCommandText(toolCall.arguments), 160);
    if (!command) return ["ExecuteCommand"];
    const quoted = command.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return [`ExecuteCommand('${quoted}')`];
}

function renderExecuteCommandSucceeded(_toolCall: ToolCallDescriptor, result: unknown, options: ToolRendererOptions): string[] | undefined {
    if (!result || typeof result !== "object") return undefined;
    const { exitCode, stdout, stderr } = result as ExecuteCommandResultLike;
    if (typeof exitCode !== "number") return undefined;

    const green = ansiHelpers(options.color).green;
    const red = ansiHelpers(options.color).red;

    if (exitCode === 0) {
        const stdoutLines = executeCommandOutputLines(stdout);
        if (stdoutLines.length === 0) return [green("●")];
        return [`${green("●")} ${stdoutLines[0]}`, ...stdoutLines.slice(1)];
    }

    const lines = [`${red("●")} exit ${exitCode}`];
    lines.push(...executeCommandOutputLines(stderr));
    lines.push(...executeCommandOutputLines(stdout));
    return lines;
}

function renderExecuteCommandFailed(_toolCall: ToolCallDescriptor, error: unknown, options: ToolRendererOptions): string[] {
    const red = ansiHelpers(options.color).red;
    const message = String(error).trim();
    return message ? [`${red("●")} ${message}`] : [red("●")];
}

/**
 * Tool-specific renderers keyed by tool name. Each tool owns its renderer
 * object so later steps can attach specialized formatting (for example the
 * ExecuteCommand, Edit, and Git result views) without touching the dispatch
 * path. Tools without specialized phases inherit the generic implementation.
 */
export const toolRenderers: Record<string, ToolRenderer> = {
    Write: { ...genericToolRenderer },
    Read: { ...genericToolRenderer },
    FileSize: { ...genericToolRenderer },
    Edit: { ...genericToolRenderer },
    Http: { ...genericToolRenderer },
    HttpRequest: { ...genericToolRenderer },
    ListDirectory: { ...genericToolRenderer },
    ExecuteCommand: {
        pending: renderExecuteCommandPending,
        succeeded: renderExecuteCommandSucceeded,
        failed: renderExecuteCommandFailed,
    },
    Git: { ...genericToolRenderer },
    AgentBus: { ...genericToolRenderer },
    SpecKeeper: { ...genericToolRenderer },
    SpecKeeperEnroll: { ...genericToolRenderer },
};

export type ToolPhaseRenderFn = (
    toolCall: ToolCallDescriptor,
    payload: unknown,
    options: ToolRendererOptions,
) => string[] | undefined;

function normalizeLines(lines: unknown): string[] {
    if (!Array.isArray(lines)) return [];
    return lines.filter((line): line is string => typeof line === "string" && line.length > 0);
}

/**
 * Render one phase of a tool call. Dispatch is by tool name; unknown tools and
 * phases without a specialized renderer use the generic renderer. A specialized
 * renderer may suppress output by returning an empty array, or defer to the
 * generic renderer by returning `undefined`.
 */
export function renderToolPhase(
    phase: ToolRenderPhase,
    toolCall: ToolCallDescriptor,
    payload: unknown,
    options: ToolRendererOptions,
): string[] {
    const renderer = toolRenderers[toolCall?.name];
    const phaseRenderer = renderer?.[phase] as ToolPhaseRenderFn | undefined;
    if (phaseRenderer) {
        try {
            const lines = phaseRenderer(toolCall, payload, options);
            if (Array.isArray(lines)) return normalizeLines(lines);
        } catch {
            // A specialized renderer must never break the agent loop. Fall back
            // to the generic renderer so the call still surfaces a result.
        }
    }
    const fallback = genericToolRenderer[phase] as ToolPhaseRenderFn;
    return normalizeLines(fallback(toolCall, payload, options));
}
