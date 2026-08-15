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
    orange(text: string): string;
    bold(text: string): string;
    greenBold(text: string): string;
    redBold(text: string): string;
    cyanBold(text: string): string;
    yellowBold(text: string): string;
    orangeBold(text: string): string;
}

/**
 * Return bound color helpers for one render. When `color` is false every helper
 * returns its input unchanged, so renderers stay plain in non-TTY/no-color
 * contexts without conditional calls at each rendering site.
 */
export function ansiHelpers(color: boolean): AnsiHelpers {
    // Orange uses the 256-color palette (ANSI 38;5;208) so it degrades
    // gracefully on terminals without truecolor support.
    const orange = color ? chalk.ansi256(208) : (text: string) => text;
    return {
        green: (text) => (color ? chalk.green(text) : text),
        red: (text) => (color ? chalk.red(text) : text),
        yellow: (text) => (color ? chalk.yellow(text) : text),
        cyan: (text) => (color ? chalk.cyan(text) : text),
        gray: (text) => (color ? chalk.gray(text) : text),
        orange,
        bold: (text) => (color ? chalk.bold(text) : text),
        greenBold: (text) => (color ? chalk.green.bold(text) : text),
        redBold: (text) => (color ? chalk.red.bold(text) : text),
        cyanBold: (text) => (color ? chalk.cyan.bold(text) : text),
        yellowBold: (text) => (color ? chalk.yellow.bold(text) : text),
        orangeBold: (text) => (color ? chalk.ansi256(208).bold(text) : text),
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

/** Placeholder used when secret-shaped values are omitted from terminal display. */
export const REDACTED = "[REDACTED]";

/** Keys whose values are secret-shaped and must never render in plaintext. */
const SECRET_KEY_PATTERN =
    /(?:authorization|token|password|secret|credential|api[_-]?key|cookie|session|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?id|username|recipe)/i;

function isSecretKey(key: string): boolean {
    return SECRET_KEY_PATTERN.test(key);
}

/**
 * Recursively replace values under secret-shaped keys with `[REDACTED]`.
 * Arrays are preserved so non-secret elements can still be summarized.
 */
export function redactSecretFields(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactSecretFields);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                isSecretKey(key) ? REDACTED : redactSecretFields(item),
            ]),
        );
    }
    return value;
}

/** Redact common credential forms from free-form diagnostic or error text. */
export function redactSecretText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            return stringify(redactSecretFields(JSON.parse(trimmed)));
        } catch {
            // Not structured JSON after all; fall through to regex redaction.
        }
    }
    return text
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED AUTHORIZATION]")
        .replace(
            /(\b(?:access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key|credential|authorization)\b\s*[:=]\s*)[^\s,;]+/gi,
            "$1[REDACTED]",
        );
}

/** Summarize a raw tool-call arguments JSON string for the pending line. */
export function toolCallArgumentSummary(argumentsText: unknown): string {
    if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
    try {
        return truncate(stringify(redactSecretFields(JSON.parse(argumentsText))), 160);
    } catch {
        return truncate(redactSecretText(argumentsText), 160);
    }
}

/** Shape of a command-like tool result carrying captured process streams. */
export interface ToolCommandResultLike {
    exitCode?: unknown;
    stdout?: unknown;
    stderr?: unknown;
}

/** Normalized command streams extracted from a command-like tool result. */
export interface ToolCommandStreams {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Extract command streams from a tool result. Returns `undefined` when the
 * payload is not command-like (no finite numeric `exitCode`), so callers can
 * defer to a tool-specific or generic renderer.
 */
export function commandStreamsFrom(payload: unknown): ToolCommandStreams | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const { exitCode, stdout, stderr } = payload as ToolCommandResultLike;
    if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) return undefined;
    return {
        exitCode,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
    };
}

