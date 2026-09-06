# MI-04 — Restore sessions and import legacy memory safely

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-03](03-durable-event-store.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

`PersistentMemoryModule` has no disk loader even though the README describes reuse of a session across runs. This task makes restart recall real and gives existing version-1 memory JSON an explicit, non-destructive migration path. Imported model summaries are historical claims, not verified facts.

## Starting points in the repository

- [memory/persistent.ts](../memory/persistent.ts) — PersistentMemoryDocument, resolvePath, ownContext.
- [README.md](../README.md) — explicit session ID and persistent backend behavior.
- [test/fixtures/memory-aaaa-1112-0001.json](../test/fixtures/memory-aaaa-1112-0001.json) — synthetic legacy fixture.
- [docs/examples/README.md](../docs/examples/README.md) — fixture provenance.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Add an asynchronous initialization/load operation for an exact scope. Distinguish an absent session from an invalid, inaccessible, or incompatible one. Retrieval must wait for initialization, including the first call after a process restart.

2. Rebuild the session view from committed events plus an optional validated derived checkpoint. If a derived checkpoint is absent or invalid, rebuild from events rather than inventing an empty session.

3. Create an explicit legacy importer for a caller-selected file. Validate size, nesting, version, session identity, step count, and field types before conversion. Never discover or load arbitrary similarly named files automatically.

4. Handle filename-sanitization collisions by validating embedded identity and requiring an explicit target scope. Preserve the original session string. Legacy user_id values may be task IDs: retain them as legacy metadata until their interpretation is known.

5. Import sanitized legacy steps and narrative with stable import/event IDs and provenance. Record a source digest and migration version so rerunning the import is idempotent. Do not manufacture missing timestamps, evidence, or verified outcomes.

6. Keep original files untouched. For corruption, provide an actionable redacted diagnostic and an explicit quarantine/copy procedure; do not overwrite the only copy with an empty document.

7. Correct the README so it distinguishes the old backend's write-only behavior from the new backend's demonstrated restart recall until rollout is complete.

## Acceptance criteria

- [ ] Process A records a session; process B recalls it and appends; process C sees both events without duplication.
- [ ] A different workspace/principal with the same session ID retrieves nothing from that session.
- [ ] Importing the same fixture twice creates one logical history. Two legacy filenames mapping to the same sanitized basename do not merge implicitly.
- [ ] Corrupt, too-large, mismatched-identity, and future-version documents leave originals intact and never appear as valid empty memory.

## Validation

Add two-process reload and legacy-import tests, proposed `test/memory-reload.test.ts` and `test/memory-import.test.ts`. Extend `test:persistent-memory` where contracts overlap, using the artificial fixture rather than live memory-output files.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

No automatic bulk migration. Import failures do not prevent an unrelated session from running, but a request to resume a specific unreadable session must disclose degraded/missing recall. Rollback selects the old backend; imported state remains separate and originals remain available.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); MI-01..MI-03 commits present.
Prerequisite evidence: MI-03 DONE (5d12c2f/71d18bd).
Reproduction / old behavior: PersistentMemoryModule had no disk loader; README implied reusing --session-id would recall across runs when the default backend is write-only.
Changed files and behavior:
  - memory/session-loader.ts (new): loadSession distinguishes absent/ready/failure and rebuilds a session view by paging committed events.
  - memory/legacy-import.ts (new): explicit caller-selected import with size/version/identity/step/field validation; stable source-digest-derived event IDs; unverified imported claims; quarantineLegacyFile helper; originals never modified.
  - memory/index.ts: export loader and importer.
  - README.md: corrected the --session-id recall claim to distinguish old write-only backend from new event-store restart recall.
  - test/memory-reload.test.ts (new): process A/B/C reload and scope isolation.
  - test/memory-import.test.ts (new): idempotent re-import, no implicit merge, safe failure cases.
  - package.json: add test:memory-reload and test:memory-import scripts.
Validation commands and actual results:
  - npm run test:memory-reload -> exit 0
  - npm run test:memory-import -> exit 0
  - npm run test:memory-contract-v2 -> exit 0
  - npm run test:memory-privacy -> exit 0
  - npm run test:memory-event-store -> exit 0
  - npm run build -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node memory/index.ts -> exit 0
  - git diff --check -> clean
Schema / configuration / compatibility changes: importer records migrationVersion=1 and sourceDigest on imported events; legacy files remain untouched.
Residual limitations and follow-up IDs: derived checkpoints are not yet produced (later tasks); import of a specific unreadable session reports failure but does not quarantine automatically (operator uses quarantineLegacyFile).
Rollback notes: remove the additive loader/importer and their callers; imported state remains separate and originals remain available.
Implementation commit(s): e37a96e (implementation + tests + README); completion record commit follows.
Verification pass (MI-04, plan step 5): BLOCKED by the toolchain gate; Node-dependent validation was not re-run. Active `node` is v18.19.1 (below engines.node >=22.9.0); `scripts/check-node-version.cjs` exits 1 with "Elastic Agent requires Node.js >= 22.9.0 (found v18.19.1)". Supported Node v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node) is outside the workspace; `nvm use 22.23.2` and direct execution of that binary are both refused by the safety classifier. Skipped: test:memory-reload, test:memory-import, test:memory-contract-v2, test:memory-privacy, test:memory-event-store, npm run build. Node-independent checks passed: prerequisite MI-03 DONE (5d12c2f/71d18bd) confirmed; commits e37a96e/ac048b4 present in git log; git diff --check clean. Not annotated "verified, no change needed".
```
