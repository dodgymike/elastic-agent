# Project Memory

## Tool error trends

- ERROR_TRENDS.md documents observed tool use error patterns and their resolution status.
- Key patterns: Spec Keeper API route contract drift (resolved), Agent Bus connectivity (blocked), full TypeScript build failures (blocked), deleted-main2 lifecycle test (blocked), and missing DeepSeek API key (blocked).
- The document tracks which tools currently work and which have known failures for handoff continuity.

## Tool-call terminal rendering

- The tool-call terminal rendering lifecycle is intentionally scoped to the legacy `main2.js` executor.
- Implementation commit: `4a39798` (`feat: render tool call lifecycle states`). Focused lifecycle-test commit: `e436294` (`test: cover tool call rendering lifecycle`).
- Recorded verification: `npm run test:tool-rendering`, `node --check main.ts`, and `git diff --check` passed.

## Provider runtime migration handoff

- The provider selection and compatibility-layer work remains **in progress**; do not claim runtime verification is complete.
- Partial verification is recorded only. The full build still fails and must be resolved before completion.
- The focused tool-rendering test also fails while `main2.js` is deleted; decide whether the legacy executor should be retained, the test should be migrated, or the test should be retired as part of an approved scope change.
- Uncommitted `main2.js` deletion and `main-llm-chooser.ts` must not be included in a record-only commit until they are independently verified.

## Bootstrap execution-plan lessons (context preservation)

These are the durable lessons from the bootstrap execution plan (tracked in Spec Keeper task `af085d8c`) and MUST be reused by future tasks. Full details, observed instances, and recovery evidence live in ERROR_TRENDS.md; this section is the condensed memory.

1. **Repeated DeepSeek JSON-parsing failures (steps 1-3).** LLM tool-call argument strings are not schema-guaranteed. Do not keep patching isolated one-off fallbacks; use a layered, best-effort repair chain (brace/bracket balance, leading-prose strip, trailing-garbage trim, progressive truncation, quote tolerance) plus a single clean retry with a pure-JSON hint. Verified: parse-failure probe 33/33 passing; `npm run test:llm-adapters` passes. Commits: `99ab88c`, `be722d9`, `8e1458f`, `e29612b`, `44e11ef`, `a72acb9`.
2. **Truncation with large code blocks (steps 2-3).** The truncation-to-stdout hypothesis for the Write invalid-JSON error is INCORRECT: tool-call arguments flow directly from the API response, never through stdout. Validate a causal hypothesis against the code before implementing a fix. Documented in investigation task `1d78a8a9`; work consolidated under `43b3c126`.
3. **Repeated attempts on the same task (step 3).** Before resuming a failed/blocked step, re-verify whether the recorded blocker is still live. A cleared blocker should unblock the task, not be re-reported (see `select-deepseek-adapter-configuration`, reconciled stale blocked state). Prefer changing approach over repeating the same failing method a third time.
4. **File Writing Strategy (step 4):** Never write large files in one call; chunk into smaller pieces. `tools/Write.ts` now writes in 64 KiB chunks (`WRITE_CHUNK_SIZE`) at byte offsets of the complete UTF-8 Buffer so multi-byte sequences stay contiguous, preserving atomicity and the overwrite/read_hash contract. Commit `bdc0464`. The Write tool refuses overwrite without a fresh `read_hash` + `overwrite:true`.
5. **Verification (step 5):** Always verify written files compile/parse before committing. Use `npm run test:llm-adapters`, `node --check`, `git diff --check`, and hash/round-trip checks for large writes.
6. **Error Recovery (step 6):** When a task fails, try a different approach rather than repeating the same method. Commit `25ded0e` documents this principle in ERROR_TRENDS.md with three concrete observed instances.
7. **Progress Tracking (step 7):** Use Spec Keeper notes/status to track iterations and avoid redundant attempts. Keep serial step notes (probe progress 11→13→20→24→33) and snapshot recovery status so downstream steps and future runs skip already-recovered work.
8. **Context Preservation (step 8, this section):** Consolidate lessons learned into durable memory (MEMORY.md + ERROR_TRENDS.md) so future tasks inherit them rather than rediscovering failures.

## Coordination

- Spec Keeper is the authoritative task/decision/handoff system for this project (`elastic-agent`).
- Agent Bus is not currently configured because `AGENT_BUS_BASE_URL` is absent; this does not block the legacy renderer task.
- Spec Keeper bookkeeping requires a URL-safe project slug; the project is `elastic-agent`. The Spec Keeper client reads credentials from the local secret store `/tmp/spec-keeper.json`; pass `projectSlug: "elastic-agent"` explicitly when the secret store lacks a project slug.
