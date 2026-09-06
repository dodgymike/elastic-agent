# MI-01 — Define versioned memory contracts and identity boundaries

Status: **TODO** · Priority: **P1** · Size: **M**

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
