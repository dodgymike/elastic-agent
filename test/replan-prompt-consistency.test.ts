// Prompt-consistency tests for the phase-aware replanner prompt
// (prompts/replan-prompt.txt). These verify that the prompt text documents the
// same top-level "phase" contract that the planner prompt
// (prompts/planning-suffix.txt) and the handler (llm/replan-abort.ts
// phaseRestartRequired) implement, so the LLM-facing contract and the runtime
// behavior cannot drift silently.
//
// Read from the real prompt files rather than a hand-written copy, so any
// future wording change that violates the phase/restart contract fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { phaseRestartRequired } from "../llm/replan-abort.js";

const replannerText = readFileSync("prompts/replan-prompt.txt", "utf-8");
const plannerText = readFileSync("prompts/planning-suffix.txt", "utf-8");

async function testReplannerMentionsPhaseField(): Promise<void> {
  // The replanner prompt must document the optional top-level "phase" field and
  // tie it to a major stage of work, mirroring the planner prompt.
  assert.match(replannerText, /"phase"/, "replanner prompt must mention the top-level phase field");
  assert.match(replannerText, /top-level JSON field/i, "replanner prompt must call phase a top-level field");
  assert.match(replannerText, /major stage/i, "replanner prompt must describe phase as a major stage");
  assert.match(replannerText, /planning-suffix\.txt/, "replanner prompt must reference the planner prompt contract");
  console.log("  ok: replanner prompt documents the top-level phase field");
}

async function testReplannerMentionsFullRestart(): Promise<void> {
  // Proposing a DIFFERENT phase must be documented as causing a full restart:
  // executed progress abandoned and the whole plan restarted from the first step.
  assert.match(replannerText, /FULL RESTART/i, "replanner prompt must state proposing a different phase causes a FULL RESTART");
  assert.match(replannerText, /restart the whole plan/i, "replanner prompt must say the whole plan restarts");
  assert.match(replannerText, /abandons all executed progress/i, "replanner prompt must say executed progress is abandoned");
  assert.match(replannerText, /from the very first step/i, "replanner prompt must say the plan restarts from the first step");
  console.log("  ok: replanner prompt documents the full-restart consequence of a phase change");
}

async function testReplannerClarifiesNoRestartWithinPhase(): Promise<void> {
  // Editing steps WITHIN the current phase (same or absent phase) must be
  // documented as NOT restarting the whole plan.
  assert.match(replannerText, /does\s+NOT\s+restart/i, "replanner prompt must explicitly say in-phase edits do NOT restart");
  assert.match(replannerText, /within the current phase/i, "replanner prompt must scope the no-restart rule to the current phase");
  assert.match(replannerText, /continues in place/i, "replanner prompt must say the runtime continues in place");
  assert.match(replannerText, /leave "phase" absent/i, "replanner prompt must advise leaving phase absent for in-phase edits");
  console.log("  ok: replanner prompt clarifies that in-phase step edits do not restart");
}

async function testReplannerMatchesPlannerContract(): Promise<void> {
  // The valid type (non-empty string or integer) and the high-complexity-only
  // constraint must be consistent between the planner and replanner prompts.
  assert.match(replannerText, /non-empty string or integer/);
  assert.match(plannerText, /non-empty string or integer/);
  // Prompt files wrap long lines, so allow whitespace (including newlines)
  // between the words that make up the complexity qualifier.
  assert.match(replannerText, /VERY\s+HIGH\s+complexity/i, "replanner prompt must restrict phase to very-high-complexity plans");
  assert.match(plannerText, /VERY\s+HIGH\s+complexity/i, "planner prompt must restrict phase to very-high-complexity plans");
  assert.match(replannerText, /individual step/i, "replanner prompt must say phase is not an individual step");
  assert.match(plannerText, /individual step/i, "planner prompt must say phase is not an individual step");
  console.log("  ok: replanner and planner prompts agree on phase type and complexity");
}

async function testReplannerPromptMatchesHandlerSemantics(): Promise<void> {
  // The pure decision the handler uses (phaseRestartRequired) must agree with
  // the wording in the replanner prompt: a different or newly-introduced phase
  // restarts; keeping the same phase (or omitting it) does not.
  // Handler truth:
  assert.equal(phaseRestartRequired("design", "verify"), true, "different phase must restart");
  assert.equal(phaseRestartRequired(undefined, "design"), true, "introducing a phase must restart");
  assert.equal(phaseRestartRequired("design", "design"), false, "same phase must not restart");
  assert.equal(phaseRestartRequired("design", undefined), false, "omitting phase must not restart");

  // Prompt wording: a full restart is "PROPOSING A DIFFERENT PHASE", and the
  // no-restart branch covers "leave phase absent (or return the same phase)".
  assert.match(replannerText, /DIFFERENT PHASE/i, "prompt must tie a restart to a different phase");
  assert.match(replannerText, /same phase/i, "prompt must describe returning the same phase as non-restarting");

  // The prompt tells the replanner to only propose a phase for very-high-
  // complexity plans, matching the planner requirement and the runtime's
  // "only considered for very-high-complexity" guard.
  assert.match(replannerText, /multiple phases and multiple steps/i);
  console.log("  ok: replanner prompt wording agrees with phaseRestartRequired behavior");
}

async function main(): Promise<void> {
  await testReplannerMentionsPhaseField();
  await testReplannerMentionsFullRestart();
  await testReplannerClarifiesNoRestartWithinPhase();
  await testReplannerMatchesPlannerContract();
  await testReplannerPromptMatchesHandlerSemantics();
  console.log("Replan prompt consistency tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