/** Convert captured stdout/stderr into non-empty display lines. */
export function toolCommandOutputLines(text: unknown): string[] {
    if (typeof text !== "string") return [];
    if (text.trim() === "") return [];
    return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * Build the unified `ToolName(args)` label for a tool call. Command-like tools
 * use their natural single-argument form (`ExecuteCommand('...')` and
 * `Git('mode'|'action')`); every other tool falls back to the JSON argument summary.
 */
export function toolCommandLabel(toolCall: ToolCallDescriptor): string {
    const name = toolCall?.name ?? "Tool";
    if (name === "ExecuteCommand") {
        const command = truncate(executeCommandText(toolCall.arguments), 160);
        if (!command) return "ExecuteCommand";
        const quoted = command.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return `ExecuteCommand('${quoted}')`;
    }
    if (name === "Git") {
        const mode = gitModeText(toolCall.arguments);
        if (!mode) return "Git";
        return `Git('${mode.replace(/'/g, "\\'")}')`;
    }
    const argumentsSummary = toolCallArgumentSummary(toolCall.arguments);
    return argumentsSummary ? `${name}(${argumentsSummary})` : name;
}

/** Return a one-line message from a thrown or serialized error payload. */
export function toolCommandErrorText(payload: unknown): string {
    if (typeof payload === "string") return payload.trim();
    if (payload instanceof Error) return payload.message.trim();
    if (payload && typeof payload === "object") {
        const record = payload as { error?: unknown };
        if (typeof record.error === "string" && record.error.trim() !== "") return record.error.trim();
    }
    return "";
}

/**
 * Shared tool-command render helper.
 *
 * Renders one tool call as `ToolName(args)` followed by a green (success) or
 * red (error) circle, then the captured streams:
 * - success: stdout, plus stderr only when non-empty
 * - failure: stderr, plus stdout when non-empty (stdout can carry useful
 *   diagnostics even when the command failed)
 *
 * A rejected call (thrown error or serialized `{ error }`) renders the same
 * `ToolName(args)` label with a red circle and the error message. The helper
 * returns `undefined` when the payload is neither command-like nor an error,
 * so the caller can defer to a more specific or generic renderer.
 *
 * It never emits `[SUCCESS]` or `[ERROR]` text prefixes.
 */
export function renderToolCommand(
    toolCall: ToolCallDescriptor,
    payload: unknown,
    options: ToolRendererOptions,
): string[] | undefined {
    const label = toolCommandLabel(toolCall);
    const a = ansiHelpers(options.color);

    // The label is colored by execution status so the terminal shows the
    // live, green (success), or red (failure) state on the tool-call heading.
    const streams = commandStreamsFrom(payload);
    if (streams) {
        const success = streams.exitCode === 0;
        const coloredLabel = success ? a.green(label) : a.red(label);
        const circle = success ? a.green("●") : `${a.red("●")} exit ${streams.exitCode}`;
        // The colored tool-call label opens its own line; the status circle and
        // any captured output follow on new lines, each indented one space
        // relative to that tool-call line.
        const indent = (line: string) => ` ${line}`;
        const lines = [coloredLabel, indent(circle)];
        const stdoutLines = toolCommandOutputLines(streams.stdout).map(indent);
        const stderrLines = toolCommandOutputLines(streams.stderr).map(indent);
        if (success) {
            lines.push(...stdoutLines);
            if (stderrLines.length > 0) lines.push(...stderrLines);
        } else {
            lines.push(...stderrLines);
            lines.push(...stdoutLines);
        }
        return lines;
    }

    const message = redactSecretText(toolCommandErrorText(payload));
    if (message) return [a.red(label), ` ${a.red("●")} ${message}`];
    return undefined;
}

function renderGenericPending(toolCall: ToolCallDescriptor, options: ToolRendererOptions): string[] {
    const label = toolCommandLabel(toolCall);
    const a = ansiHelpers(options.color);
    return [a.orange(label)];
}

function renderGenericSucceeded(toolCall: ToolCallDescriptor, result: unknown, options: ToolRendererOptions): string[] {
    const label = toolCommandLabel(toolCall);
    const a = ansiHelpers(options.color);
    const circle = a.green("●");
    const summary = result === undefined ? "" : ` ${truncate(stringify(result), 160)}`;
    return [a.green(label), ` ${circle}${summary}`];
}

function renderGenericFailed(toolCall: ToolCallDescriptor, error: unknown, options: ToolRendererOptions): string[] {
    const label = toolCommandLabel(toolCall);
    const a = ansiHelpers(options.color);
    const circle = a.red("●");
    const message = redactSecretText(toolCommandErrorText(error));
    return message ? [a.red(label), ` ${circle} ${message}`] : [a.red(label), ` ${circle}`];
}

/**
 * Fallback renderer used for any tool or phase without a specialized renderer.
 * It follows the same unified `ToolName(args)` label plus circle convention as
 * the shared command helper, so no tool emits legacy `Pending:`/`Succeeded:`/
 * `Failed:` text prefixes.
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

function renderExecuteCommandPending(toolCall: ToolCallDescriptor, options: ToolRendererOptions): string[] {
    return [ansiHelpers(options.color).orange(toolCommandLabel(toolCall))];
}

/**
 * ExecuteCommand results are command-shaped, so both phases delegate to the
 * shared tool-command helper. This keeps stdout/stderr ordering identical to
 * the central dispatch path: success prints stdout then any non-empty stderr;
 * failure prints stderr then any non-empty stdout.
 */
function renderExecuteCommandSucceeded(toolCall: ToolCallDescriptor, result: unknown, options: ToolRendererOptions): string[] | undefined {
    return renderToolCommand(toolCall, result, options);
}

function renderExecuteCommandFailed(toolCall: ToolCallDescriptor, error: unknown, options: ToolRendererOptions): string[] | undefined {
    return renderToolCommand(toolCall, error, options);
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

    const lines = [`${a.green(a.bold("Edit"))} ${scope}${appliedText}`];
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

/** Extract the `mode` (or legacy `action`) field from raw tool-call arguments JSON. */
function gitModeText(argumentsText: unknown): string {
    if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
    try {
        const parsed = JSON.parse(argumentsText) as { mode?: unknown; action?: unknown };
        if (typeof parsed?.mode === "string") return parsed.mode;
        if (typeof parsed?.action === "string") return parsed.action;
        return "";
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
    return toolCommandOutputLines(text);
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
    // The status circle opens the result view one space indented relative to
    // the tool-call line, matching the shared command helper's layout; the
    // diagnostic lines follow at the same one-space indent.
    const indent = (line: string) => ` ${line}`;
    const lines = [indent(`${a.red("●")} ${command} failed (exit ${exitCode})`)];
    lines.push(...gitOutputLines(result.stderr).map(indent));
    lines.push(...gitOutputLines(result.stdout).map(indent));
    return lines;
}

function renderGitPending(toolCall: ToolCallDescriptor, options: ToolRendererOptions): string[] {
    return [ansiHelpers(options.color).orange(toolCommandLabel(toolCall))];
}

function renderGitSucceeded(toolCall: ToolCallDescriptor, result: unknown, options: ToolRendererOptions): string[] | undefined {
    if (!result || typeof result !== "object") return undefined;
    const gitResult = result as GitResultLike;
    const a = ansiHelpers(options.color);

    // Some runtime guards return a serialized `{ error }` object rather than
    // throwing. Route it through the shared helper so it renders as a unified
    // `Git('mode') ● message` error line.
    if (typeof gitResult.error === "string" && gitResult.error.trim() !== "") {
        return renderToolCommand(toolCall, result, options);
    }
    if (typeof gitResult.exitCode !== "number") return undefined;

    const args = gitCommandArgs(gitResult);
    if (args.length === 0) return undefined;

    if (args[0] === "status") {
        if (gitResult.exitCode !== 0) {
            return renderGitCommandFailure(args, gitResult.exitCode, gitResult, a);
        }
        const statusLines = renderGitStatus(typeof gitResult.stdout === "string" ? gitResult.stdout : "", options);
        // A successful status command can still emit stderr; include it when
        // present rather than silently dropping the diagnostic.
        statusLines.push(...gitOutputLines(gitResult.stderr));
        return statusLines;
    }

    // Log/diff/ls-files/stage/commit results are command-shaped. Delegate to
    // the shared helper so their stdout/stderr ordering matches ExecuteCommand
    // and the central dispatch path exactly.
    return renderToolCommand(toolCall, result, options);
}

function renderGitFailed(toolCall: ToolCallDescriptor, error: unknown, options: ToolRendererOptions): string[] | undefined {
    return renderToolCommand(toolCall, error, options);
}

/** Summarize a result after redacting secret-shaped values. */
function redactedResultSummary(result: unknown): string {
    if (result === undefined) return "";
    return truncate(stringify(redactSecretFields(result)), 160);
}

/**
 * Render a successful SpecKeeperEnroll/SpecKeeper/AgentBus call with every
 * secret-shaped argument and result value replaced by `[REDACTED]`. Non-secret
 * metadata (for example api_base, project_slug, role, status) remains visible.
 */
function renderRedactedSucceeded(toolCall: ToolCallDescriptor, result: unknown, options: ToolRendererOptions): string[] {
    const label = toolCommandLabel(toolCall);
    const a = ansiHelpers(options.color);
    const circle = a.green("●");
    const summary = redactedResultSummary(result);
    return summary ? [a.green(label), ` ${circle} ${summary}`] : [a.green(label), ` ${circle}`];
}

/** Render a failed secret-carrying tool with a redacted error message. */
function renderRedactedFailed(toolCall: ToolCallDescriptor, error: unknown, options: ToolRendererOptions): string[] {
    const label = toolCommandLabel(toolCall);
    const a = ansiHelpers(options.color);
    const circle = a.red("●");
    const message = redactSecretText(toolCommandErrorText(error));
    return message ? [a.red(label), ` ${circle} ${message}`] : [a.red(label), ` ${circle}`];
}

const redactedToolRenderer: ToolRenderer = {
    ...genericToolRenderer,
    succeeded: renderRedactedSucceeded,
    failed: renderRedactedFailed,
};

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
    AgentBus: { ...redactedToolRenderer },
    SpecKeeper: { ...redactedToolRenderer },
    SpecKeeperEnroll: { ...redactedToolRenderer },
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
    // Pending renderers receive only (toolCall, options); succeeded/failed
    // renderers receive (toolCall, payload, options), so the pending phase is
    // invoked with options in the second position and a duplicated trailing
    // argument that pending renderers ignore (the third positional slot is the
    // `options` of the uniform phase-fn type).
    const invokePhase = (fn: ToolPhaseRenderFn): string[] | undefined =>
        phase === "pending" ? fn(toolCall, options, options) : fn(toolCall, payload, options);

    const renderer = toolRenderers[toolCall?.name];
    const phaseRenderer = renderer?.[phase] as ToolPhaseRenderFn | undefined;
    if (phaseRenderer) {
        try {
            const lines = invokePhase(phaseRenderer);
            if (Array.isArray(lines)) return normalizeLines(lines);
        } catch {
            // A specialized renderer must never break the agent loop. Fall back
            // to the generic renderer so the call still surfaces a result.
        }
    }
    const fallback = genericToolRenderer[phase] as ToolPhaseRenderFn;
    return normalizeLines(invokePhase(fallback));
}
