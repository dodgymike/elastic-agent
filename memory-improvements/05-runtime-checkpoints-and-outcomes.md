# MI-05 — Checkpoint runtime progress with truthful outcomes

Status: **TODO** · Priority: **P1** · Size: **M**

Dependencies: [MI-04](04-reload-and-legacy-import.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

The current runtime remembers plan steps and finalizes memory at the end. A crash before finalization can lose the whole run. Invalid feedback can map to completed memory, and direct/planned paths use different completion assumptions. Wire the new store into actual execution boundaries without turning memory into a tool-replay mechanism.

## Starting points in the repository

- [main.ts](../main.ts) — rememberAgentStep, executePlanStep, runExecutionPhase, direct execution, finalizePersistentMemory.
- [llm/run-abort.ts](../llm/run-abort.ts) — abort propagation.
- [memory/types.ts](../memory/types.ts) — event and durability contracts.
- [specKeeperTaskCompletion.ts](../specKeeperTaskCompletion.ts) — external task completion; do not conflate it with local memory writes.

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

Add `test/memory-runtime-checkpoint.test.ts` against the extracted production helper with fake tools, a real temporary store, and an injected clock/abort signal. Cover failure before append, during append, after commit, and before final reporting. Run `test:abort-paths`, `test:multi-turn-memory`, and store/reload suites.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Keep runtime wiring opt-in until task 16. Do not change external task status or replay semantics as a shortcut. Memory loss should be reported accurately without undoing a successfully completed user action.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: TODO | IN_PROGRESS | BLOCKED | DONE
Baseline revision:
Prerequisite evidence:
Reproduction / old behavior:
Changed files and behavior:
Validation commands and actual results:
Schema / configuration / compatibility changes:
Residual limitations and follow-up IDs:
Rollback notes:
Implementation commit(s):
```
