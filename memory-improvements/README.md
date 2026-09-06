# Memory improvements — implementation plan

Prepared 2026-09-06 from the root checkout at `c0d5f09`. This directory contains
16 focused implementation tasks. MI-01 through MI-16 are **DONE** — each
numbered task file carries its own completion record with validation evidence
and implementation commits. MI-16 (rollout and operator documentation) is
complete and documents adoption, migration, and rollback; see
[16-rollout-and-operator-documentation.md](16-rollout-and-operator-documentation.md).
No memory code or runtime state was changed to produce the original plan; the
per-task completion records list the implementation commits and checks actually
run.

Start with [MI-01](01-contracts-and-identity.md). Each numbered file is a work
order with source anchors, prerequisites, implementation steps, acceptance
criteria, tests, failure behavior, and a completion record.

## Outcome

The agent should retain scoped, trustworthy evidence across restarts; recover
committed progress after interruption; retrieve only relevant context; and
preserve constraints and unfinished work within a finite model budget. It must
also be able to forget data and explain when recall or persistence is degraded.

Preserve the existing cache-friendly prompt ordering. The stable-prefix change
is already on `main` (`74215de`, tests in `c7aab87`), not waiting in a worktree or
behind an enabling flag. New memory context remains a trailing section and is
frozen across tool continuations of one conversation.

## Current evidence and limitations

- `memory/persistent.ts` starts with empty maps and has no reload path. It
  writes a version-1 JSON document during finalization.
- Each persistent remember passes full history plus the prior summary to the
  summarizer. The default CLI supplies no LLM summarizer; it uses the
  deterministic history renderer.
- Session filenames replace characters and truncate identifiers, which can
  collide. Runtime task IDs are currently assigned to `user_id`.
- Persistent retrieval returns a session summary; composite mode can repeat
  context from stores fed the same events.
- Compaction uses a summary-character threshold rather than a complete-request
  model budget, and graph/composite modes lack the same compaction interface.
- Runtime conversation snapshots accumulate without an explicit release path.
- Existing memory tests are useful starting points, but do not establish all
  the durability, privacy, isolation, and retrieval guarantees in this plan.

These are source-review observations, not live-provider performance results.
Do not read `data.json`, existing conversation logs, credentials, or live memory
payloads to implement the tasks. Use synthetic fixtures and temporary state.

## Target design and decisions

Use three layers with one authoritative durable owner:

1. **Sanitized event history:** scoped, versioned, idempotent observations and
   outcomes in a dedicated transactional store.
2. **Derived knowledge:** facts, decisions, exact constraints, open work, and
   revisioned summaries that can be rebuilt from retained events.
3. **Context assembly:** permission-filtered retrieval, deterministic ranking,
   complete-request budgeting, and trailing prompt rendering.

Implementation defaults for this plan:

- Use a new isolated SQLite event store, reusing existing dependencies after
  verifying their local APIs. Do not repurpose the repository's legacy database.
  Journal/durability settings and filesystem support must be tested explicitly.
- Identity is workspace + principal + session, with distinct run/task/event IDs.
  Cross-session or cross-worktree sharing is an explicit policy, never a basename
  or session-string coincidence.
- Summaries and search indexes are projections, not the only record of what
  happened. Model-generated statements remain claims unless supported by evidence.
- Start with deterministic lexical retrieval. No new graph/vector service or
  embedding provider is required for this plan.
- Redact before storage, model summarization, rendering, and logging. Keep default
  diagnostics metadata-only. Local deletion does not promise forensic erasure
  or deletion of data already sent to a provider.
- Stage runtime adoption through `ELAGENT_MEMORY_TYPE=persistent-v2`; preserve old
  selection behavior until the final rollout task deliberately migrates defaults.
  As of MI-16, `persistent-v2` is available as an opt-in backend while the legacy
  default remains unchanged.
- Memory errors may degrade recall while user work continues, but durability
  failure cannot be reported as success. Never replay a tool mutation merely
  because its memory append failed.

If a decision proves unsuitable, update this index and affected task contracts
with the evidence before changing downstream implementation. Avoid competing
identity schemes, duplicate authoritative stores, and ad hoc per-backend budgets.

## Tasks and dependencies

Size is scope, not a time estimate: S = localized, M = several modules,
L = a larger architectural unit. All tasks are P1 because they form the core
memory reliability workstream; execute dependencies first rather than starting
with the most visually interesting backend feature.

