# MI-01 — Define versioned memory contracts and identity boundaries

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: None; start here.

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

Current memory stores primarily index by `session_id`. `ContextRequest` advertises optional user/plan filters, but these are not a substitute for enforced ownership. `rememberAgentStep` currently puts the task ID into `user_id`. Establish one identity and event contract before introducing a new store; otherwise every subsequent migration will encode a different interpretation of a session.

## Starting points in the repository

- [memory/types.ts](../memory/types.ts) — MemoryContext, RememberInput, ContextRequest, MemoryModule.
- [memory/index.ts](../memory/index.ts) — public exports.
- [main.ts](../main.ts) — agentSessionId and rememberAgentStep.
- [memory/graph-store.ts](../memory/graph-store.ts) — existing identifiers and graph records.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Define distinct workspaceId, principalId, sessionId, runId, taskId, and eventId fields. A task ID must never stand in for a principal. Define an explicit local principal when no authenticated principal exists; do not derive an identity from credentials.

2. Canonicalize the workspace location once and record its repository identity where available. Document relocation and worktree behavior: independent workspaces are isolated by default; sharing requires an explicit stable workspace mapping. Never infer sharing from equal directory basenames.

3. Create a versioned event envelope with schemaVersion, identity, eventId, per-session sequence, run/step reference, timestamp, event kind, outcome, payload, and evidence references. Separate an asserted outcome from its verification level. Timestamps are descriptive, not ordering or uniqueness keys.

4. Define typed results for initialization, append, retrieval, flush, and close. Appends report durable success, duplicate, conflict, or failure. Retrieval reports its scope, revision, evidence, and degraded state. A successful void return must not conceal a failed durable write.

5. Define lifecycle and capability interfaces for the new implementation without requiring every old backend to implement persistence. Include cancellation, a context budget, a retrieval purpose, and immutable scope in request types. Keep existing factories usable through an explicit compatibility adapter until rollout.

6. Define stable semantic event IDs at the caller: retries of the same event reuse an ID; distinct attempts/effects get different IDs. Specify a content digest so a reused ID with different payload is a conflict, not a silent overwrite.

7. Export the new types and write a short schema/identity decision in the implementation documentation. Avoid changing the default backend in this task.

## Acceptance criteria

- [ ] Tests distinguish equal session names across different workspaces/principals, task IDs from principal IDs, and retries from new events.
- [ ] A scope is required before store access. Missing scope and mismatched scope cannot fall back to another user or workspace.
- [ ] Versioned events round-trip through JSON; invalid kinds, missing identity, invalid sequence values, and unsupported schema versions are rejected.
- [ ] Existing memory consumers compile unchanged until explicitly migrated.

## Validation

Add a focused contract/identity suite, proposed `test/memory-contract-v2.test.ts`. Run `npm run build` and the existing memory-selection and memory interface suites. Use synthetic absolute paths and temporary repositories to verify worktree identity behavior.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not modify live session files or the legacy database. This task only introduces contracts and adapters. Rollback removes the additive types and their callers; no stored-data migration should be required.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); working tree at main with pre-existing .spec-keeper/config and package.json/package-lock.json (tsx) changes preserved.
Prerequisite evidence: None (MI-01 has no dependencies). Source anchors re-read against the current checkout before implementation.
Reproduction / old behavior: memory/types.ts indexed primarily by session_id with optional user/plan filters; rememberAgentStep put the task ID into user_id (main.ts ~line 2235). No versioned envelope and no enforced scope existed.
Changed files and behavior:
  - memory/contracts-v2.ts (new): MemoryScopeV2/MemoryIdentityV2; versioned envelope (schemaVersion 1, positive per-session sequence, controlled kinds/outcomes); typed init/append/retrieve/flush/close results; validation helpers; canonicalizeWorkspacePath/deriveWorkspaceId; stableEventId/freshEventId; computeEventDigest.
  - memory/legacy-compat.ts (new): LegacyMemoryModuleAdapter (legacy MemoryModule -> MemoryModuleV2); append fails closed on durability.
  - memory/index.ts: additive re-exports of the new surface.
  - docs/MEMORY_V2_CONTRACT.md (new): schema/identity decisions.
  - test/memory-contract-v2.test.ts (new): scope/identity, envelope round-trip and rejection, digest conflict, workspace canonicalization, adapter tests.
  - package.json: add test:memory-contract-v2 script (kept the pre-existing tsx dependency intact).
Validation commands and actual results:
  - npm run test:memory-contract-v2 -> exit 0
  - npm run build -> exit 0
  - npm run test:memory-selection -> exit 0
  - npm run test:memory -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node memory/index.ts -> exit 0
  - git diff --check -> clean (exit 0)
Schema / configuration / compatibility changes: new event schema version 1; no default backend change; legacy factories remain usable through the explicit adapter until rollout.
Residual limitations and follow-up IDs: legacy adapter append reports failure (non-durable) by design; the durable event store lands in MI-03; persistent-v2 selection is deferred to MI-16.
Rollback notes: remove the additive types/exports and their adapter; no stored-data migration is required.
Implementation commit(s): 0d732be (implementation + tests + docs); completion record commit follows.
Verification pass (MI-01, plan step 3): BLOCKED by the toolchain gate; Node-dependent validation was not re-run. Active `node` is v18.19.1 (below engines.node >=22.9.0); `scripts/check-node-version.cjs` exits 1 with "Elastic Agent requires Node.js >= 22.9.0 (found v18.19.1)". Supported Node v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node) is outside the workspace, and no supported `node` executable is reachable from within the workspace (`Find` returned no matches). Skipped: test:memory-contract-v2, npm run build, test:memory-selection, test:memory, npx tsc --noEmit ... memory/index.ts. Node-independent checks passed: commits 0d732be/0dfa638 present in git log; claimed files exist (memory/contracts-v2.ts, memory/legacy-compat.ts, memory/index.ts, docs/MEMORY_V2_CONTRACT.md, test/memory-contract-v2.test.ts); package.json has test:memory-contract-v2; git diff --check clean. Not annotated "verified, no change needed".
Re-verification pass (MI-01, plan step 3, re-run): verified, no change needed. Ran the recorded validation commands under supported Node v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node) via RunPackageScript env PATH override (PATH=/home/mike/.nvm/versions/node/v22.23.2/bin:/usr/local/bin:/usr/bin:/bin):
  - npm run test:memory-contract-v2 -> exit 0
  - npm run test:memory-selection -> exit 0
  - npm run test:memory -> exit 0
  - npm run build -> exit 0
  - TypeCheck equivalent for memory/index.ts (tsc --noEmit, repo-approved flags) -> exit 0
  - git diff --check -> clean (exit 0)
Skipped checks: none. No code change required; only this completion record was updated. Node-independent checks re-confirmed: 0d732be and 0dfa638 resolve via git rev-parse; package.json has test:memory-contract-v2; claimed files exist. Supported Node actually used: v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node).
```
