# MI-15 baseline and result artifact

Recorded 2026-09-06 from the MI-15 implementation on the current checkout.
This is a concise, non-sensitive baseline for the offline memory regression
and evaluation gate. No user-state or secret payloads are included; every
fixture is synthetic.

## Commands and actual results

| Command | Result |
| --- | --- |
| `npm run test:memory-regression` | exit 0 |
| `npm run test:memory-improvements` | exit 0 (26 offline suites) |
| `git diff --check` | clean (exit 0) |

## Deterministic correctness

`test/memory-regression.test.ts` passes 13 production-path scenarios against
`memory/` helpers with temporary storage and synthetic fixtures:

- restart recall and same-session cross-workspace isolation
- scope-isolation break detector (cross-scope append rejected)
- durable-reload break detector (corrupted state fails closed)
- truthful checkpoint outcomes survive crash/restart in order
- checkpoint durability failure reported as degraded, never success
- competing writers serialize with unique sequences
- corrupted legacy import fails closed
- retrieval ranks verified evidence, supersedes stale decisions, excludes
  untrusted constraints, redacts sensitive fields
- context overflow fails safely and stable prompt prefixes stay unchanged
- compaction preserves protected constraints/open work and cancels without
  losing the checkpoint
- forget during summarization and tombstones block deleted-memory resurrection
- health states and bounded auxiliary-request accounting distinguish
  measured/estimated/unknown usage
- scale fixtures measure event counts and model input sizes with no duplicate
  durable events

The three acceptance-criteria break detectors (scope isolation, durable
reload, protected-constraint retention) are covered by cross-scope append
rejection, corrupted-database failure, and authoritative-constraint retention
skip coverage respectively; each fails the suite when the production
invariant regresses.

## Measured efficiency

Scale fixtures use a deterministic recording summarizer with
`maxBatchEvents = 20`, so ordinary incremental summarization processes each
event exactly once (no re-summarization) aside from explicitly measured
rebuilds.

| Fixture | Events | Summary calls | Events summarized | Model input chars | Retained summary chars |
| --- | ---: | ---: | ---: | ---: | ---: |
| scale-100 | 100 | 5 | 100 | 31,859 | 28 |
| scale-1000 | 1,000 | 50 | 1,000 | 324,108 | 29 |

These are synthetic measured inputs, not live-provider token counts. Wall
time is intentionally not a gate; absolute latency belongs in a documented
benchmark environment.

## Model-dependent quality

Skipped in the offline run. The separately opted-in live-model evaluation is
`npm run memory:evaluate-live` (source: `scripts/memory-live-model-quality.ts`).
It requires explicit provider configuration (`LLM_PROVIDER` plus the selected
provider's documented environment variables) and a finite budget; it never
runs in the default offline aggregate, reports `skipped` when unconfigured,
and exits nonzero on a live provider failure so it can never be silently
counted as a pass.

## Skipped checks

- scale-10000: run `MEMORY_SCALE_INCLUDE_10K=1 npm run test:memory-regression`
  to include the 10,000-event fixture. The default offline gate keeps 100 and
  1,000 to stay fast while still proving the same accounting invariants.

## Unresolved failures

None.

## Changed expectations

None. These are the first recorded MI-15 results, so they establish the
baseline rather than changing an existing one. Any future reported gain must
identify the scenario and measurement method (event counts and model input
sizes are the supported measures; cache-hit claims require a real provider).
