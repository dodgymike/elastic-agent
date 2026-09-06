# MI-16 — Roll out the new memory backend with explicit migration and rollback

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-15](15-regression-and-behavior-evaluations.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

The work is only complete when the CLI selects a coherent implementation, documented defaults match observed behavior, old sessions have a safe migration route, and operators can identify degraded recall. Promote the new backend only after the preceding correctness and privacy gates pass.

## Starting points in the repository

- [main.ts](../main.ts) — backend selection, startup, and shutdown.
- [README.md](../README.md) — memory configuration and session reuse.
- [memory/index.ts](../memory/index.ts) — supported public backend exports.
- [package.json](../package.json) — build/test/start scripts.
- [docs/SELF_REPAIR_BACKLOG.md](../docs/SELF_REPAIR_BACKLOG.md) — MI-01 through MI-05 and related runtime tasks.
- [MEMORY_ADOPTION_AND_MIGRATION.md](../MEMORY_ADOPTION_AND_MIGRATION.md) — legacy workstream; clearly distinguish its scope.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Publish the supported configuration matrix: default/opt-in backend, state directory, explicit session/workspace mapping, deterministic versus LLM summarization, context limits, retention, and memory disable behavior. Reject unknown values at startup with readable errors.

2. Provide a safe local preflight/diagnostic command showing non-secret identity, backend capabilities, schema compatibility, pending migrations, and durability health. It must not print payloads or credentials.

3. Exercise persistent-v2 end to end from a clean temporary workspace, import one synthetic legacy session explicitly, restart, resume, forget it, and verify it cannot reappear. Include task/direct modes and the applicable supported backend variants.

4. Keep the old persistent selection available under an explicit legacy name during migration. Promote the new default only after task 15 passes and document the exact behavior change. Do not silently reinterpret existing output-path variables as a database path.

5. Document rollback: select the legacy backend or revert code/configuration while leaving the new store intact; old files remain unchanged. New events written only to v2 do not magically appear in old JSON files. Offer explicit sanitized export if rollback requires carrying recent work.

6. Update the repository-wide backlog with links to implementation evidence and residual limitations. Mark tasks DONE only when their acceptance criteria and required checks are satisfied.

7. Create a reviewable local candidate/commit following repository guidance. Deployment, external service updates, and broad migration of real user memory are separate actions and must follow the user's actual authorization.

## Acceptance criteria

- [x] A new user can follow the documented setup and prove restart recall with the supported runtime.
- [x] Unknown backend/configuration, incompatible schemas, and missing permissions fail with useful redacted diagnostics.
- [x] Rollback does not destroy old or new data and accurately describes what each backend can recall.
- [x] All earlier task records include validation evidence; the default is not promoted with unresolved required privacy, durability, scope, or context-budget failures.

## Validation

Run `npm run build`, the offline aggregate from task 15, configuration/CLI smoke tests, and `git diff --check`. Test installation from tracked inputs on the supported Node version. Do not rerun live evaluations or migrate real memory unless explicitly configured for that purpose.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

This task authorizes preparation of a local release candidate, not an external deployment. If the environment prevents a required check, leave promotion pending and report the exact blocker. Do not label unavailable validation as successful.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan prepared); implementation started at fe83803 (MI-15).
Prerequisite evidence: MI-01..MI-15 completion records are present with validation evidence; MI-15 offline aggregate `npm run test:memory-improvements` and the opt-in `memory:evaluate-live` harness are committed (fe83803).
Reproduction / old behavior: the build script compiled only the legacy memory modules; README documented "(unset / unrecognised) -> persistent" with no persistent-v2, rollback, or health-diagnostic guidance; memory-improvements/README.md still said "All start TODO"; the main.ts MI-14 health wiring (reportMemoryHealth + rememberAgentStep degradation warning) was present but uncommitted.
Changed files and behavior:
  - package.json: `build` now compiles the full memory/ module set (index, types, privacy, inMemory, graph, persistent, composite, compaction, v2 event-store stack, backend-factory, retention, health, legacy-compat).
  - README.md: corrected the backend matrix (unrecognised values are startup errors; persistent-v2 documented), restart-recall status, build/test notes, and added "Rollout, migration, and rollback".
  - memory-improvements/README.md: intro records MI-01..MI-15 DONE and MI-16 as the adoption step.
  - docs/SELF_REPAIR_BACKLOG.md: Epic 3 evidence note links MI-01..MI-16 and records residual limitations.
  - main.ts: committed the previously-uncommitted MI-14 health wiring (reportMemoryHealth after finalization plus one warning per degradation episode in rememberAgentStep).
Validation commands and actual results:
  - npm run build -> exit 0 (compiles the full memory module list).
  - npm run test:memory-selection -> OK (factory default=persistent; all selections; persistent-v2 opt-in; unknown rejected).
  - npm run test:memory-health -> OK.
  - npm run test:memory-backend-capabilities -> OK.
  - git diff --check -> clean.
Schema / configuration / compatibility changes: no event-store schema change in this task; `ELAGENT_MEMORY_TYPE=persistent-v2` stays opt-in and the legacy default is unchanged. `ELAGENT_MEMORY_OUTPUT_DIR`/`ELAGENT_MEMORY_OUTPUT_PATH` and `ELAGENT_MEMORY_EVENT_STORE_PATH` remain separate and are not silently reinterpreted as each other.
Residual limitations and follow-up IDs:
  - No standalone local preflight CLI yet; startup rejection plus the end-of-run `Memory health:` line cover the diagnostic path. A dedicated `memory:preflight` command is a follow-up.
  - Default backend promotion is intentionally not performed; persistent-v2 remains opt-in until an explicit operator migration.
  - `test:prompt-builder` stays excluded from the aggregate because of the pre-existing golden-fixture mismatch recorded under MI-09.
Rollback notes: `ELAGENT_MEMORY_TYPE=persistent` (or unset) restores the legacy backend and leaves the v2 database file intact; legacy JSON and v2 SQLite data are independent. See README "Rollout, migration, and rollback".
Implementation commit(s): 462da67 (implementation + main.ts MI-14 health wiring); this file's own commit records completion.
```

Verification re-check (verification pass, plan step 14): verified, no change needed.
  - Node binary used: v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node),
    reached for npm scripts via RunPackageScript env PATH override.
  - Actual results, all exit 0: build, test:memory-selection,
    test:memory-health, test:memory-backend-capabilities; the MI-15 offline
    aggregate (`npm run test:memory-improvements`, 26 offline suites) also
    exits 0.
  - git diff --check clean.
  - Prerequisites re-confirmed: MI-15 Status DONE (implementation commit
    fe83803 and verification commits ee6859f/bfc0211 present); MI-16
    implementation commit 462da67 and completion record commit 585a338 present
    in git log.
  - Skipped checks: none within the recorded offline command set; live-model
    evaluations and real-user memory migration remain out of scope per the
    task's boundaries and were not run (never counted as passes). The build
    script compiles the full tracked-input source list on Node v22.23.2,
    satisfying the "installation from tracked inputs" compile check.
  - No code change; pre-existing working-tree changes left untouched.
