# Tool Error Trends

**Scope:** Records observed patterns of tool use errors across the bootstrap agent's operational history. This complements ERROR_HANDLING.md (contract) by documenting actual observed failures, their root causes, resolution status, and recurring patterns.

## Error Recovery Principle: Try a Different Approach Rather Than Repeating the Same Method

When a task fails, do not repeat the identical failing method. Analyse why it failed, then change the approach and re-test. This section records the concrete instances where this principle was applied (and one where ignoring it caused wasted effort).

**Observed instances that succeeded by switching approach:**

1. **DeepSeek tool-call JSON argument repair (task `43b3c126`).** Repeated failures were caused by a small set of single, brittle fallbacks in the DeepSeek adapter that could not repair realistic `Write` arguments (large multi-line content with embedded quotes/braces, truncation, prose wrapping, loose quoting). Rather than adding more isolated one-off fallbacks (the same failing method that kept breaking), the approach changed to a **layered, best-effort repair chain** plus a single clean retry with a pure-JSON hint. This different approach succeeded and is fully verified (33/33 probe cases passing). Lesson: when a class of inputs keeps defeating incremental patches to one code path, replace the path's strategy rather than patching it again.

2. **Stale-blocker reconciliation in `select-deepseek-adapter-configuration`.** The task sat in `blocked` status after 07:05 with a note claiming `DEEPSEEK_API_KEY` was absent, even though the key had recovered by 09:56 and was recorded as present. The repeated-attempt trap predicted that each revisit would re-report the same cleared blocker. The different approach was to **verify whether a recorded blocker is still live before re-executing**; a cleared blocker unblocks the task rather than being re-reported. This reconciled the task to `in_progress` and prevented futile repeated attempts. Lesson: before resuming a "failed" or "blocked" step, re-check the actual blocker state instead of trusting a stale note.

3. **Truncation hypothesis investigation (task `1d78a8a9`).** A plan proposed fixing the DeepSeek invalid-JSON error by chunking stdout output for large Write calls. Rather than proceeding with that (incorrect) premise, the different approach was to **investigate the root cause against the code first**: tool-call arguments flow directly from the DeepSeek API response and never pass through stdout, so the truncation-to-stdout fix could not work. The plan was discarded and the work consolidated under the correct root cause (task `43b3c126`). Lesson: before committing to a fix, validate its causal hypothesis; if it is wrong, change approach rather than implementing a fix that cannot address the reported failure.

**When is it appropriate to change approach?**

- After a method has failed on the same task/input more than once with the same result.
- When the current approach's underlying assumption/causal hypothesis has been shown to be incorrect.
- When a recorded blocker no longer exists (verify it is live first).
- When an approach can only be rescued by an unbounded number of one-off special cases (the pattern of brittle single fallbacks that the layered repair chain replaced).

**What not to do:** silently start unrelated work, re-report a cleared blocker, or apply the same failing method a third time hoping for a different outcome.

## Observed Error Categories

### 1. Spec Keeper API Route Contract Errors

**Pattern:** Client calls using obsolete root-relative routes or unsupported resource paths returned 404 or "Unsupported resource" errors.

**Observed instances:**
- `GET /api/goals`, `GET /api/v1/goals` → 404 Not Found
- `GET /api/v1/projects/elastic-agent/goals` → 404 Not Found
- `GET /plans` and `/procedures` → "Unsupported Spec Keeper project resource" (client-side rejection)
- Initial client used root-relative mappings (`/goals`, `/task-queue`) that did not exist on the server

**Root cause:** The Spec Keeper API uses a project-scoped contract (`/api/v1/projects/<slug>/<resource>`). The client initially did not resolve project resources to this contract, and tools/SpecKeeper.ts's `PROJECT_RESOURCES` set only supports agents, epics, tasks, reservations, counters, locks, import, export, events, notes, changes, decisions, chain-runs, jira-config, and jira.

**Resolution:** Fixed in commit `be51219` ("Use project-scoped Spec Keeper API routes"). The client now maps `project-slug` + resource shorthand to `/api/v1/projects/<slug>/<resource>`.

**Status:** ✅ Resolved. Verified working with `GET /api/v1/projects/elastic-agent/tasks` returning 200.

**Recurring risk:** Querying unsupported resources (plans, procedures, goals as project resources) still fails with the "Unsupported Spec Keeper project resource" error.

