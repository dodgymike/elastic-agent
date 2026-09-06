# MI-07 — Make summaries incremental, revisioned, and cancelable

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-06](06-structured-facts-and-provenance.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

The persistent backend currently calls its summarizer with all entries and the previous summary after each remember, then summarizes the full history again during finalize. The default CLI does not inject an LLM summarizer. Compaction can therefore be followed by another full-history rendering that expands memory again.

## Starting points in the repository

- [memory/inMemory.ts](../memory/inMemory.ts) — MemorySummarizeInput and defaultHistorySummarizer.
- [memory/persistent.ts](../memory/persistent.ts) — remember and finalize.
- [main.ts](../main.ts) — memory backend factory options.
- [llm/adapter-contract.ts](../llm/adapter-contract.ts) — generation cancellation and output controls.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Define a summary checkpoint containing scope, coveredThroughSequence, revision, text/structured sections, summarizer version, policy version, and input digest. A summary is a derived artifact, not a replacement for events.

2. Pass only events after the checkpoint cursor plus the previous bounded summary and relevant protected facts. Batch by bounded event/byte counts or step boundaries; avoid a model call on every small observation.

3. Keep the deterministic summarizer as an explicitly named offline option. Add LLM summarization only through an injected provider-compatible role configuration, with explicit deadline, cancellation, input/output budgets, and model metadata.

4. Commit a new summary and cursor atomically using a revision check. A stale concurrent summary must not overwrite a newer checkpoint or cross a forget/retention generation.

5. On timeout, invalid output, or provider failure, retain the previous summary and cursor. Unsummarized events stay retrievable and may be retried without advancing past them.

6. Change finalization to flush pending durable work rather than reconstructing an unbounded full-history summary. Schedule full rebuild/consolidation only as an explicit bounded maintenance operation.

## Acceptance criteria

- [ ] For a 100-step fixture, each ordinary update receives only the new batch and bounded prior summary; total event processing is not quadratic.
- [ ] An interrupted or stale summarizer neither skips events nor overwrites a later summary.
- [ ] Changing summarizer version marks derived summaries stale/rebuildable without losing events.
- [ ] No summarizer call is made when the selected deterministic mode or unchanged cursor makes it unnecessary.

## Validation

Add `test/memory-incremental-summary.test.ts` with a fake summarizer that records input sizes, returns invalid data, delays, and completes out of order. Run the existing memory-compaction and persistent-memory suites. Live model quality evaluation is optional and belongs to task 15.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not silently introduce a second provider or send memories to a new service. Changing the summarizer should not change ownership, authorization, or event identity. Reverting this feature rebuilds derived summaries from the event store.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); MI-01..MI-06 commits present.
Prerequisite evidence: MI-06 DONE (b08954a/b451455).
Reproduction / old behavior: persistent backend re-summarized full history after every remember and during finalize; no cursor/versioning/stale protection existed.
Changed files and behavior:
  - memory/incremental-summary.ts (new): SummaryCheckpointV2, IncrementalSummaryManager, deterministic offline renderer; batched, revisioned, cancelable advances.
  - memory/index.ts: export the incremental summary surface.
  - test/memory-incremental-summary.test.ts (new): non-quadratic batching, invalid-output retry, stale out-of-order completion, timeout retention, versioning, no-call paths.
  - package.json: add test:memory-incremental-summary script.
Validation commands and actual results:
  - npm run test:memory-incremental-summary -> exit 0
  - npm run test:memory-compaction -> exit 0
  - npm run test:persistent-memory -> exit 0
  - npm run test:memory-facts -> exit 0
  - npm run build -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node memory/index.ts -> exit 0
  - git diff --check -> clean
Schema / configuration / compatibility changes: derived summary policyVersion=1; no storage schema change.
Residual limitations and follow-up IDs: LLM summarizer integration stays opt-in via injected IncrementalSummarizer; finalization flush wiring for the new backend lands with rollout (MI-16).
Rollback notes: remove the additive module and exports; derived summaries rebuild from events.
Implementation commit(s): 80985f7 (implementation + tests); completion record commit follows.
```

Verification re-check (verification pass, plan step 5): verified, no change needed.
  - Node binary used: v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node),
    reached for npm scripts via RunPackageScript env PATH override.
  - Actual results, all exit 0: test:memory-incremental-summary, test:memory-compaction,
    test:persistent-memory, test:memory-facts, build.
  - The recorded literal `npx tsc --noEmit ... memory/index.ts` check was run through the
    dedicated TypeCheck tool (repo-approved fixed flags, memory/index.ts, noEmit); exit 0.
  - git diff --check clean.
  - Prerequisite re-confirmed: MI-06 Status DONE; commits b08954a/b451455 (MI-06) and
    80985f7 (MI-07) present in git log.
  - Skipped checks: none. No code change.
