# MI-15 — Create end-to-end memory regression and quality evaluations

Status: **DONE** · Priority: **P1** · Size: **M**

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

- [x] One offline command returns nonzero when any required production-path invariant regresses.
- [x] Deliberately breaking scope isolation, durable reload, or protected-constraint retention causes a test failure.
- [x] Test fixtures contain synthetic data only and leave no user-state artifacts in the checkout.
- [x] The result report distinguishes deterministic correctness, measured efficiency, model-dependent quality, skipped checks, and unresolved failures.

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
Status: DONE
Baseline revision: current checkout (commit f488d96 at the time of the step);
                 working tree also carries unrelated pre-existing changes that
                 were preserved and not committed.
Prerequisite evidence: MI-10, MI-11, MI-12, MI-13, and MI-14 completion records
                 are DONE; their focused suites all pass.
Reproduction / old behavior: no aggregate memory verification command existed
                 and no end-to-end production-path regression suite covered the
                 break detectors; package.json had no test:memory-improvements.
Changed files and behavior:
  - package.json: added test:memory-regression, test:memory-improvements
    (offline aggregate), and the opt-in memory:evaluate-live script.
  - test/memory-regression.test.ts: deterministic production-path suite (13
    scenarios) including the scope-isolation, durable-reload, and
    protected-constraint break detectors, scale fixtures (100/1,000 always;
    10,000 opt-in), and a categorized result report.
  - scripts/memory-live-model-quality.ts: separately opted-in live-model
    quality evaluation using the same synthetic scenario shape; skipped
    without provider configuration and exits nonzero on provider failure.
  - memory-improvements/results/mi-15-baseline.md: baseline/result artifact.
Validation commands and actual results:
  - npm run test:memory-regression: exit 0 (13 scenarios; scale-100 and
    scale-1000 measured).
  - npm run test:memory-improvements: exit 0 (26 offline suites).
  - scripts/memory-live-model-quality.ts type-check via tsc --noEmit: exit 0.
  - git diff --check: clean (exit 0).
Schema / configuration / compatibility changes: none; new npm scripts are
                 additive and do not change existing selection behavior.
Residual limitations and follow-up IDs:
  - The 10,000-event scale fixture is opt-in (MEMORY_SCALE_INCLUDE_10K=1) so
    the default offline gate stays fast; covered by a skipped-check report.
  - Live-model quality is not run in this environment (no provider config);
    reported as skipped, never as a pass. Follow-up: run it against an
    explicitly configured provider with a finite budget.
  - test:prompt-builder remains excluded from the aggregate due to the
    pre-existing, unrelated golden-fixture mismatch recorded under MI-09.
Rollback notes: remove the three added npm scripts and the new
                 test/memory-regression.test.ts and
                 scripts/memory-live-model-quality.ts files; no production
                 memory/runtime code was changed by this task.
Implementation commit(s): (see commit referencing MI-15)
```

Verification re-check (verification pass, plan step 13): repaired.
  - Node binary used: v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node),
    the PATH node/npm pair used by RunPackageScript.
  - Recorded check `npm run test:memory-regression` initially failed: scenario
    "retrieval ranks verified evidence, supersedes stale decisions, excludes
    untrusted constraints, redacts sensitive fields" asserted "verified
    evidence ranks above unverified claims" and got `unverified`. Root cause:
    commit 97add63 ("Add hybrid memory retrieval and non-executing prompt
    interrogation") changed memory/retrieval.ts to sort candidates
    newest-first before deduplication, so a newer unverified same-subject
    fact shadowed an older verified fact.
  - Reproduced with a focused failing test
    (`testVerifiedEvidenceBeatsNewerUnverifiedClaims` in
    test/memory-retrieval.test.ts); it failed red before the fix.
  - Fix: memory/retrieval.ts dedup now keeps the strongest-evidence record on
    a record-id or kind:subject collision (verified > unverified > refuted);
    on an evidence tie the newest-first order is preserved. Fix commit
    bfc0211.
  - Actual results after fix, all exit 0: test:memory-retrieval,
    test:memory-regression (13 scenarios; scale-100/scale-1000 measured),
    test:memory-hybrid-interrogation (related shared-retrieval suite),
    test:memory-improvements (26 offline suites), build. The recorded
    `scripts/memory-live-model-quality.ts type-check via tsc --noEmit` was run
    through the dedicated TypeCheck tool (files
    scripts/memory-live-model-quality.ts, noEmit) and exits 0.
  - git diff --check clean.
  - Prerequisites re-confirmed: MI-10 Status DONE (2db6a34/de7ea47), MI-11
    Status DONE (1b615eb/dfb107e), MI-12 Status DONE (a73932e/2850313), MI-13
    Status DONE (be980a5/d582d9e), MI-14 Status DONE (ba5f01a/f488d96); MI-15
    implementation commit fe83803 present in git log.
  - Skipped checks: scale-10000 (opt-in via MEMORY_SCALE_INCLUDE_10K=1) and
    the live-model quality evaluation (no provider config) remain skipped, as
    recorded originally; never counted as passes.
  - Pre-existing working-tree changes (.spec-keeper/config, package-lock.json,
    and untracked files) were left unstaged and untouched.
