// Prompt-consistency tests for the memory-compaction prompt
// (prompts/memory-compaction.md). These verify that the compaction template
// documents the contract the memory-compaction runtime (introduced alongside
// it) depends on:
//
//   - it carries `${plan}` and `${memory}` interpolation placeholders so a
//     caller can inject the active plan and the current session memory, and
//   - it instructs the model to compress without losing important details, so
//     compaction is safe (nothing critical is dropped).
//
// The test reads the real prompt file rather than a hand-written copy, so any
// future wording change that violates the placeholder or compression contract
// fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compactionPrompt = readFileSync("prompts/memory-compaction.md", "utf-8");

async function testPromptCarriesPlanAndMemoryPlaceholders(): Promise<void> {
  // The compaction prompt must interpolate the active plan and the current
  // session memory via the established ${...} template convention, so the
  // caller can fill them in at call time with renderPrompt.
  assert.match(compactionPrompt, /\$\{plan\}/, "compaction prompt must expose a ${plan} interpolation placeholder");
  assert.match(compactionPrompt, /\$\{memory\}/, "compaction prompt must expose a ${memory} interpolation placeholder");
  console.log("  ok: compaction prompt carries ${plan} and ${memory} placeholders");
}

async function testPromptAsksToCompressWithoutLosingImportantDetails(): Promise<void> {
  // The central requirement: compress (aggressively reduce size) but preserve
  // important details so no critical information is lost.
  assert.match(compactionPrompt, /compress/i, "compaction prompt must ask the model to compress the memory");
  assert.match(compactionPrompt, /without losing/i, "compaction prompt must state compression must not lose important details");
  assert.match(compactionPrompt, /important/i, "compaction prompt must say important details are preserved");
  assert.match(compactionPrompt, /preserv/i, "compaction prompt must say facts/decisions are preserved");
  console.log("  ok: compaction prompt asks to compress without losing important details");
}

async function testPromptRejectsMetadataAndProductionFormat(): Promise<void> {
  // The output contract must be a plain markdown summary, not JSON or fenced
  // code, so the runtime can store it directly as the replacement memory.
  assert.match(compactionPrompt, /do NOT output JSON/i, "compaction prompt must forbid JSON output");
  assert.match(compactionPrompt, /do NOT wrap the response in code fences/i, "compaction prompt must forbid code fences");
  assert.match(compactionPrompt, /Return only the compacted summary text/i, "compaction prompt must require only the summary text");
  console.log("  ok: compaction prompt enforces a plain-text summary output contract");
}

async function main(): Promise<void> {
  await testPromptCarriesPlanAndMemoryPlaceholders();
  await testPromptAsksToCompressWithoutLosingImportantDetails();
  await testPromptRejectsMetadataAndProductionFormat();
  console.log("Memory-compaction prompt tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