### 2. Agent Bus Enrollment / Connectivity Blocked

**Pattern:** Agent Bus connectivity failures, both at the enrollment level and at the operating level.

**Observed instances:**
- Agent Bus invite expired at 2026-08-10T17:23:10Z; enrollment attempted afterward failed
- Direct authenticated `GET /` to supplied private HTTPS address failed at transport level (`fetch failed`)
- `AGENT_BUS_BASE_URL` is not configured in the runtime environment

**Root cause:** Expired enrollment invite and unreachable private HTTPS endpoint.

**Resolution:** None. Task `enroll-agent-bus` remains blocked. No Agent Bus credential/config was persisted.

**Status:** ❌ Blocked. Requires a renewed invite and reachable coordination endpoint.

**Recurring risk:** All Agent Bus handoff/coordination messages fail when no base URL is set.

### 3. TypeScript Compilation / Build Failures

**Pattern:** Full TypeScript build fails for the main runtime due to legacy tool import paths, missing types, and strict typing errors.

**Observed instances:**
- `npm run build` fails with TS5097/TS6142: legacy main.ts tool imports use `.ts`/`.tsx` paths without required compiler settings
- TS2688: `@types/node` not installed despite being declared in package.json
- main.ts has pre-existing strict typing errors
- In-process TypeScript transpile check failed because installed TypeScript runtime did not expose the expected enum API

**Root cause:** Legacy main.ts tool module import/compiler configuration defects predate the provider migration work. The build configuration (tsconfig) does not support the `.ts`/`.tsx` import extensions used in main.ts's tool registration.

**Resolution:** Not fully resolved. Focused TypeScript compilation checks (using direct `npx tsc --noEmit` with explicit flags for specific files) pass, but the full `npm run build` continues to fail.

**Status:** ⚠️ Partially working. Focused compilation works; full build is blocked.

**Recurring risk:** Any attempt to run `npm run build` or `npm run test:tool-rendering` fails.

### 4. Deleted main2.js Breaks Legacy Tests

**Pattern:** `test/main2-tool-rendering.test.js` fails because it scopes to main2.js, which was deleted.

**Observed instances:**
- `test/main2-tool-rendering.test.js` fails because `main2.js` is deleted
- The working tree has `main2.js` as deleted (untracked deletion)

**Root cause:** main2.js was deleted as part of an uncommitted relocation/refactor, but the lifecycle test still references it.

**Resolution:** Not resolved. The task `Wire main runtime to reusable LLM chooser` (dbf9c62b) has this documented as a remaining issue pending a decision on retain/migrate/retire the test.

**Status:** ❌ Blocked pending target-runtime ownership decision.

### 5. Missing Runtime Secrets (DeepSeek API Key)

**Pattern:** `DEEPSEEK_API_KEY` is absent from the runtime environment, blocking persistence of a protected secret file.

**Observed instances:**
- Task `select-deepseek-adapter-configuration` step 3/4 is blocked because `DEEPSEEK_API_KEY` is not present in the current runtime environment

**Root cause:** Environment/runtime does not have the required provider credential.

**Resolution:** None. Task is blocked until the credential is supplied through the approved secret manager or protected runtime environment.

**Status:** ✅ **Recovered.** `DEEPSEEK_API_KEY` is now present in the runtime environment, so this blocker is cleared and the task's step 3 secret persistence can resume.

**Note:** The value/format was not inspected; only the presence (non-empty) was confirmed. The value must still be persisted securely by the owning task.

**Recurring risk:** Any provider whose API key is not in the environment will cause the runtime composition to fail when the adapter factory is constructed.

### 6. Inconsistent Working Tree / Uncommitted Relocation

**Pattern:** The working tree contains pre-existing, uncommitted changes that modify main.ts, delete main2.js, and add untracked main-llm-chooser.ts. Multiple tasks were blocked because these changes conflicted with the requested scope.

**Observed instances:**
- Task `Wire main runtime to reusable LLM chooser` was blocked at multiple steps because:
  - main.ts was a legacy OpenAI Responses tool-loop
  - main2.js was deleted
  - untracked main-llm-chooser.ts was the former provider-neutral DeepSeek CLI
  - Direct replacement would break the existing tool-loop contract
- `git status` shows `modified: CLAUDE.md`, `deleted: main2.js`, `modified: node_modules/.package-lock.json`, and untracked files including main-llm-chooser.ts

