import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPrompt,
  renderPrompt,
  SELF_MODIFICATION_ENABLED_MARKER,
  type BuildPromptOptions,
} from "../prompt-builder.js";

// Mirror the production build-prompt skeleton closely enough to exercise the
// interpolation points buildPrompt fills in. The on-disk skeleton is also
// pinned against a golden fixture below so its stable-first ordering cannot
// drift without an explicit fixture update.
const template = [
  "${claudeInstructions}",
  "",
  "Recent command line prompts (oldest to newest; last ${historyLimit}):",
  "${promptHistory}",
  "",
  "Recent tool call TLDRs (oldest to newest; last ${historyLimit}):",
  "${toolHistory}",
  "",
  "Current command line prompt:",
  "${commandLinePrompt}",
].join("\n");

const claudeInstructions = "Follow the engineering standards.";
const selfModificationSection =
  `## Self-modification instructions\n\nAllowed because --allow-agent-source-modifications was set. ${SELF_MODIFICATION_ENABLED_MARKER}\n`;
const baseOptions: BuildPromptOptions = {
  commandPrompts: ["first prompt"],
  toolCallTldrs: ["Write(example.ts) -> ok"],
  commandLinePromptValue: "current work order",
  template,
  claudeInstructions,
  historyLimit: 10,
  selfModificationSection,
  allowAgentSourceModifications: false,
};

// Default/disabled state: the rendered prompt contains the interpolated values
// and does NOT contain the self-modification section or its stable marker.
const withoutSection = buildPrompt(baseOptions);
assert.ok(withoutSection.includes(claudeInstructions));
assert.ok(withoutSection.includes("1. first prompt"));
assert.ok(withoutSection.includes("1. Write(example.ts) -> ok"));
assert.ok(withoutSection.includes("current work order"));
assert.ok(!withoutSection.includes(selfModificationSection));
assert.ok(!withoutSection.includes(SELF_MODIFICATION_ENABLED_MARKER));

// Enabled state: the section is appended after the rendered skeleton with a
// blank-line separator, and the stable marker from the section is present.
const withSection = buildPrompt({ ...baseOptions, allowAgentSourceModifications: true });
assert.equal(withSection, `${withoutSection}\n\n${selfModificationSection}`);
assert.ok(withSection.includes(SELF_MODIFICATION_ENABLED_MARKER));
assert.ok(withSection.endsWith(selfModificationSection));

// Empty histories render the "(none)" placeholder exactly like the CLI path.
const emptyHistories = buildPrompt({ ...baseOptions, commandPrompts: [], toolCallTldrs: [] });
assert.ok(emptyHistories.includes("(none)"));
assert.ok(!emptyHistories.includes(SELF_MODIFICATION_ENABLED_MARKER));

// renderPrompt resolves interpolation values against the supplied variable map.
assert.equal(renderPrompt("value: ${value}", { value: "ok" }), "value: ok");

// renderPrompt escapes backticks in templates so embedded JSON fences in prompt
// text cannot break the generated evaluator.
assert.equal(renderPrompt("`${value}`", { value: "ok" }), "`ok`");

// --- Golden fixture: the on-disk build-prompt skeleton must match the
// --- stable-first ordering pinned in test/fixtures. ---
const skeletonPath = "prompts/build-prompt-skeleton.txt";
const goldenSkeletonPath = "test/fixtures/build-prompt-skeleton.golden.txt";
const skeleton = readFileSync(skeletonPath, "utf-8");
const goldenSkeleton = readFileSync(goldenSkeletonPath, "utf-8");
assert.equal(skeleton, goldenSkeleton,
  `${skeletonPath} must match the golden fixture ${goldenSkeletonPath}`);
assert.ok(skeleton.startsWith("${claudeInstructions}"),
  "the skeleton must begin with the stable instructions interpolation");
assert.ok(skeleton.indexOf("${promptHistory}") > skeleton.indexOf("${claudeInstructions}"),
  "prompt history must follow the stable instructions");
assert.ok(skeleton.indexOf("${toolHistory}") > skeleton.indexOf("${promptHistory}"),
  "tool-call TLDRs must follow prompt history");
assert.ok(skeleton.indexOf("${commandLinePrompt}") > skeleton.indexOf("${toolHistory}"),
  "the current command-line prompt must be the final section");

// --- Stable-prefix ordering: the prompt must begin with the static
// --- claudeInstructions and keep every dynamic history/TLDR/current-prompt
// --- value after that prefix, so a leading prompt cache stays valid. ---
assert.equal(withoutSection.indexOf(claudeInstructions), 0,
  "the prompt must begin with the stable instructions");
const historyHeader = "Recent command line prompts";
const tldrHeader = "Recent tool call TLDRs";
assert.ok(withoutSection.indexOf(historyHeader) > withoutSection.indexOf(claudeInstructions),
  "the history header must follow the stable instructions");
assert.ok(withoutSection.indexOf("1. first prompt") > withoutSection.indexOf(historyHeader),
  "prompt-history values must appear after their header");
assert.ok(withoutSection.indexOf(tldrHeader) > withoutSection.indexOf("1. first prompt"),
  "the tool-TLDR header must follow the prompt-history values");
assert.ok(withoutSection.indexOf("1. Write(example.ts) -> ok") > withoutSection.indexOf(tldrHeader),
  "tool-TLDR values must appear after their header");
assert.ok(withoutSection.indexOf("current work order") > withoutSection.indexOf("1. Write(example.ts) -> ok"),
  "the current command-line prompt must be the last section");

// Changing tool-use responses affects only the suffix: the bytes through the
// tool-TLDR section header are unchanged, so the leading cache prefix is stable.
const otherTldrs = buildPrompt({ ...baseOptions, toolCallTldrs: ["Edit(main.ts) -> ok"] });
const stableEnd = withoutSection.indexOf(tldrHeader) + tldrHeader.length;
assert.ok(stableEnd > 0, "the tool-TLDR header must exist in the prompt");
assert.equal(otherTldrs.slice(0, stableEnd), withoutSection.slice(0, stableEnd),
  "changing tool-call TLDRs must not alter the stable prefix");
assert.ok(otherTldrs.includes("1. Edit(main.ts) -> ok"), "the new TLDR must appear in the suffix");
assert.ok(!otherTldrs.includes("1. Write(example.ts) -> ok"), "the old TLDR must not remain in the suffix");

console.log("Prompt-builder ordering and flag-state tests passed.");
