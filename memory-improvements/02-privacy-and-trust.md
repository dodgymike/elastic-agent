# MI-02 — Enforce privacy and trust at memory ingestion and output

Status: **TODO** · Priority: **P1** · Size: **M**

Dependencies: [MI-01](01-contracts-and-identity.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

`sanitizeJson` in the persistent backend only makes values serializable. Findings and narrative feedback can contain copied credentials or injected instructions. The shared LLM runtime also logs full prompts and prints prompts on adapter errors, so protecting only a new storage file would leave memory content exposed through another sink.

## Starting points in the repository

- [memory/persistent.ts](../memory/persistent.ts) — sanitizeJson and toStepRecord.
- [main.ts](../main.ts) — rememberAgentStep.
- [llm/multi-turn-runtime.ts](../llm/multi-turn-runtime.ts) — appendMemoryContext, adapter error logging, appendLlmLog.
- [llm/llm-log.ts](../llm/llm-log.ts) — appendLlmLog.
- [llm/prompt-logger.ts](../llm/prompt-logger.ts) — prompt logging.
- [tools/path-privacy.ts](../tools/path-privacy.ts) — existing protected-path rules; these are not content redaction.

Paths above are existing files. New filenames suggested below are proposals;
choose equivalent locations if current architecture makes them more appropriate.

## Implementation steps

1. Define an allowlisted ingestion payload. Store concise observations, decisions, constraints, outcomes, and evidence references; exclude raw tool dumps, credentials, private internal reasoning, and unrestricted environment/configuration objects.

2. Create one data-handling boundary used before persistence, summarization requests, retrieval rendering, and log/error output. Normalize and redact known sensitive fields and synthetic secret patterns; reject oversized/unserializable input with structured diagnostics. Do not claim regex redaction detects every secret.

3. Attach provenance and a trust category to each record: user-authorized constraint, observed tool evidence, model-reported claim, imported legacy narrative, or external content. External and model-derived text cannot grant permissions, turn failures into verified success, or redefine the current user request.

4. Change default diagnostics to metadata-only for memory-bearing requests, including classifier/error paths that share the runtime. Explicit content logging must remain redacted and bounded. Coordinate with SECLOG-01 in the repository-wide backlog rather than creating competing redactors.

5. Create new memory directories/files with restrictive permissions and verify ownership/path safety before access. Decide how to reject symlinked state paths; apply the same rule during import/export. Do not silently chmod or read someone else's existing files.

6. Document what is intentionally retained and what is never retained. Make the policy revision part of the stored metadata so later migrations can identify records needing reprocessing.

## Acceptance criteria

- [ ] Sentinel secrets supplied through feedback, summaries, tool errors, imported records, and adapter errors are absent from new persistent state, default logs, and stderr.
- [ ] An injected memory saying to disable checks is represented as untrusted evidence and cannot alter permissions or become an authoritative constraint.
- [ ] New state is owner-only; unsafe state paths fail explicitly without revealing their contents.
- [ ] Ordinary useful facts and non-secret code references survive redaction, with tests covering false positives.

## Validation

Add `test/memory-privacy.test.ts` using synthetic values only. Run `test:llm-log`, `test:prompt-logger`, `test:multi-turn-memory`, and the new contract suite. Capture stdout/stderr and inspect temporary artifacts programmatically; never print a real secret to prove redaction.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not scan existing personal logs, credential stores, or `data.json` during implementation. Retrospective cleanup belongs to task 13. Keep content logging opt-in and preserve actionable error categories when removing raw payloads.

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
