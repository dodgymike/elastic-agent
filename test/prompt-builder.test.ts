import assert from "node:assert/strict";
import {
  buildPrompt,
  renderPrompt,
  SELF_MODIFICATION_ENABLED_MARKER,
  type BuildPromptOptions,
} from "../prompt-builder.js";

// Mirror the production build-prompt skeleton closely enough to exercise the
// interpolation points buildPrompt fills in, without reading any files.
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

console.log("Prompt-builder flag-state tests passed.");
