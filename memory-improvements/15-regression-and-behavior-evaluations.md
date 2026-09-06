# MI-15 — Create end-to-end memory regression and quality evaluations

Status: **TODO** · Priority: **P1** · Size: **M**

Dependencies: [MI-10](10-safe-compaction.md), [MI-11](11-backend-capabilities-and-composite.md), [MI-12](12-conversation-lifecycle.md), [MI-13](13-retention-forget-and-export.md), [MI-14](14-health-and-efficiency-metrics.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

Passing unit tests for summary length or string concatenation does not demonstrate useful recall, restart recovery, resistance to stale claims, or preserved constraints. Create deterministic production-path scenarios and a separately opted-in model quality evaluation so future agents can measure improvement rather than asserting it.

## Starting points in the repository

- [test/persistent-memory.test.ts](../test/persistent-memory.test.ts) — existing persistence tests.
- [test/multi-turn-memory.test.ts](../test/multi-turn-memory.test.ts) — runtime injection tests.
- [test/memory-compaction.test.ts](../test/memory-compaction.test.ts) — compaction tests.
- [test/composite-memory.test.ts](../test/composite-memory.test.ts) — backend composition tests.
- [test/fixtures/memory-aaaa-1112-0001.json](../test/fixtures/memory-aaaa-1112-0001.json) — synthetic fixture.
- [package.json](../package.json) — test entry points.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Create a deterministic runner that invokes production memory/runtime helpers with temporary storage, fake tools/providers, an injected clock, and stable scope IDs. Do not copy the memory algorithm into a simulation.

2. Cover restart recall, crash recovery, concurrent appends, checkpoint failure, corrupted import, relevant retrieval among distractors, stale decisions, conflicting evidence, malicious memory, context overflow, canceled compaction, and forget during summarization.

3. Add scale fixtures at 100, 1,000, and 10,000 events where practical. Measure work performed and retained state, not just wall time. Ordinary incremental summarization should process each new event once aside from explicitly measured rebuilds.

4. Define labeled retrieval expectations and protected-fact/open-task preservation checks. Require complete scope isolation, no secret leakage in synthetic tests, exact protected-constraint preservation, deterministic tie ordering, and no duplicate durable events.

5. Create a separate optional live-model evaluation using the same synthetic scenarios. Report model/configuration, input/output tokens, cache observations, task success, unsupported claims, and repeated-run variance. A live provider failure must not invalidate deterministic correctness tests or be silently counted as a pass.

6. Add a single offline verification command covering the new suites and relevant existing memory/abort/prompt tests. Run on the declared supported Node version, using isolated temporary build outputs so concurrent runs cannot delete each other's files.

7. Store a concise baseline/result artifact and explain any changed expectations. Every reported gain should identify the scenario and measurement method.

## Acceptance criteria

- [ ] One offline command returns nonzero when any required production-path invariant regresses.
- [ ] Deliberately breaking scope isolation, durable reload, or protected-constraint retention causes a test failure.
- [ ] Test fixtures contain synthetic data only and leave no user-state artifacts in the checkout.
- [ ] The result report distinguishes deterministic correctness, measured efficiency, model-dependent quality, skipped checks, and unresolved failures.

## Validation

Proposed command: `npm run test:memory-improvements`, implemented by this task. Include the task-specific suites above and existing memory/prompt regression commands. Live evaluations require explicit provider configuration and a finite budget and are never part of the default offline test run.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not lower acceptance thresholds simply to make a new summarizer look better. Changing model or benchmark fixtures requires preserving comparable baseline results. Do not claim improved real-provider cache hit rates from a fake adapter test.

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
