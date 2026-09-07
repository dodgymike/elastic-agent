/**
 * Formatting helpers for the [RESPONSE] console step.
 *
 * The agent loop prints model responses through `CompatibleResponseWrapper`
 * in main.ts. Historically that wrapper used `summarizeResponse`, which
 * prefixed the text with "Text response: " and truncated it to a fixed width,
 * and emitted "[RESPONSE] No text response or tool calls." when there was
 * nothing to show.
 *
 * These helpers replace that behavior:
 *   - `responseDisplayText` returns the full, untruncated text of the model
 *     response (empty string when there is no text to display).
 *   - `wrapResponseText` lays that text out as a column of word-wrapped lines,
 *     preserving paragraph breaks (blank lines between paragraphs).
 *
 * The helpers are deliberately ANSI-free and dependency-free so they can be
 * compiled and exercised in isolation by the `test:response-format` fixture.
 */

interface ResponseOutputItem {
    type?: unknown;
    content?: unknown;
}

interface ResponseLike {
    output?: ResponseOutputItem[];
}

interface TextContentItem {
    type?: unknown;
    text?: unknown;
}

/**
 * Collect the non-empty text content of every assistant message in a response.
 * Each assistant message contributes one block, and text items within a message
 * are joined with a single newline so multi-part content stays together while
 * separate messages can later be separated as paragraphs.
 */
export function responseTextBlocks(response: ResponseLike | null | undefined): string[] {
    const blocks: string[] = [];
    for (const output of response?.output ?? []) {
        if (!output || output.type !== "message") continue;
        const content = Array.isArray(output.content) ? output.content : [];
        const text = content
            .filter((item): item is TextContentItem => !!item && (item.type === "output_text" || item.type === "text"))
            .map((item) => String(item.text ?? ""))
            .filter((part) => part.trim().length > 0)
            .join("\n")
            .trim();
        if (text) blocks.push(text);
    }
    return blocks;
}

/**
 * Return the full response text to display, with separate assistant messages
 * separated by a blank line (a paragraph break). Returns "" when the response
 * contains no displayable text, which callers use to suppress the [RESPONSE]
 * line entirely.
 */
export function responseDisplayText(response: ResponseLike | null | undefined): string {
    return responseTextBlocks(response).join("\n\n");
}

/**
 * Determine the column width available for wrapped response text. The width is
 * derived from the terminal width minus the caller's indentation prefix, and is
 * clamped to the [40, 100] range so output stays readable on very narrow or
 * very wide terminals.
 */
export function responseTextWidth(prefix = ""): number {
    const columns =
        typeof process !== "undefined" && process.stdout && typeof process.stdout.columns === "number" && process.stdout.columns > 0
            ? process.stdout.columns
            : 100;
    return Math.max(40, Math.min(100, columns - prefix.length));
}

/**
 * Word-wrap a single paragraph (text with no blank-line separators) into lines
 * no wider than `width`. Existing whitespace runs are collapsed to single
 * spaces so the paragraph reflows as a column. Words longer than the column
 * width are kept intact and placed on their own line.
 */
function wrapParagraph(paragraph: string, width: number): string[] {
    const words = paragraph.replace(/\s+/g, " ").trim().split(" ");
    if (words.length === 0 || (words.length === 1 && words[0] === "")) return [];
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
        if (current.length === 0) current = word;
        else if (current.length + 1 + word.length <= width) current += ` ${word}`;
        else {
            lines.push(current);
            current = word;
        }
    }
    if (current.length > 0) lines.push(current);
    return lines;
}

/**
 * Lay the full response text out as a column of lines. Blank lines in the
 * input mark paragraph boundaries and are preserved as blank lines in the
 * returned array. The returned lines do NOT include the caller's prefix; the
 * caller applies its indentation when printing so tests stay plain and
 * deterministic.
 *
 * An explicit `maxWidth` can be supplied for tests; when omitted the width is
 * derived from the terminal and `prefix`.
 */
export function wrapResponseText(text: string, prefix = "", maxWidth?: number): string[] {
    const width = maxWidth ?? responseTextWidth(prefix);
    const paragraphs = String(text).split(/\n\s*\n/);
    const lines: string[] = [];
    paragraphs.forEach((paragraph, index) => {
        if (index > 0) lines.push("");
        lines.push(...wrapParagraph(paragraph, width));
    });
    return lines;
}
