# MI-05 — Checkpoint runtime progress with truthful outcomes

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-04](04-reload-and-legacy-import.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

The current runtime remembers plan steps and finalizes memory at the end. A crash before finalization can lose the whole run. Invalid feedback can map to completed memory, and direct/planned paths use different completion assumptions. Wire the new store into actual execution boundaries without turning memory into a tool-replay mechanism.

## Starting points in the repository

- [main.ts](../../../src/main.ts) — rememberAgentStep, executePlanStep, runExecutionPhase, direct execution, finalizePersistentMemory.
- [llm/run-abort.ts](../../../src/llm/run-abort.ts) — abort propagation.
- [memory/types.ts](../../../src/memory/types.ts) — event and durability contracts.
- [specKeeperTaskCompletion.ts](../../../src/integrations/spec-keeper/specKeeperTaskCompletion.ts) — external task completion; do not conflate it with local memory writes.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Build immutable scope from task 01 once per run and await store initialization before the first recall. Correct the taskId/userId mix-up in the new path while retaining legacy provenance during import.

2. After a tool result or step outcome is accepted, append a bounded event with its stable ID and evidence references. Use existing execution metadata; do not duplicate every raw tool response. Record completed, failed, blocked/aborted, skipped, and unknown outcomes explicitly.

3. Require valid feedback before recording a reported completion. Keep reported success distinct from verification evidence. Malformed feedback becomes unknown/invalid_feedback rather than completed; preserve completed tool effects even if the later step report is malformed.

4. Await the durable checkpoint before claiming that progress is recoverable. A persistence failure may allow the user's task to continue with a visible degraded-durability status, but must not silently claim checkpoint success or replay a mutation.

5. Checkpoint at safe step boundaries and support bounded flush/close on success, failure, and abort. A hard kill can lose an uncommitted event; document that limit and preserve uncertainty about external effects.

6. Resume from committed observations and unfinished work references. Memory does not authorize automatic re-execution of previously attempted tools; uncertain side effects require reconciliation by the execution lifecycle.

7. Extract a narrow production lifecycle helper if needed so tests can exercise checkpoint ordering without importing the live CLI or copying its algorithm.

## Acceptance criteria

- [ ] A crash immediately after a committed step checkpoint preserves that progress on restart without requiring finalization.
- [ ] Invalid feedback and failed tools cannot be stored as verified completion. Direct and planned paths obey the same outcome rules.
- [ ] A failed append produces a visible degraded result and does not invoke the tool again.
- [ ] Abort flushes only within a bounded deadline and does not hang on summarization or a locked store.

## Validation

Add `tests/memory/memory-runtime-checkpoint.test.ts` against the extracted production helper with fake tools, a real temporary store, and an injected clock/abort signal. Cover failure before append, during append, after commit, and before final reporting. Run `test:abort-paths`, `test:multi-turn-memory`, and store/reload suites.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Keep runtime wiring opt-in until task 16. Do not change external task status or replay semantics as a shortcut. Memory loss should be reported accurately without undoing a successfully completed user action.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); MI-01..MI-04 commits present.
Prerequisite evidence: MI-04 DONE (e37a96e/ac048b4).
Reproduction / old behavior: runtime remembered plan steps and finalized at end; a crash before finalization lost the run; invalid feedback could map to completed memory.
Changed files and behavior:
  - src/memory/runtime-checkpoint.ts (new): RuntimeCheckpointWriter, normalizeRuntimeOutcome, resumeCheckpointedSteps; durable checkpoint events; truthful outcomes; degraded append result; bounded flush/close.
  - src/memory/contracts-v2.ts: extend MemoryOutcomeAssertionV2 with blocked and invalid_feedback.
  - src/memory/legacy-compat.ts: map new assertion values safely to the v1 outcome vocabulary.
  - src/memory/index.ts: export the checkpoint surface.
  - tests/memory/memory-runtime-checkpoint.test.ts (new): crash recovery without finalization, truthful normalization, invalid-feedback storage, degraded append with no replay, bounded abort flush.
  - package.json: add test:memory-runtime-checkpoint script.
Validation commands and actual results:
  - npm run test:memory-runtime-checkpoint -> exit 0
  - npm run test:abort-paths -> exit 0
  - npm run test:multi-turn-memory -> exit 0
  - npm run test:memory-event-store -> exit 0
  - npm run test:memory-reload -> exit 0
  - npm run test:memory-contract-v2 -> exit 0
  - npm run build -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node src/memory/index.ts -> exit 0
  - git diff --check -> clean
Schema / configuration / compatibility changes: outcome vocabulary extended (additive); default backend unchanged.
Residual limitations and follow-up IDs: runtime src/main.ts wiring stays opt-in until MI-16; hard-kill can still lose an uncommitted event (documented); external side-effect reconciliation remains with the execution lifecycle.
Rollback notes: remove the additive writer/exports and revert the vocabulary additions; no stored-data migration required.
Implementation commit(s): 7c40eca (implementation + tests); completion record commit follows.

Verification re-check (verification pass, plan step 3): verified, no change needed.
  - Node binary used: v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node),
    reached for npm scripts via RunPackageScript env PATH override.
  - Actual results, all exit 0: test:memory-runtime-checkpoint, test:abort-paths,
    test:multi-turn-memory, test:memory-event-store, test:memory-reload,
    test:memory-contract-v2, build.
  - The recorded literal `npx tsc --noEmit ... src/memory/index.ts` check was run through the
    dedicated TypeCheck tool (repo-approved fixed flags, src/memory/index.ts, noEmit); exit 0.
  - git diff --check clean.
  - Skipped checks: none. No code change.
```