**Root cause:** An earlier uncommitted relocation replaced main.ts's provider-neutral implementation with a legacy OpenAI-based tool loop and split artifacts across tracked/untracked files.

**Resolution:** Partially resolved during the compatibility-layer implementation in task dbf9c62b, through the `MultiTurnLlmRuntime` compatibility layer and the `--provider` CLI selector. The unrelated working-tree changes (CLAUDE.md, deleted main2.js, untracked main-llm-chooser.ts) remain unstaged and uncommitted.

**Status:** ⚠️ Partially resolved. The compatibility layer was implemented and committed, but the unrelated working-tree changes remain.

### 7. npm Dependencies Not Installed

**Pattern:** Declared dependencies in package.json were missing from installed node_modules, causing compile/test failures.

**Observed instances:**
- `@types/node` missing (TS2688)
- AWS SDK packages (@aws-sdk/client-bedrock-runtime) missing
- Several packages were added as untracked files to node_modules after `npm ci`

**Root cause:** Dependencies were declared in package.json but not present in the installed node_modules at the time compilation was attempted.

**Resolution:** Workaround: `npm ci` was run to restore declared developmental dependencies. The resulting node_modules changes were cleaned up before commit.

**Status:** ✅ Resolved (through `npm ci` workaround).

### 8. DeepSeek Adapter Invalid Tool-Call JSON Arguments

**Pattern:** DeepSeek (OpenAI-compatible Chat Completions) returns `function.arguments` strings for tool calls (e.g. the `Write` tool) that are malformed, so `JSON.parse` fails. Observed malformations span several families:

- **Missing closing braces/brackets** — truncated or incompletely closed objects/arrays.
- **Leading non-JSON prose / fenced code blocks** — the model wraps JSON in prose or ```json fences.
- **Trailing garbage / comments** — content after the final `}` that must be trimmed.
- **Truncated mid-string or mid-value output** — the tail is cut off inside a value.
- **Quoting/typing violations** — unquoted or single-quoted keys/strings, trailing commas, `undefined`/Python-style `True`/`False`/`None` values, comments, unescaped inner quotes.

**Observed instances:** Realistic `Write` arguments observed while running the adapter against DeepSeek. The failure surfaced as the provider error `DeepSeek returned invalid JSON arguments for function call '<name>'. All parsing strategies failed (...)`. Verified with the injected-fetcher probe in `test/parse-failure-probe.ts` and the mode-driven harness in `test/call-adapter.ts`.

**Root cause:** LLM generation is not guaranteed to emit schema-perfect JSON; models may wrap, truncate, or loosely quote tool-call argument output.

**Resolution:** Implemented a layered, best-effort repair chain in `llm/deepseek-v4-adapter.ts` (`repairJson` / `parseJsonObjectWithDiagnostics` / `diagnoseJsonObjectParse`) that, in order:
1. Parses directly, extracting JSON from a ```json fence when needed;
2. Strips leading prose before the first `{` and trailing garbage after the matching `}` (`outerObjectEnd`, which ignores braces inside string literals);
3. Balances and appends missing closing braces/brackets (`braceBalance`/`bracketBalance`, also string-aware);
4. Performs progressive truncation: walks backward from the end at structural boundaries, re-completing delimiters at each point to recover the longest valid prefix;
5. Repairs trailing commas, unquoted keys, single-quoted strings, comments, and Python/JS bare values.

When exhaustive repair still fails, `generate()` retries the API call **once** with a trailing pure-JSON hint (`JSON_RETRY_HINT`) via `buildRetryPayload`, then surfaces the diagnostic. Enhanced diagnostics are exposed through `diagnoseJsonObjectParse` and the `parse-failure-probe.ts` runner.

Deliverables and commits (task plan steps 14–17):
- `llm/deepseek-v4-adapter.ts` — main repair logic (commits `a593441` → `8e1458f`)
- `test/call-adapter.ts` — mode-driven harness calling the adapter
- `test/parse-failure-probe.ts` — per-pattern diagnostics and repair-strategy coverage (commit `44e11ef`)
- `test/llm-adapters.test.ts` — test coverage
- `ERROR_TRENDS.md` — this documentation

**Status:** ✅ Resolved. `npm run test:llm-adapters` passes (focused) and the probe reports PASS for the full battery of repair patterns (brace, bracket, quote tolerance, trailing-garbage removal, progressive truncation, clean retry, and the expected-fail array case).

