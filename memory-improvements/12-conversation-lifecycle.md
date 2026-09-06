# MI-12 — Bound conversation state and validate continuation ownership

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-01](01-contracts-and-identity.md), [MI-09](09-context-budget-and-cache.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

`MultiTurnLlmRuntime` stores a complete messages-array snapshot for every generated response and has no release API. Long-running processes retain old conversations even after durable memory has captured useful outcomes. Continuation validation checks that individual call IDs exist, but does not establish an exact unique result set or explicit scope ownership.

## Starting points in the repository

- [llm/multi-turn-runtime.ts](../llm/multi-turn-runtime.ts) — ResponseState, responseStates, create.
- [llm/adapter-contract.ts](../llm/adapter-contract.ts) — tool-call and result contract.
- [main.ts](../main.ts) — step, review, direct, and run lifecycle boundaries.
- [test/multi-turn-runtime.test.ts](../test/multi-turn-runtime.test.ts) — runtime tests; check whether the script reaches them.
- [test/multi-turn-memory.test.ts](../test/multi-turn-memory.test.ts) — memory snapshot behavior.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Introduce an explicit conversation handle carrying scope, purpose, pending calls, memory snapshot revision, and lifecycle state. Maintain compatibility with previous_response_id through an owned lookup layer.

2. Validate continuation IDs against the active conversation and require the declared set of unique pending results. If partial results are intentionally supported, buffer them and define when generation may resume; do not accidentally accept omissions or duplicates.

3. Release completed conversations at safe lifecycle boundaries after their results are captured. Use bounded retention for intentionally resumable branches and a configurable ceiling as a final guard; never evict a live pending-call state silently.

4. Avoid retaining every historical full-array snapshot when only one continuation branch is used. Consider shared immutable message segments or a single owned transcript plus explicit branches. Preserve tool-call/result ordering.

5. On abort and shutdown, cancel in-flight work, resolve state ownership, and close/release safely. Durable session memory remains separate from the short-lived provider conversation handle.

6. Expose diagnostic counts and retained-size estimates to task 14 without storing conversation content in metrics.

## Acceptance criteria

- [x] Thousands of sequential completed stub conversations leave a bounded number of retained handles and message references.
- [x] Unknown, stale, cross-scope, duplicate, and missing result IDs fail before another provider call.
- [x] Active tool continuations preserve their initial memory snapshot and remain usable until completed or explicitly canceled.
- [x] Releasing a conversation does not delete durable events or change another active conversation.

## Validation

Add behavioral runtime lifecycle tests with a fake adapter and deterministic handles. Ensure the test command actually executes `test/multi-turn-runtime.test.ts` or a new dedicated suite. Run `test:multi-turn-memory`, `test:abort-paths`, and memory context tests. Prefer retained-object/count invariants over brittle absolute heap thresholds.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not expose stale response IDs as a cross-process resume mechanism. Resume reconstructs a new conversation from durable scoped evidence; it cannot assume provider response IDs or in-flight tool outputs survive restart.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: dfb107e (MI-11 completion)
Prerequisite evidence: MI-01 DONE (contracts/identity), MI-09 DONE (context budget/cache)
Reproduction / old behavior: MultiTurnLlmRuntime kept every generated response snapshot in responseStates with no release API; continuation validation only checked that individual tool-call ids existed, so duplicate/omitted ids and stale response ids were not rejected.
Changed files and behavior: llm/multi-turn-runtime.ts (owned conversation registry + response-id lookup; exact unique continuation validation before any provider call; bounded completed-conversation retention with maxRetainedConversations; releaseConversation/cancelConversation/close; conversationHandle/conversationStats metadata), main.ts (closeRuntimeClient at run boundaries and shutdown), test/multi-turn-lifecycle.test.ts (new behavioral suite), package.json (test:multi-turn-runtime runs the legacy runtime suite plus the new lifecycle suite).
Validation commands and actual results: npm run test:multi-turn-runtime (exit 0); npm run test:multi-turn-memory (exit 0); npm run test:abort-paths (exit 0); npm run test:memory-context-budget (exit 0); npm run test:memory-safe-compaction (exit 0); npm run build (exit 0); git diff --check (clean).
Schema / configuration / compatibility changes: optional request fields scope/purpose and response field conversation_id; new constructor option maxRetainedConversations (default 64, 0 releases immediately). previous_response_id remains supported through the owned lookup, but completed/stale response ids are now rejected instead of silently continued.
Residual limitations and follow-up IDs: conversationStats metadata is the MI-14 handoff; provider response ids are not a cross-process resume mechanism (resume reconstructs from durable scoped evidence).
Rollback notes: revert llm/multi-turn-runtime.ts and the closeRuntimeClient wiring in main.ts; test/multi-turn-lifecycle.test.ts and the package.json script are additive and can be dropped independently.
Implementation commit(s): a73932e
```

Verification re-check (verification pass, plan step 10): verified, no change needed.
  - Node binary used: v22.23.2 (/home/mike/.nvm/versions/node/v22.23.2/bin/node),
    reached for npm scripts via RunPackageScript env PATH override.
  - Actual results, all exit 0: test:multi-turn-runtime, test:multi-turn-memory,
    test:abort-paths, test:memory-context-budget, test:memory-safe-compaction, build.
  - git diff --check clean.
  - Prerequisites re-confirmed: MI-01 Status DONE (0d732be/0dfa638) and MI-09 Status
    DONE (c7c4d0f/57e3dcb); MI-12 implementation commit a73932e and completion record
    commit 2850313 present in git log.
  - Skipped checks: none. No code change; pre-existing working-tree changes left
    untouched.
