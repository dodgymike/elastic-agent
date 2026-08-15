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

/** Maximum diff lines rendered per Edit result. Keeps terminal output bounded. */
const MAX_EDIT_DIFF_LINES = 120;

/**
 * Upper bound for the LCS table used by the Edit diff renderer. The common
 * prefix/suffix are trimmed before the LCS is built, so this limit is only
 * reached by very large changed regions. Beyond it we emit a concise
 * changed-line summary instead of risking an oversized allocation.
 */
const MAX_EDIT_DIFF_CELLS = 4_000_000;

interface EditDiffEntry {
    type: "context" | "addition" | "deletion";
    text: string;
    oldLine: number | null;
    newLine: number | null;
}

interface EditDiff {
    entries: EditDiffEntry[];
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    truncated: number;
}

/** Extract the `path` field from a raw tool-call arguments JSON string. */
function editPathText(argumentsText: unknown): string {
    if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
    try {
        const parsed = JSON.parse(argumentsText) as { path?: unknown };
        return typeof parsed?.path === "string" ? parsed.path : "";
    } catch {
        return "";
    }
}

/** Extract a displayable line-range label from Edit arguments, if present. */
function editLineRangeText(argumentsText: unknown): string {
    if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
    try {
        const parsed = JSON.parse(argumentsText) as { line_range?: unknown };
        if (typeof parsed?.line_range === "string" && parsed.line_range.trim() !== "") {
            return `lines ${parsed.line_range.trim()}`;
        }
        return "";
    } catch {
        return "";
    }
}

/**
 * Split text into display lines. As with the Read/Edit tools, a single
 * trailing newline is a line terminator rather than an extra blank line, and
 * an empty string has no lines.
 */
function editDiffLines(text: string): string[] {
    if (text.length === 0) return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
}

/**
 * Diff two already-trimmed middle line arrays with a classic LCS. Returns
 * exact context/addition/deletion operations for small-to-medium regions; for
 * a very large changed region it falls back to a compact summary so rendering
 * can never exhaust memory or flood the terminal.
 */
function diffMiddleLines(
    oldLines: string[],
    newLines: string[],
): Array<{ type: "context" | "addition" | "deletion"; text: string }> {
    if (oldLines.length === 0 && newLines.length === 0) return [];
    if (oldLines.length === 0) {
        return newLines.map((text) => ({ type: "addition", text }));
    }
    if (newLines.length === 0) {
        return oldLines.map((text) => ({ type: "deletion", text }));
    }
    if (oldLines.length * newLines.length > MAX_EDIT_DIFF_CELLS) {
        return [
            { type: "deletion", text: `… ${oldLines.length} line(s) removed` },
            { type: "addition", text: `… ${newLines.length} line(s) added` },
        ];
    }

    const width = newLines.length + 1;
    const lcs = new Int32Array((oldLines.length + 1) * width);
    for (let i = oldLines.length - 1; i >= 0; i -= 1) {
        const row = i * width;
        const nextRow = (i + 1) * width;
        for (let j = newLines.length - 1; j >= 0; j -= 1) {
            lcs[row + j] =
                oldLines[i] === newLines[j]
                    ? lcs[nextRow + j + 1] + 1
                    : Math.max(lcs[nextRow + j], lcs[row + j + 1]);
        }
    }

    const ops: Array<{ type: "context" | "addition" | "deletion"; text: string }> = [];
    let i = 0;
    let j = 0;
    while (i < oldLines.length && j < newLines.length) {
        if (oldLines[i] === newLines[j]) {
            ops.push({ type: "context", text: oldLines[i] });
            i += 1;
            j += 1;
        } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
            ops.push({ type: "deletion", text: oldLines[i] });
            i += 1;
        } else {
            ops.push({ type: "addition", text: newLines[j] });
            j += 1;
        }
    }
    while (i < oldLines.length) {
        ops.push({ type: "deletion", text: oldLines[i] });
        i += 1;
    }
    while (j < newLines.length) {
        ops.push({ type: "addition", text: newLines[j] });
        j += 1;
    }
    return ops;
}