| Task | Outcome | Prerequisites | Size |
| --- | --- | --- | --- |
| [MI-01](01-contracts-and-identity.md) | Define versioned memory contracts and identity boundaries | — | M |
| [MI-02](02-privacy-and-trust.md) | Enforce privacy and trust at memory ingestion and output | MI-01 | M |
| [MI-03](03-durable-event-store.md) | Implement an isolated transactional event store | MI-01, MI-02 | L |
| [MI-04](04-reload-and-legacy-import.md) | Restore sessions and import legacy memory safely | MI-03 | M |
| [MI-05](05-runtime-checkpoints-and-outcomes.md) | Checkpoint runtime progress with truthful outcomes | MI-04 | M |
| [MI-06](06-structured-facts-and-provenance.md) | Build a structured view of facts, decisions, and unfinished work | MI-05 | M |
| [MI-07](07-incremental-summaries.md) | Make summaries incremental, revisioned, and cancelable | MI-06 | M |
| [MI-08](08-relevant-retrieval.md) | Retrieve relevant evidence and deduplicate memory | MI-06 | M |
| [MI-09](09-context-budget-and-cache.md) | Assemble bounded memory context while preserving prompt caching | MI-07, MI-08 | M |
| [MI-10](10-safe-compaction.md) | Compact derived summaries without losing constraints or progress | MI-09 | M |
| [MI-11](11-backend-capabilities-and-composite.md) | Unify backend capabilities and eliminate duplicate composite context | MI-09, MI-10 | M |
| [MI-12](12-conversation-lifecycle.md) | Bound conversation state and validate continuation ownership | MI-01, MI-09 | M |
| [MI-13](13-retention-forget-and-export.md) | Implement retention, forgetting, and safe export | MI-04, MI-06, MI-07, MI-08, MI-11, MI-12 | M |
| [MI-14](14-health-and-efficiency-metrics.md) | Expose memory health, durability, and efficiency metrics | MI-05, MI-07, MI-08, MI-09, MI-11, MI-12 | M |
| [MI-15](15-regression-and-behavior-evaluations.md) | Create end-to-end memory regression and quality evaluations | MI-10, MI-11, MI-12, MI-13, MI-14 | M |
| [MI-16](16-rollout-and-operator-documentation.md) | Roll out the new memory backend with explicit migration and rollback | MI-15 | M |

## Suggested delivery stages

1. **Contracts and trustworthy durability:** MI-01 through MI-05. Demonstrate
   two-process recall and committed checkpoint recovery first.
2. **Useful knowledge:** MI-06, then MI-07 and MI-08. These two tasks can be
   developed independently once their shared structured-record contract holds.
3. **Bounded context:** MI-09, MI-10, MI-11, and MI-12 according to their
   individual prerequisites. Preserve the existing prompt-prefix tests.
4. **Operational lifecycle:** MI-13 and MI-14, followed by MI-15.
5. **Adoption:** MI-16 promotes a verified candidate and documents migration.

Independent tasks may be scheduled separately, but shared-file changes need
coordination. This plan does not require spawning multiple agents.

## Execution contract for the implementing agent

1. Read current repository guidance, this index, the selected task, and its
   prerequisite completion records. Verify the baseline and preserve unrelated
   working-tree changes. Do not claim a prerequisite is complete based solely
   on its task title or a stale document.
2. Reproduce the old behavior with a focused test of production code. For new
   capabilities, implement the smallest meaningful contract test first.
3. Work within the selected task. Record cross-task discoveries by ID rather
   than silently broadening the change into a rewrite of the CLI or providers.
4. Use temporary owner-only files/databases, fake providers, local fixture
   servers, and deterministic clocks. No real credentials, imported personal
   memory, or live external mutations are needed for offline validation.
5. Check the supported Node/toolchain before running tests. A prior review found
   Node 18 incompatible with `process.loadEnvFile`; do not assume the currently
   installed runtime is supported or fix unrelated dependencies without evidence.
6. Run the relevant suite, `npm run build` for code changes, and
   `git diff --check`. Once checks pass, expand testing only for affected contracts
   or unresolved risks. Record actual results, including unavailable checks.
7. Update the task's completion record with code/commit references, compatibility
   changes, validation, and rollback. Follow repository commit guidance, staging
   only the intended files. Implementation does not itself authorize deployment,
   external messages, or bulk migration/deletion of real user memory.
8. Mark DONE only after acceptance criteria hold. A blocked environment leaves
   the relevant validation/promotion pending; a smaller implementation must not
   silently redefine completion.

## Verification expectations

Every task names concrete tests. The final offline aggregate in MI-15 must
cover at least:

- exact scope isolation and idempotent event writes;
- real two-process reload, competing writers, and crash/restart checkpoints;
- truthful unknown/failed/verified outcomes;
- synthetic-secret exclusion and untrusted-memory handling;
- relevant retrieval, deduplication, and superseded-fact handling;
- bounded complete requests and unchanged stable prompt prefixes;
- preserved constraints/open tasks through compaction;
- no deleted-memory resurrection from caches or pending model calls;
- bounded conversation retention and valid tool continuations;
- explicit health states and accounting for auxiliary requests.

Efficiency targets must measure actual work, including event counts and model
input sizes. Absolute latency thresholds belong in a documented benchmark
environment, not flaky unit tests. Live-model evaluations are optional, separately
configured, and budgeted; they never replace deterministic correctness gates.

## Relationship to the repository-wide backlog

This directory expands the memory recommendations in
[SELF_REPAIR_BACKLOG.md](../docs/SELF_REPAIR_BACKLOG.md). Detailed tasks use
**MI-01 through MI-16** so their IDs remain distinct from the broad backlog's
MEM/RUN/SECLOG/TEST identifiers.

| Broad backlog item | Detailed tasks here |
| --- | --- |
| MEM-01: persistent reload | MI-01, MI-03, MI-04, MI-05 |
| MEM-02: identity/checkpoints | MI-01, MI-03, MI-05 |
| MEM-03: context budgets | MI-09, MI-10, MI-11 |
| MEM-04: incremental summaries/retrieval | MI-06, MI-07, MI-08 |
| MEM-05: privacy/retention/quality | MI-02, MI-06, MI-10, MI-13, MI-15 |
| RUN-03: conversation lifecycle | MI-12 |
| RUN-04: truthful outcomes | MI-05, MI-06 |
| SECLOG-01/02: privacy and metrics | MI-02, MI-14 |
| TEST-01/03: behavioral verification | task-local tests and MI-15 |

Coordinate shared changes with those items and update both records when work
satisfies them. Do not mark a broad epic complete merely because one detailed
task is finished.
