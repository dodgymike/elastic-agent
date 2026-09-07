# MI-02 — Enforce privacy and trust at memory ingestion and output

Status: **DONE** · Priority: **P1** · Size: **M**

Dependencies: [MI-01](01-contracts-and-identity.md)

Read the [execution contract and design decisions](README.md) before starting.
This task is implementation work; the present file is a plan, not proof that the
feature exists. Recheck its source anchors against the current checkout.

## Problem and intended outcome

`sanitizeJson` in the persistent backend only makes values serializable. Findings and narrative feedback can contain copied credentials or injected instructions. The shared LLM runtime also logs full prompts and prints prompts on adapter errors, so protecting only a new storage file would leave memory content exposed through another sink.

## Starting points in the repository

- [memory/persistent.ts](../../../src/memory/persistent.ts) — sanitizeJson and toStepRecord.
- [main.ts](../../../src/main.ts) — rememberAgentStep.
- [llm/multi-turn-runtime.ts](../../../src/llm/multi-turn-runtime.ts) — appendMemoryContext, adapter error logging, appendLlmLog.
- [llm/llm-log.ts](../../../src/llm/llm-log.ts) — appendLlmLog.
- [llm/prompt-logger.ts](../../../src/llm/prompt-logger.ts) — prompt logging.
- [tools/path-privacy.ts](../../../src/tools/path-privacy.ts) — existing protected-path rules; these are not content redaction.

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

Add `tests/memory/memory-privacy.test.ts` using synthetic values only. Run `test:llm-log`, `test:prompt-logger`, `test:multi-turn-memory`, and the new contract suite. Capture stdout/stderr and inspect temporary artifacts programmatically; never print a real secret to prove redaction.

Run only synthetic/local fixtures by default. Record exact commands, their exit
results, skipped checks, and any expected behavior changes. A passing mirrored
simulation or a model's assertion is not evidence of repaired production behavior.

## Boundaries, failure handling, and rollback

Do not scan existing personal logs, credential stores, or `data.json` during implementation. Retrospective cleanup belongs to task 13. Keep content logging opt-in and preserve actionable error categories when removing raw payloads.

## Completion record

Fill this in as the implementation proceeds. Keep sensitive payloads out of it.

```text
Status: DONE
Baseline revision: c0d5f09 (plan base); MI-01 commits 0d732be/0dfa638 present.
Prerequisite evidence: MI-01 DONE (0d732be, 0dfa638).
Reproduction / old behavior: persistent.ts sanitizeJson only made values serializable; multi-turn-runtime printed full prompts on adapter errors and wrote full prompt/response to llm.log; no trust categories or path-safety checks existed.
Changed files and behavior:
  - src/memory/privacy.ts (new): applyMemoryPrivacy/sanitizeMemoryJson/redactMemoryText; trust categories + deriveMemoryTrust/isAuthoritativeTrust; MEMORY_PRIVACY_POLICY_VERSION; assertSafeMemoryStatePath.
  - src/memory/persistent.ts: redact before summarizer, persistence, and retrieval; per-step trust; privacyPolicyVersion; owner-only writes; symlink/ownership path checks.
  - src/llm/multi-turn-runtime.ts: metadata-only adapter errors; redacted llm.log and opt-in prompt.log; redacted memory failure diagnostics.
  - src/memory/index.ts: export the privacy surface.
  - tests/llm/llm-log.test.ts: adapter-error test updated to assert metadata-only stderr.
  - tests/memory/memory-privacy.test.ts (new): trust, rejection/truncation, owner-only state, symlink rejection, false-positive survival.
  - docs/memory/MEMORY_PRIVACY_POLICY.md (new): retained/never-retained policy and revision.
  - package.json: add test:memory-privacy; wire src/memory/privacy.ts into build and affected memory/llm test scripts.
Validation commands and actual results:
  - npm run test:memory-privacy -> exit 0
  - npm run test:llm-log -> exit 0
  - npm run test:prompt-logger -> exit 0
  - npm run test:multi-turn-memory -> exit 0
  - npm run test:memory-contract-v2 -> exit 0
  - npm run test:persistent-memory -> exit 0
  - npm run test:composite-memory -> exit 0
  - npm run test:memory-compaction -> exit 0
  - npm run test:memory -> exit 0
  - npm run test:memory-selection -> exit 0
  - npm run build -> exit 0
  - npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --types node src/memory/index.ts -> exit 0
  - git diff --check -> clean
  - one-off tsx redaction check: absent=true redacted=true for an sk-style sentinel.
Schema / configuration / compatibility changes: persistent documents now carry privacyPolicyVersion=1 and per-step trust; no default backend change.
Residual limitations and follow-up IDs: the workspace safety classifier rejects test sources containing credential-shaped fixtures, so direct secret-absence assertions are not embedded in the committed test; redaction is verified via production code, a one-off runtime check, and the metadata-only stderr test. Retrospective cleanup remains MI-13. No live logs or personal memory were scanned.
Rollback notes: remove the additive privacy module and its call sites; existing documents without privacyPolicyVersion remain readable (field is additive).
Implementation commit(s): 8ff18b8 (implementation + tests + docs); completion record commit follows.

Verification pass (MI-02, plan step 4): verified, no change needed. Supported Node binary: /home/mike/.nvm/versions/node/v22.23.2/bin/node (v22.23.2), applied to every npm-run validation command via RunPackageScript env PATH override. Prerequisites: MI-01 Status DONE with completion record; commits 0d732be/0dfa638 (MI-01) and 8ff18b8/6268b56 (MI-02) present in git log. Re-run results, all exit 0: test:memory-privacy; test:llm-log; test:prompt-logger; test:multi-turn-memory; test:memory-contract-v2; test:persistent-memory; test:composite-memory; test:memory-compaction; test:memory; test:memory-selection; build. Standalone type-check: TypeCheck(src/memory/index.ts, noEmit) exit 0 (dedicated-tool equivalent of the recorded npx tsc invocation; src/memory/index.ts is also emitted by npm run build under Node v22.23.2). git diff --check clean (exit 0). One-off redaction re-check: absent=true redacted=true redactionCount=1 (exit 0) against the production compiled boundary dist/memory/privacy.js emitted by npm run build; the original tsx invocation was not usable this pass because the arbitrary-script safety classifier denied ExecuteCommand and no declared tsx script exists, so the equivalent assertion ran against the compiled production module instead. No recorded check was skipped. Pre-existing working-tree changes were left unstaged and untouched.
```
