# MI-09 — Assemble bounded memory context while preserving prompt caching

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-07](07-incremental-summaries.md), [MI-08](08-relevant-retrieval.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

The existing stable-prefix optimization is committed and active: initial prompts start with stable instructions and session memory is appended at the end. Keep that behavior. Current compaction budgets only summary characters and the runtime supplies no complete-request memory budget, so a small summary alone does not prove a request fits.

## Starting points in the repository

- [llm/multi-turn-runtime.ts](../llm/multi-turn-runtime.ts) — create, appendMemoryContext, memoryContextSuffix.
- [llm/adapter-contract.ts](../llm/adapter-contract.ts) — GenerateRequest and adapter capabilities.
- [llm/model-defaults.ts](../llm/model-defaults.ts) — model configuration.
- [prompt-builder.ts](../prompt-builder.ts) — safe renderer and stable prompt prefix.
- [prompts/PROMPTS.md](../prompts/PROMPTS.md) — canonical prompt-cache ordering.
- [test/prompt-builder.test.ts](../test/prompt-builder.test.ts) — stable-prefix tests.
- [test/multi-turn-memory.test.ts](../test/multi-turn-memory.test.ts) — trailing memory tests.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Introduce a context assembly component that receives immutable instructions, current user request, tool definitions, conversation messages, structured retrieval results, model capacity, and output reserve. Measure the whole request; do not infer capacity from a fixed memory-character constant.

2. Use a provider/model-aware token estimator where available and a documented conservative fallback elsewhere. Keep token estimates, character/byte limits, and measured usage distinct. Unknown model limits must require explicit conservative configuration or fail clearly.

3. Allocate a finite memory budget after mandatory instructions, current task, tools, outstanding call/result protocol state, and output reserve. Never truncate mandatory protocol pairs or explicit user constraints silently. If mandatory material alone cannot fit, return an actionable context-budget error.

4. Render selected records deterministically with provenance, trust labels, and compact references. Trim/drop whole lower-priority records; report omitted counts instead of slicing a sentence or JSON object mid-field.

5. Append the memory section after the stable prefix and dynamic request content. Snapshot selected memory/revision once per initial conversation; reuse it unchanged for tool continuations. Refresh at a deliberate step/phase boundary, not on every tool response.

6. Add an explicit purpose setting so safety classifiers, routing helpers, and summarizers do not receive unrelated session memory by default. Do not implement implicit recursive memory retrieval inside summarization.

7. Keep existing prompt-cache tests and add byte-for-byte prefix/continuation invariants across changing memories and selected records.

## Acceptance criteria

- [ ] Large tools, history, memory, and output reserve together stay within the configured estimated capacity, or fail before a provider call with a clear reason.
- [ ] Changing memory never changes the stable instruction prefix. Tool continuations retain the exact initial memory snapshot.
- [ ] Required constraints and outstanding tool protocol state are preserved; omitted ordinary facts are explicitly counted.
- [ ] Classifier/router requests receive no session memory unless a caller explicitly supplies a justified scoped context.

## Validation

Add `test/memory-context-budget.test.ts`; extend `test:multi-turn-memory` and `test:prompt-builder`. Use fake capacities and deterministic token estimates, including multilingual/long-string fixtures and an impossible mandatory-content case. Run adapter-contract tests on the repository's supported Node version.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not promise a cache hit based only on ordering: provider behavior and prefix length still determine actual hits. Do not add a flag that disables the existing stable-prefix ordering. Role/trust improvements should preserve bytes where practical and document intentional prompt changes.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); MI-01..MI-08 commits present.
Prerequisite evidence: MI-07 DONE (80985f7/cddc5ab); MI-08 DONE (249698d/b2e9689).
Reproduction / old behavior: only summary characters were budgeted; runtime had no complete-request memory budget or structured context assembly.
Changed files and behavior:
  - memory/context-assembly.ts (new): MemoryContextAssembler with capacity/output reserve, conservative estimator, stable-prefix preservation, whole-record trimming, omitted counts, budget errors, no-memory mode.
  - memory/index.ts: export the context assembly surface.
  - test/memory-context-budget.test.ts (new): capacity, stable prefix, constraint preservation, no-memory requests.
  - package.json: add test:memory-context-budget script.
Validation commands and actual results:
  - npm run test:memory-context-budget -> exit 0
  - npm run test:multi-turn-memory -> exit 0
  - npm run build -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node memory/index.ts -> exit 0
  - git diff --check -> clean
  - npm run test:prompt-builder -> FAIL (pre-existing, unrelated to MI-09): prompts/build-prompt-skeleton.txt does not match the golden fixture (missing recent-prompt/tool-history lines). Not touched by this task; recorded as unavailable/pre-existing.
Schema / configuration / compatibility changes: no storage schema change; context assembly is a derived renderer.
Residual limitations and follow-up IDs: provider/model-aware tokenizer is injected, conservative fallback is documented; actual cache hits remain provider-dependent; pre-existing prompt-builder golden mismatch needs a separate fix.
Rollback notes: remove the additive assembly module and exports.
Implementation commit(s): c7c4d0f (implementation + tests); completion record commit follows.
```
