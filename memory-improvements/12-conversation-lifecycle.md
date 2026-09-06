# MI-12 — Bound conversation state and validate continuation ownership

Status: **TODO** · Priority: **P1** · Size: **M**

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

- [ ] Thousands of sequential completed stub conversations leave a bounded number of retained handles and message references.
- [ ] Unknown, stale, cross-scope, duplicate, and missing result IDs fail before another provider call.
- [ ] Active tool continuations preserve their initial memory snapshot and remain usable until completed or explicitly canceled.
- [ ] Releasing a conversation does not delete durable events or change another active conversation.

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
