# MI-16 — Roll out the new memory backend with explicit migration and rollback

Status: **TODO** · Priority: **P1** · Size: **M**

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

- [ ] A new user can follow the documented setup and prove restart recall with the supported runtime.
- [ ] Unknown backend/configuration, incompatible schemas, and missing permissions fail with useful redacted diagnostics.
- [ ] Rollback does not destroy old or new data and accurately describes what each backend can recall.
- [ ] All earlier task records include validation evidence; the default is not promoted with unresolved required privacy, durability, scope, or context-budget failures.

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