/**
 * Build a unified-diff-style view of the before/after file content supplied by
 * the Edit tool. Common prefix/suffix lines become bounded context around the
 * changed region, and the middle is diffed with an LCS so non-contiguous edits
 * are classified correctly.
 */
function computeEditDiff(oldText: string, newText: string): EditDiff {
    const oldLines = editDiffLines(oldText);
    const newLines = editDiffLines(newText);

    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix += 1;
    }

    let suffix = 0;
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix += 1;
    }

    const middleOld = oldLines.slice(prefix, oldLines.length - suffix);
    const middleNew = newLines.slice(prefix, newLines.length - suffix);
    const middleOps = diffMiddleLines(middleOld, middleNew);

    const entries: EditDiffEntry[] = [];

    // Up to three unchanged lines immediately before the changed region.
    const contextStart = Math.max(0, prefix - 3);
    for (let i = contextStart; i < prefix; i += 1) {
        entries.push({ type: "context", text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
    }

    // The changed middle. Line numbers advance independently per side.
    let oldCursor = prefix;
    let newCursor = prefix;
    for (const op of middleOps) {
        if (op.type === "deletion") {
            entries.push({ type: "deletion", text: op.text, oldLine: oldCursor + 1, newLine: null });
            oldCursor += 1;
        } else if (op.type === "addition") {
            entries.push({ type: "addition", text: op.text, oldLine: null, newLine: newCursor + 1 });
            newCursor += 1;
        } else {
            entries.push({ type: "context", text: op.text, oldLine: oldCursor + 1, newLine: newCursor + 1 });
            oldCursor += 1;
            newCursor += 1;
        }
    }

    // Up to three unchanged lines immediately after the changed region. These
    // are equal in both files but may live at different line numbers.
    const oldSuffixStart = oldLines.length - suffix;
    const newSuffixStart = newLines.length - suffix;
    const suffixContextCount = Math.min(3, suffix);
    for (let offset = 0; offset < suffixContextCount; offset += 1) {
        const oldIndex = oldSuffixStart + offset;
        const newIndex = newSuffixStart + offset;
        entries.push({ type: "context", text: newLines[newIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
    }

    const oldStart = entries.reduce<number | null>(
        (found, entry) => (found === null && entry.oldLine !== null ? entry.oldLine : found),
        null,
    );
    const newStart = entries.reduce<number | null>(
        (found, entry) => (found === null && entry.newLine !== null ? entry.newLine : found),
        null,
    );

    const oldCount = entries.filter((entry) => entry.oldLine !== null).length;
    const newCount = entries.filter((entry) => entry.newLine !== null).length;

    let truncated = 0;
    let visibleEntries = entries;
    if (entries.length > MAX_EDIT_DIFF_LINES) {
        truncated = entries.length - MAX_EDIT_DIFF_LINES;
        visibleEntries = entries.slice(0, MAX_EDIT_DIFF_LINES);
    }

    return {
        entries: visibleEntries,
        oldStart: oldStart ?? prefix + 1,
        oldCount,
        newStart: newStart ?? prefix + 1,
        newCount,
        truncated,
    };
}

interface EditResultLike {
    content?: unknown;
    previous_content?: unknown;
    applied?: unknown;
}

/**
 * Render a successful Edit as a unified diff. The Edit tool attaches the
 * pre-edit file as `previous_content`; when it is missing (for example a
 * serialized or hand-built result) this renderer defers to the generic output.
 * Additions are green, deletions red, and context lines remain neutral so the
 * no-color fallback still reads as a normal unified diff.
 */
function renderEditSucceeded(toolCall: ToolCallDescriptor, result: unknown, options: ToolRendererOptions): string[] | undefined {
    if (!result || typeof result !== "object") return undefined;
    const { content, previous_content, applied } = result as EditResultLike;
    if (typeof content !== "string" || typeof previous_content !== "string") return undefined;

    const a = ansiHelpers(options.color);
    const path = editPathText(toolCall.arguments);
    const lineRange = editLineRangeText(toolCall.arguments);
    const target = path ? `'${path}'` : "file";
    const scope = lineRange ? `${target} ${lineRange}` : target;
    const appliedText = typeof applied === "number" ? ` applied ${applied} replacement${applied === 1 ? "" : "s"}` : "";

    const lines = [`${a.bold("Edit")} ${scope}${appliedText}`];
    if (previous_content === content) {
        lines.push(a.gray("(no content change)"));
        return lines;
    }

    const diff = computeEditDiff(previous_content, content);
    if (diff.entries.length === 0) {
        lines.push(a.gray("(no content change)"));
        return lines;
    }

    const fileBase = path || "file";
    lines.push(a.gray(`--- a/${fileBase}`));
    lines.push(a.gray(`+++ b/${fileBase}`));
    lines.push(a.cyan(`@@ -${diff.oldStart},${diff.oldCount} +${diff.newStart},${diff.newCount} @@`));

    for (const entry of diff.entries) {
        if (entry.type === "addition") lines.push(a.green(`+${entry.text}`));
        else if (entry.type === "deletion") lines.push(a.red(`-${entry.text}`));
        else lines.push(` ${entry.text}`);
    }

    if (diff.truncated > 0) {
        lines.push(a.gray(`… ${diff.truncated} more diff line(s) omitted`));
    }
    return lines;
}

/** Extract the `action` field from a raw tool-call arguments JSON string. */
function gitActionText(argumentsText: unknown): string {
    if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
    try {
        const parsed = JSON.parse(argumentsText) as { action?: unknown };
        return typeof parsed?.action === "string" ? parsed.action : "";
    } catch {
        return "";
    }
}

interface GitResultLike {
    command?: unknown;
    exitCode?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    error?: unknown;
}

interface GitStatusEntry {
    x: string;
    y: string;
    path: string;
}

interface GitStatusSections {
    branch: string;
    staged: GitStatusEntry[];
    unstaged: GitStatusEntry[];
    untracked: GitStatusEntry[];
}

/** Return the literal git arguments (excluding the `git` executable). */
function gitCommandArgs(result: GitResultLike): string[] {
    if (!Array.isArray(result.command)) return [];
    return result.command.filter((arg): arg is string => typeof arg === "string");
}

/** Convert captured git stdout/stderr into non-empty display lines. */
function gitOutputLines(text: unknown): string[] {
    return executeCommandOutputLines(text);
}

/**
 * Parse `git status --porcelain=v1 --branch` stdout into its branch label and
 * the staged, unstaged, and untracked entry lists. Porcelain v1 is a stable
 * line-oriented format: a `## ` header followed by `XY path` entries, where X
 * is the index status and Y is the worktree status. A single entry appears in
 * both the staged and unstaged sections when both X and Y are changed.
 */
function parseGitStatus(stdout: string): GitStatusSections {
    const lines = stdout.split(/\r?\n/);
    const branchLine = lines.find((line) => line.startsWith("## "));
    const branch = branchLine ? branchLine.slice(3).trim() : "";
    const staged: GitStatusEntry[] = [];
    const unstaged: GitStatusEntry[] = [];
    const untracked: GitStatusEntry[] = [];

    for (const line of lines) {
        if (line.startsWith("## ")) continue;
        if (line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        if (!/^[A-Z?! ]$/.test(x) || !/^[A-Z?! ]$/.test(y)) continue;
        const entry: GitStatusEntry = { x, y, path: line.slice(3) };
        if (x === "?" && y === "?") {
            untracked.push(entry);
            continue;
        }
        if (x !== " " && x !== "?") staged.push(entry);
        if (y !== " " && y !== "?") unstaged.push(entry);
    }

    return { branch, staged, unstaged, untracked };
}

/** Render a clean/working-tree status as branch plus sectioned change lists. */
function renderGitStatus(stdout: string, options: ToolRendererOptions): string[] {
    const a = ansiHelpers(options.color);
    const { branch, staged, unstaged, untracked } = parseGitStatus(stdout);
    const lines = [a.bold("Git status"), a.cyan(`Branch: ${branch || "(unknown)"}`)];

    if (staged.length > 0) {
        lines.push(`${a.green("● Staged")} (${staged.length})`);
        for (const entry of staged) lines.push(`  ${a.green(`${entry.x}${entry.y}`)} ${entry.path}`);
    }
    if (unstaged.length > 0) {
        lines.push(`${a.yellow("● Unstaged")} (${unstaged.length})`);
        for (const entry of unstaged) lines.push(`  ${a.yellow(`${entry.x}${entry.y}`)} ${entry.path}`);
    }
    if (untracked.length > 0) {
        lines.push(`${a.cyan("● Untracked")} (${untracked.length})`);
        for (const entry of untracked) lines.push(`  ${a.cyan(`${entry.x}${entry.y}`)} ${entry.path}`);
    }

    if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
        lines.push(`${a.green("●")} working tree clean`);
    }
    return lines;
}

/** Render a non-zero git exit with command evidence followed by diagnostics. */
function renderGitCommandFailure(args: string[], exitCode: number, result: GitResultLike, a: AnsiHelpers): string[] {
    const command = `git ${args.join(" ")}`;
    const lines = [`${a.red("●")} ${command} failed (exit ${exitCode})`];
    lines.push(...gitOutputLines(result.stderr));
    lines.push(...gitOutputLines(result.stdout));
    return lines;
}

function renderGitPending(toolCall: ToolCallDescriptor, _options: ToolRendererOptions): string[] {
    const action = gitActionText(toolCall.arguments);
    if (!action) return ["Git"];
    return [`Git('${action.replace(/'/g, "\\'")}')`];
}

function renderGitSucceeded(_toolCall: ToolCallDescriptor, result: unknown, options: ToolRendererOptions): string[] | undefined {
    if (!result || typeof result !== "object") return undefined;
    const gitResult = result as GitResultLike;
    const a = ansiHelpers(options.color);

    // Some runtime guards return a serialized `{ error }` object rather than
    // throwing. Surface it as an error line even when the call was dispatched
    // through the succeeded phase.
    if (typeof gitResult.error === "string" && gitResult.error.trim() !== "") {
        return [`${a.red("●")} ${gitResult.error.trim()}`];
    }
    if (typeof gitResult.exitCode !== "number") return undefined;

    const args = gitCommandArgs(gitResult);
    if (args.length === 0) return undefined;

    if (args[0] === "status") {
        if (gitResult.exitCode !== 0) {
            return renderGitCommandFailure(args, gitResult.exitCode, gitResult, a);
        }
        return renderGitStatus(typeof gitResult.stdout === "string" ? gitResult.stdout : "", options);
    }

    if (gitResult.exitCode === 0) {
        const command = `git ${args.join(" ")}`;
        const stdoutLines = gitOutputLines(gitResult.stdout);
        return [`${a.green("●")} ${command}`, ...stdoutLines];
    }

    return renderGitCommandFailure(args, gitResult.exitCode, gitResult, a);
}

function renderGitFailed(_toolCall: ToolCallDescriptor, error: unknown, options: ToolRendererOptions): string[] {
    const a = ansiHelpers(options.color);
    const message = String(error).trim();
    return message ? [`${a.red("●")} ${message}`] : [a.red("●")];
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
    Edit: {
        ...genericToolRenderer,
        succeeded: renderEditSucceeded,
    },
    Http: { ...genericToolRenderer },
    HttpRequest: { ...genericToolRenderer },
    ListDirectory: { ...genericToolRenderer },
    ExecuteCommand: {
        pending: renderExecuteCommandPending,
        succeeded: renderExecuteCommandSucceeded,
        failed: renderExecuteCommandFailed,
    },
    Git: {
        ...genericToolRenderer,
        pending: renderGitPending,
        succeeded: renderGitSucceeded,
        failed: renderGitFailed,
    },
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
