// Focused isolated fixtures for the [RESPONSE] formatting helpers
// (response-format.ts). Compiled and executed standalone by the
// `test:response-format` npm script.
import assert from "node:assert/strict";
import { responseDisplayText, responseTextBlocks, responseTextWidth, wrapResponseText } from "../response-format.js";

// 1. A response with no displayable text (for example only a function call)
//    yields no text blocks and an empty display string.
{
    const response = { output: [{ type: "function_call", name: "Write", arguments: "{}" }] };
    assert.deepStrictEqual(responseTextBlocks(response), []);
    assert.equal(responseDisplayText(response), "");
}

// 2. Text responses are returned in full (never truncated).
{
    const longText = "word ".repeat(500).trim();
    const response = { output: [{ type: "message", content: [{ type: "output_text", text: longText }] }] };
    assert.deepStrictEqual(responseTextBlocks(response), [longText]);
    assert.equal(responseDisplayText(response), longText);
}

// 3. Separate assistant messages become separate paragraphs (blank line).
{
    const response = {
        output: [
            { type: "message", content: [{ type: "text", text: "first" }] },
            { type: "message", content: [{ type: "text", text: "second" }] },
        ],
    };
    assert.deepStrictEqual(responseTextBlocks(response), ["first", "second"]);
    assert.equal(responseDisplayText(response), "first\n\nsecond");
}

// 4. Long paragraphs are word-wrapped at the requested column width, and the
//    wrapped output still contains the complete text.
{
    const paragraph = "The quick brown fox jumps over the lazy dog repeatedly while the sun keeps shining on the quiet meadow.";
    const lines = wrapResponseText(paragraph, "", 30);
    assert.ok(lines.length > 1, "a long paragraph should wrap to multiple lines");
    for (const line of lines) assert.ok(line.length <= 30, `line exceeds requested width: ${line}`);
    assert.equal(lines.join(" "), paragraph);
}

// 5. Paragraph breaks (blank lines) are preserved as blank lines in the
//    wrapped output.
{
    const text =
        "First paragraph with enough words to be fairly long and wrap across a couple of lines.\n\n" +
        "Second paragraph also long enough to wrap and remain separate.";
    const lines = wrapResponseText(text, "", 40);
    const blankIndex = lines.indexOf("");
    assert.ok(blankIndex > 0, "a blank line must separate the two paragraphs");
    assert.ok(lines[0].startsWith("First paragraph"));
    assert.ok(lines.slice(blankIndex + 1).join(" ").startsWith("Second paragraph"));
}

// 6. A single word longer than the column width is kept intact on its own line
//    rather than being truncated.
{
    const longWord = "a".repeat(120);
    assert.deepStrictEqual(wrapResponseText(longWord, "", 40), [longWord]);
}

// 7. The terminal-derived column width stays within the readable [40, 100]
//    range for any indentation prefix.
{
    const narrow = responseTextWidth(" ".repeat(400));
    const normal = responseTextWidth(" ".repeat(8));
    assert.ok(narrow >= 40 && narrow <= 100, `narrow width out of range: ${narrow}`);
    assert.ok(normal >= 40 && normal <= 100, `normal width out of range: ${normal}`);
    assert.ok(narrow <= normal, "a longer prefix must not increase the available width");
}

console.log("Response formatting fixtures passed.");