**Recurring risk:** New malformation families (for example deeply mixed quote styles or truncated string escapes across a truncation boundary) may not be covered; if a new pattern fails, add a probe case and extend `repairJson` rather than special-casing callers.

## Recovery Status (Step 2)

Snapshot of whether previously failing tools/commands are working again, verified during the bootstrap's recovery-tracking pass:

| Previously failing item | Was | Now | Verified by |
|-------------------------|-----|-----|-------------|
| SpecKeeper (project-scoped client) | ✅ Resolved | ✅ Still working | `GET /tasks` + `GET /api/v1/projects` returned 200 |
| DeepSeek API key (`DEEPSEEK_API_KEY`) | ❌ Missing | ✅ **Recovered** | Non-empty env var present |
| npm run build | ❌ Failing | ❌ Still failing | TS7006/TS2304/TS2353/TS2339 errors in main.ts + tool modules |
| test/main2-tool-rendering | ❌ Failing | ❌ Still failing | ENOENT `open main2.js` |
| Agent Bus (`AGENT_BUS_BASE_URL`) | ❌ Blocked | ❌ Still blocked | Env var still unset |
| npm run test:llm-adapters | ✅ Passing (focused) | ✅ Still passing | `LLM adapter fixtures passed` |
| DeepSeek tool-call JSON argument parsing | ⚠️ Brittle (single fallbacks) | ✅ **Repaired** | Layered repair chain + retry landing; parse-failure probe passes each repair family |

**Recovery summary:** Of the previously failing runtime dependencies, the DeepSeek API key has recovered (it is now present in the environment) and the DeepSeek tool-call JSON argument parsing has been hardened from a set of single fallbacks into a layered repair chain with a clean-retry fallback. The full-build TypeScript failures, the deleted-main2 lifecycle test, and Agent Bus connectivity remain unresolved.

## Cross-Tool Pattern Summary

1. **Route/API contract drift** — External API contracts (Spec Keeper) changed, and client tool assumptions lagged. Resolution required updating the client contract.
2. **Blocked by missing external resources** — Agent Bus endpoint unreachable, DeepSeek API key unavailable. These block tasks but are resolvable once external prerequisites are met.
3. **Legacy code conflicting with new architecture** — main2.js/main.ts/chooser relocation left the working tree in a state that blocked subsequent work until a compatibility layer was built.
4. **Build verification gaps** — Full `npm run build` failures mask that individual focused compilation checks pass. The team should fix tsconfig and tool import paths to enable full verification.
5. **LLM output is not schema-guaranteed** — Provider tool-call argument strings routinely violate JSON strictness (prose wrapping, truncation, loose quoting). The robust fix is a layered, best-effort repair chain plus a single clean-retry, verified by a pattern-driven probe, rather than a single fallback or a hard fail.
6. **Recovery requires changing approach, not repeating it** — Repeated application of the same failing method is the recurring cause of wasted effort. Re-verify the blocker/root cause is live, then adopt a different strategy (see the Error Recovery Principle section above).

## Tools Currently Working

| Tool | Status | Notes |
|------|--------|-------|
| SpecKeeper | ✅ Working | Project-scoped routes resolve correctly; auth via secret store works |
| Read | ✅ Working | Returns correct content + hash |
| Write | ✅ Working | Writes and validates; content is chunked in 64 KiB writes |
| ListDirectory | ✅ Working | Returns file/directory listings |
| ExecuteCommand | ✅ Working | Returns exitCode/stdout/stderr |
| Git | ✅ Working | Log, status, diff, commit all functional |
| Http / HttpRequest | ✅ Working | GET and mutating requests work |
| AgentBus | ❌ Blocked | No base URL configured |
| DeepSeek adapter | ✅ Working | DEEPSEEK_API_KEY now present in runtime env; JSON argument repair chain verified |

## Tools with Known Failures

| Tool | Failure Pattern | Status | Notes |
|------|----------------|--------|-------|
| SpecKeeper | Unsupported resource paths rejected client-side | ⚠️ By design | Only documented project resources are supported |
| AgentBus | Transport-level failures, no base URL | ❌ Blocked | Requires renewed invite + configured base URL |
| npm run build | TS compilation failures in main.ts | ❌ Blocked | Legacy tool import paths need fixing |
| test/main2-tool-rendering | References deleted main2.js | ❌ Blocked | Needs retain/migrate/retire decision |
