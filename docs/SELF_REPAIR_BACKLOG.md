# Elastic Agent self-repair backlog

Reviewed 2026-09-05 against commit `97207fd`.

This is an executable engineering backlog for the agent in this repository. It describes work to implement and verify; it does not authorize deployment, external messages, credential access, or weakening the agent's safety policy. Task status updates appear below. Unlisted tasks remain **TODO**. Implement one bounded task at a time, using the dependencies below.

## Security implementation update — 2026-09-05

Epic 1 implementation is present in the working tree. SEC-01, SEC-02, and SEC-04
are implemented and covered by local regression tests. SEC-03 includes ancestor
resolution, execution-time rechecks, protected-directory/recursive-read guards,
and hardlink rejection; host-side directory replacement races remain a documented
limitation. SEC-05 includes a fail-closed bubblewrap mode and explicit trusted-host
mode, with bounded output/deadlines and selected environment. **SEC-05 remains
pending supported-host isolation/build validation**: this development host rejects
namespace setup. No deployment or activation has been performed.

See [security boundaries and migration](SECURITY_BOUNDARIES.md) and
[`test/security-epic.test.ts`](../test/security-epic.test.ts) for behavior, migration,
regressions, and the mandatory supported-host gate. The assessment below is the
original review snapshot, not a description of the repaired implementation.

## Spec Keeper mapping snapshot — 2026-09-06 (plan step 2)

All 40 backlog tasks map to Spec Keeper tasks under `self-repair-epic-1` through `self-repair-epic-10`; none are missing. One decision maps to a backlog task (`BUILD-01` → `236db966-7a80-42af-9fa9-5f6dd313fc12`). Statuses as of this mapping:

| Task set | Done | Blocked | In progress | Todo |
| --- | --- | --- | --- | --- |
| SEC-01..05 | SEC-01..04 | SEC-05 | — | — |
| TOOL-01..05 | — | TOOL-02..03 | — | TOOL-01, TOOL-04..05 |
| MEM-01..05 | — | — | — | all |
| PROV-01..04 | — | — | — | all |
| RUN-01..05 | — | — | — | all |
| PROMPT-01..03 | — | — | — | all |
| BUS-01..02 | — | — | — | all |
| SECLOG-01..03 | — | — | SECLOG-01 | SECLOG-02..03 |
| BUILD-01..02, TEST-01..03 | — | BUILD-01 | — | BUILD-02, TEST-01..03 |
| SELF-01..03 | — | — | SELF-03 | SELF-01..02 |

Totals: 4 done, 4 blocked, 2 in progress, 30 todo. Blocked items are implemented and await supported-host validation. Open P0 todo items: none (TOOL-02 and TOOL-03 are blocked pending supported-host test verification; SECLOG-01 is in progress, inspected and deferred). Step-2 reconciliation (2026-09-06): live SpecKeeper shows SELF-03 in_progress (version 6, note "Executing plan step 2."), so the snapshot above corrects the earlier "SELF-03 done" total of 5 done.

Step-5 progress: TOOL-02 (`a3025a4`) and TOOL-03 (`830ebdd`) were implemented with focused test suites; both are blocked only on supported-host test verification (the dev host's shell sandbox rejects namespace setup). SECLOG-01 was inspected and intentionally deferred rather than changing runtime logging unverified.

## Assessment and evidence

The project has useful foundations: a provider-neutral adapter contract, static tool checks with an LLM fallback, hashed file-edit preconditions, dependency-aware tool scheduling, abort handling, several memory backends, and focused tests. Improve these existing boundaries rather than replacing the system wholesale.

The most consequential gaps found in the inspected code are:

1. Prompt templates execute JavaScript through `new Function`.
2. HTTP GET is statically allowed without destination restrictions, and shell commands run without explicit deadlines or output limits.
3. `Write` checks a hash, closes the file, then reopens with truncation; the check and mutation are not atomic.
4. Persistent memory writes files but does not reload them into a new instance. The README's cross-run session recall promise is unsupported by this implementation.
5. The shared runtime retains every response state and logs full conversations unconditionally.
6. The classifier defaults to a DeepSeek model while using the active provider's runtime.
7. Run state uses a shared `/tmp/data.json` path, and completion reporting can assert fulfillment without independent evidence.

**Evidence labels:** `Observed` means directly present in source or local test output. `Risk` means a plausible failure mode whose exploitability or production frequency still needs a reproduction. `Improvement` means a proposed capability, not a claim that existing behavior is broken. Security priorities describe remediation urgency, not a formal severity score.

**Scope:** inspected the root checkout's orchestration, tools, safety policy, providers, memory, prompts, queue/worktree integration, build scripts, and representative tests. Excluded the untracked `fu-relay-worktree/` duplicate. Did not read runtime secrets, `data.json`, database contents, enrollment material, or existing conversation logs. No live provider or integration requests, dependency vulnerability audit, or adversarial penetration test was performed.

### Local verification baseline

Environment: Node `v18.19.1`, installed dependencies already present.

| Check | Result |
| --- | --- |
| `npm run build` | Passed |
| `npm run test:llm-adapters` | Failed: `TypeError: process.loadEnvFile is not a function`, in `loadRuntimeEnvironment` |
| `npm run test:multi-turn-memory` | Passed |
| `npm run test:persistent-memory` | Passed |
| `npm run test:memory-compaction` | Passed |
| `npm run test:tool-safety` | Passed |
| `npm run test:tool-call-scheduling` | Passed |
| `npm run test:prompt-builder` | Passed |
| `npm run test:tool-schema` | Passed |
| `npm run test:abort-paths` | Passed |
| `npm run test:review-loop` | Passed; this suite simulates the algorithm rather than exercising production orchestration |

Passing tests do not establish coverage for the gaps below. The adapter failure establishes incompatibility with this local Node version, not a failure of provider transport on a supported runtime. Temporary check logs were written under `/tmp/elastic-agent-repo-review/`.

## Execution protocol for the repairing agent

1. Read the task, its source anchors, current repository guidance, and dependencies. Recheck the implementation because this review is a snapshot.
2. For an observed defect or risk, create a minimal regression using synthetic data, temporary directories, fake providers, or a local fixture server. A risk that cannot be reproduced should be narrowed or closed with evidence, not presented as confirmed.
3. Implement the smallest coherent fix. Preserve user edits and existing contracts unless the task explicitly migrates them. Never treat changing tests to agree with broken behavior as a fix.
4. Run the relevant existing suite and a meaningful regression. Run the build for code changes and `git diff --check`. Report unavailable checks and actual failures.
5. Record changed files, test commands/results, remaining limitations, and rollback instructions. Update the task status only after its acceptance criteria hold.
6. For self-modification, keep the running agent on the old code until the candidate passes verification. Do not let the candidate silently approve or activate itself.

Priority: **P0** address before enabling unattended self-modification or broad filesystem/network access; **P1** core reliability work; **P2** measured improvements after correctness. Size: **S** localized, **M** several modules, **L** architectural; not a calendar estimate.

Suggested sequence: `BUILD-01` → `TEST-01` alongside the independent P0 fixes → `TOOL-01/02` and `RUN-01/02` → `MEM-01/02` and `PROV-01` → remaining P1 tasks → measured P2 work. Dependencies on individual tasks are explicit below; independent tasks need not wait for their entire epic.

## Epic 1 — Enforce security outside model judgment

Outcome: tool execution has deterministic, testable boundaries, even when model output or repository content is hostile.

### SEC-01 — Replace executable prompt interpolation [P0, M]

- **Evidence — Observed:** [`renderPrompt`](../prompt-builder.ts) constructs `new Function` from template text. Templates include expressions such as `JSON.stringify(feedback)`, `formatPlan(remainingSteps)`, and `index + 1`. Modified templates can execute code with the runtime's privileges. Ordinary interpolated variable values are not recursively evaluated; do not mislabel those as this code-execution path.
- **Work:** replace expression evaluation with an allowlisted placeholder renderer. Precompute formatted feedback, remaining steps, and step numbers in callers. Reject unknown placeholders and audit all template-loading paths.
- **Accept:** every shipped template renders without `eval`/`Function`; a synthetic template containing a JavaScript expression is rejected without executing it; existing golden prompt behavior is deliberately preserved or updated.
- **Validate:** `test:prompt-builder`, `test:planner-prompt`, `test:replan-prompt-consistency`, `test:memory-compaction-prompt`.

### SEC-02 — Enforce network destination policy [P0, M]

- **Evidence — Observed/Risk:** [`classifyHttp`](../tool-safety-classifier.ts) statically permits GET with no embedded secret. [`Http`](../tools/Http.ts) and [`HttpRequest`](../tools/HttpRequest.ts) validate HTTP(S) syntax but do not restrict resolved addresses or redirects. GET is not a guarantee of harmlessness. Internal services and metadata endpoints may be reachable depending on deployment.
- **Work:** define explicit allowed destinations, support intentional local integrations, validate resolved IPv4/IPv6 destinations and every redirect, and enforce policy in the transport. Account for DNS rebinding rather than validating a hostname once and resolving it again unchecked.
- **Accept:** local tests cover a denied private destination, allowed explicit local fixture, public-to-private redirect, IPv6, and credential-bearing URLs; denied requests never reach their destination.
- **Dependencies:** coordinate cancellation/output handling with TOOL-02.

### SEC-03 — Close filesystem boundary gaps for new paths [P0, M]

- **Evidence — Observed/Risk:** [`canonicalAbsolutePath`](../tool-safety-classifier.ts) falls back to lexical resolution when `realpathSync` fails. A nonexistent leaf under a symlinked parent needs separate checking. Filesystem handlers do not share an execution-time boundary guard.
- **Work:** resolve the nearest existing ancestor, enforce trusted-root policy at execution, handle links explicitly, and document residual race limitations. Keep access policy separate from model classification.
- **Accept:** synthetic tests deny creating a new file through a parent symlink outside the allowed root; also cover symlink swaps, existing links, safe roots, and nonexistent nested directories. No test accesses real protected files.
- **Dependencies:** TOOL-01 supplies the common execution context.

### SEC-04 — Fail closed on policy exceptions and separate permissions [P0, M]

- **Evidence — Observed:** [`prepareToolCall`](../main.ts) proceeds after unexpected classifier exceptions for tools labeled `readonly`; that set includes file reads and HTTP. Confidentiality violations do not require writes. Docker detection relaxes workspace boundaries; `--disable-classifier` bypasses static policy too.
- **Work:** make mandatory filesystem/network checks independent of optional LLM classification. Treat policy exceptions as denials. Model read, write, execute, network, and integration permissions separately; use explicit configuration for container access rather than assuming isolation from detection alone.
- **Accept:** injected classifier/policy exceptions do not execute tools; Docker indicators alone cannot grant extra permissions; deliberate configuration overrides have documented, tested scope.

### SEC-05 — Add an enforceable shell execution boundary [P0, L]

- **Evidence — Observed/Risk:** [`executeCommand`](../tools/ExecuteCommand.ts) spawns `bash -c` with inherited environment and host privileges. Regex/static/LLM classification is not process isolation, and child programs can perform actions not evident in their command names.
- **Work:** execute through an explicit process policy with selected environment variables, workspace mounts, and network permissions appropriate to deployment. Provide a clearly named trusted-host mode where isolation is unavailable. Protect the running agent's policy and credentials from child processes.
- **Accept:** harmless fixture processes demonstrate denied reads outside permitted mounts and denied network access under restricted mode; supported builds still work; absence of isolation cannot silently claim sandbox protection.
- **Dependencies:** TOOL-02; deployment support in BUILD-02.

## Epic 2 — Make tool execution correct and bounded

Outcome: every tool call is validated, cancelable where applicable, and produces a portable result; mutations preserve user data.

### TOOL-01 — Centralize tool definitions and runtime validation [P1, M]

- **Evidence — Observed:** [`main.ts`](../main.ts) owns schemas and handlers; safety and scheduling own additional name-based switches. `prepareToolCall` parses JSON but does not validate it against the advertised schema before dispatch.
- **Work:** introduce a typed registry with schema, handler, usage prompt, effects, resource keys, and required permissions. Validate decoded arguments before classification/execution. Pass explicit workspace/cwd and cancellation context to handlers.
- **Accept:** null, arrays, missing required fields, incorrect types, and unsupported arguments produce structured validation errors without invoking handlers; registry consistency checks cover all tools.
- **Validate:** `test:tool-schema`, `test:tool-cwd`, `test:tool-safety`, scheduler tests.

### TOOL-02 — Add deadlines, cancellation, and output ceilings [P0, M]

- **Evidence — Observed:** [`ExecuteCommand`](../tools/ExecuteCommand.ts) concatenates stdout/stderr indefinitely and exposes no signal/timeout. HTTP tools buffer full response bodies and expose no signal. A UI timer does not cancel work.
- **Work:** thread the run signal into subprocesses and fetch; enforce configurable time/byte limits; terminate process groups with bounded escalation; keep capped output plus truncation metadata. Limit streamed bytes rather than truncating after buffering everything.
- **Accept:** endless output cannot exhaust memory; a hanging process and its child terminate on deadline/abort; HTTP response reading stops at its limit; partial output and cancellation reason remain available. No pending timers or children survive the test.
- **Validate:** add shell/HTTP lifecycle suites and extend `test:abort-paths`.

### TOOL-03 — Make Write safely preserve file contents [P0, M]

- **Evidence — Observed:** [`Write`](../tools/Write.ts) checks the current hash using `r+`, closes that descriptor, then opens with `w`; a change between those operations can be overwritten. Existing content is truncated before replacement completes. Chunk writes ignore `bytesWritten`.
- **Work:** use exclusive creation for new files, handle partial writes, stage replacement on the same filesystem, and preserve intended modes. Define concurrency semantics explicitly; temp-file rename alone is not compare-and-swap against another writer. Use coordination/rechecks appropriate to supported platforms.
- **Accept:** stale-hash and concurrent-create cases preserve the other writer's data; injected short writes yield complete content; failures before replacement preserve the original; UTF-8 and permission tests pass. Document any remaining external-writer race.
- **Validate:** add `test:write-tool`; retain Edit/Delete hash regressions.

### TOOL-04 — Normalize tool outcomes and paginate large reads [P1, M]

- **Evidence — Observed:** [`Http`](../tools/Http.ts) returns a native `Response` object, while [`HttpRequest`](../tools/HttpRequest.ts) returns plain fields. `serializeToolResult` in [`main.ts`](../main.ts) uses JSON serialization, which does not preserve native Response metadata. [`ListDirectory`](../tools/ListDirectory.ts) returns all entries.
- **Work:** define a serializable result envelope with success/error category, metadata, and truncation/cursor fields. Preserve HTTP status/headers explicitly; cap directory/search result volume and handle non-2xx and shell nonzero exits consistently.
- **Accept:** the model sees status and failure category for HTTP 404 and shell exit 1; large listing pagination has no omissions/duplicates; no runtime-native objects reach serialized tool results.
- **Dependencies:** TOOL-01/02.

### TOOL-05 — Make scheduling resource-aware and abort-aware [P1, M]

- **Evidence — Observed/Risk:** [`tool-call-scheduler.ts`](../tool-call-scheduler.ts) compares lexical paths and exact URL strings. Link aliases and distinct URLs mutating shared service state can evade those conflict keys. The runner has no abort parameter and continues pumping after rejection. [`dispatchToolCallsBatch`](../main.ts) prepares every call before execution.
- **Work:** derive resource keys from actual effects, canonicalize filesystem aliases, conservatively serialize opaque network mutations, stop launching queued work on abort/fatal error, and revalidate mutation permissions close to execution. Preserve original result order.
- **Accept:** tests cover link aliases, failed predecessors, abort with queued work, independent reads, and two mutations of one service. Distinguish a resource conflict from a semantic dependency on successful prior work.
- **Dependencies:** TOOL-01, SEC-03; preserve the existing sequential fallback for `--start-dir` until explicit cwd removes its need.

## Epic 3 — Make memory survive, retrieve, and forget correctly

Outcome: a session can resume across processes without contaminating another workspace, leaking sensitive content, or flooding the model.

### MEM-01 — Implement persistent reload and schema validation [P1, M]

- **Evidence — Observed:** [`PersistentMemoryModule`](../memory/persistent.ts) initializes empty maps, imports write/rename operations, and has no disk loader. `getContext` reads those maps. [`README.md`](../README.md) promises recall across runs using the same `--session-id`.
- **Work:** add an explicit asynchronous load path before retrieval, validate document version and session identity, restore summary/history, and define corrupt/unsupported-version handling. Correct documentation until implemented.
- **Accept:** process A remembers and finalizes; process B with the same identity recalls it and appends without losing history; another identity sees none. Malformed/unsupported files produce bounded diagnostics without overwriting original evidence.
- **Validate:** `test:persistent-memory`, `test:memory-selection`, `test:multi-turn-memory`, plus a real two-process fixture.

### MEM-02 — Isolate identities and checkpoint before finalization [P1, M]

- **Evidence — Observed/Risk:** [`sanitizeFilePart`](../memory/persistent.ts) replaces characters and truncates at 120 characters, so distinct session IDs can collide. Durable writes happen at finalization; a crash earlier can lose remembered steps. Persistence paths do not inherently encode workspace/user scope.
- **Work:** use a collision-resistant identity derived from workspace and session (and user/tenant where supported), unique temp files, restrictive permissions, and incremental durable checkpoints. Add a lock/revision conflict strategy for concurrent writers and a migration for existing filenames.
- **Accept:** colliding sanitized IDs remain distinct; identical session names in two workspaces stay isolated; restart after a checkpoint restores progress; concurrent writers do not silently overwrite each other.
- **Dependencies:** MEM-01 and RUN-01 identity design.

### MEM-03 — Budget total model context, not only summary characters [P1, M]

- **Evidence — Observed:** [`memoryCompaction.ts`](../memory/memoryCompaction.ts) defaults to a 120,000-character window and summary-only threshold. Main wiring uses defaults; graph/composite modes lack the same compaction surface. Continuation history and tool results also occupy the request.
- **Work:** implement a provider/model-aware budget covering instructions, tools, memory, history, and output reserve. Use conservative estimates when tokenization is unavailable; expose uncertainty. Add compatible compaction behavior or explicit unsupported capability for each backend.
- **Accept:** synthetic large histories and large tool outputs remain under budget for all supported memory modes; required instructions and unresolved tool-call/result pairs survive trimming; compaction failure produces a bounded fallback.
- **Dependencies:** PROV-02, RUN-03; preserve current fail-safe compaction behavior.

### MEM-04 — Make summaries incremental and retrieval relevant [P2, M]

- **Evidence — Observed/Improvement:** [`remember`](../memory/persistent.ts) passes the entire growing history plus previous summary on every update. Retrieval returns a session summary, not a query-selected evidence set. [`memory/types.ts`](../memory/types.ts) already has provenance fields to extend.
- **Work:** summarize new entries since a durable cursor, periodically consolidate, and retrieve task-relevant facts with source, timestamp, confidence, and supersession links. Prefer a measured lexical baseline before introducing embeddings or a new store.
- **Accept:** a 100-step fixture demonstrates bounded incremental summarization input; retrieval recalls current constraints and excludes superseded claims; failure/retry cannot skip an unsummarized entry.
- **Dependencies:** MEM-01/02/03; measure with TEST-03.

### MEM-05 — Add redaction, retention, and memory quality checks [P1, M]

- **Evidence — Observed/Risk:** `sanitizeJson` in [`persistent.ts`](../memory/persistent.ts) ensures JSON serializability, not secret removal. Model-generated findings/reasoning are persisted; comments that call them non-secret are not enforcement. Compaction checks format/shrinkage, not factual preservation.
- **Work:** share redaction with SECLOG-01, add configurable retention and forget/export operations, mark recalled text as untrusted evidence, and retain protected facts/constraints separately from lossy summaries. Serialize or revision-check overlapping summary updates.
- **Accept:** synthetic secrets never appear in saved summaries/logs; deletion removes all relevant checkpoints/index entries; adversarial memories cannot change policy; compaction preserves a fixture set of constraints and open tasks.
- **Dependencies:** MEM-02, PROMPT-01, SECLOG-01.

## Epic 4 — Make providers interchangeable in practice

Outcome: provider choice applies consistently to every model call, startup is independent of cwd, and transport failures have predictable handling.

### PROV-01 — Resolve classifier models through their provider [P1, S]

- **Evidence — Observed:** [`resolveClassifierModel`](../tool-safety-classifier.ts) defaults to `deepseek-v4-flash`; [`main.ts`](../main.ts) passes that model into the same `client` used by the selected provider. A model override changes the model string, not the adapter.
- **Work:** configure provider/model pairs per role, with classifier defaults compatible with the active provider. If cross-provider classification is intentional, construct an explicit separate adapter and make its data destination visible in configuration.
- **Accept:** fake OpenAI, Bedrock, and DeepSeek runs receive only compatible classifier model IDs by default; explicit role overrides are validated before a tool needs classification; classifier requests omit unrelated session memory.
- **Validate:** `test:model-defaults`, `test:cli-provider-selection`, `test:tool-safety`, `test:llm-adapters`.

### PROV-02 — Add capability-aware generation options [P1, M]

- **Evidence — Observed:** [`GenerateRequest`](../llm/adapter-contract.ts) supports `maxOutputTokens`, `temperature`, and `toolChoice`; [`CompatibleCreateRequest`](../llm/multi-turn-runtime.ts) does not forward those controls. Capabilities currently cover only tools and message roles.
- **Work:** expose necessary controls through runtime calls; model context/output limits and supported options explicitly; validate configuration before requests. Preserve finish reasons and unsupported-capability errors without silently degrading behavior.
- **Accept:** a table-driven adapter suite verifies supported fields and rejects unsupported combinations; output ceilings reach the transport; content filtering, truncation, cancellation, and unknown finish reasons remain distinguishable.
- **Dependencies:** BUILD-01 for a supported test runtime.

### PROV-03 — Unify deadlines, retries, and error accounting [P1, M]

- **Evidence — Observed/Improvement:** adapters expose retryability through [`LlmAdapterError`](../llm/adapter-contract.ts), while DeepSeek has a separate JSON-repair retry and SDK providers may apply their own retry policy. The shared runtime directly invokes `generate` without a common budgeted retry controller.
- **Work:** inventory actual SDK retries, define one effective attempt/time budget, honor retry hints with bounded jitter, and do not retry authentication or invalid configuration. Track every attempt including failed/repair requests. Never replay tool side effects as a transport retry.
- **Accept:** fake 429/5xx/timeouts exercise bounded retries; authentication fails once; abort stops waits; retry accounting includes hidden repair attempts and no executed mutation runs twice.
- **Dependencies:** RUN-02; no live-provider requests needed for acceptance.

### PROV-04 — Remove provider import-time filesystem dependencies [P1, S]

- **Evidence — Observed:** [`deepseek-v4-adapter.ts`](../llm/deepseek-v4-adapter.ts) reads `prompts/json-retry-hint.txt` at module import using cwd. [`application.ts`](../llm/application.ts) eagerly imports all built-in adapters, despite factory selection being lazy.
- **Work:** resolve assets relative to the installed source/package location; load provider-specific assets only when needed; make selected-provider startup independent of unrelated providers' assets and cwd.
- **Accept:** build/run composition from a temporary cwd works; selecting a different provider does not read a missing DeepSeek prompt; missing required assets report their resolved path clearly.
- **Validate:** `test:runtime-provider-environment` if added as a script, `test:tool-source-root`, adapter composition tests.

## Epic 5 — Make execution state and completion truthful

Outcome: runs are isolated and bounded; the agent can explain what actually succeeded and safely resume unfinished work.

### RUN-01 — Replace shared global run-state storage [P1, M]

- **Evidence — Observed/Risk:** [`main.ts`](../main.ts) sets `dataFilename = "/tmp/data.json"`. Atomic replacement prevents partial JSON but does not isolate concurrent runs or guard against an attacker-controlled shared temporary path.
- **Work:** use an owner-only application state directory and run/workspace identity; version and validate state; define explicit resume selection and lock/conflict handling. Keep sensitive runtime state out of the repository.
- **Accept:** two simultaneous synthetic runs have independent state, cannot resume each other accidentally, and reject mismatched schema/identity. Existing-state migration is explicit and does not expose payloads in diagnostics.
- **Dependencies:** coordinate MEM-02 and BUS-01 identity rules.

### RUN-02 — Add a unified run budget and progress policy [P1, M]

- **Evidence — Observed:** [`main.ts`](../main.ts) has separate replan/review limits and tool-continuation `while` loops. These do not establish one bound on all requests, tool executions, tokens, or elapsed run time.
- **Work:** enforce request, tool, elapsed-time, and optional token/cost limits across planning, classifiers, retries, summarization, execution, and review. Detect repeated identical ineffective calls without mistaking unrelated successful reads for progress.
- **Accept:** an always-tool-calling fake model terminates with a resumable budget-exhausted outcome; a retry/classifier loop consumes the same budget; work that changes evidence is not prematurely stopped; child operations cancel when the deadline expires.
- **Dependencies:** TOOL-02; expose counts through SECLOG-02.

### RUN-03 — Release conversation state and validate continuations [P1, M]

- **Evidence — Observed:** [`MultiTurnLlmRuntime`](../llm/multi-turn-runtime.ts) stores every response in `responseStates` with a complete messages-array snapshot and no release API. Continuations check that each result ID exists but do not enforce an exact unique set of pending calls.
- **Work:** define conversation ownership and release/TTL limits; retain only required branches; reject duplicate/missing result IDs according to the declared protocol. Bound history while preserving outstanding tool calls.
- **Accept:** thousands of stubbed turns do not retain thousands of complete historical snapshots; valid continuations still work; duplicate, missing, stale, and cross-conversation IDs fail before a provider request.
- **Dependencies:** coordinate MEM-03; retain the unknown-response-ID error contract.

### RUN-04 — Base completion on recorded outcomes and verification [P1, M]

- **Evidence — Observed:** [`reportImplementationTldr`](../main.ts) says direct execution or full plan execution matches the prompt based on control flow. Invalid step feedback can map to `outcome: "completed"` in memory recording. Review receives diffs, which is useful, but a model's `passed` flag alone does not establish tests passed.
- **Work:** distinguish attempted/completed/verified/partial/blocked/failed/unknown; require valid feedback and applicable verification evidence for success. Make direct and planned paths share result semantics. Report unavailable evidence plainly.
- **Accept:** malformed feedback, failed commands, missing required tests, and partial work never become verified completion; a successful evidence-backed run does. Reports link to relevant test/artifact evidence.
- **Dependencies:** TOOL-04 and TEST-01.

### RUN-05 — Resume work without replaying external effects [P1, L]

- **Evidence — Observed/Risk:** [`SDLC.md`](../SDLC.md) and main's review loop restart execution after failed review. That can repeat already-performed effects unless the model avoids them. Existing saved tool IDs are not a durable effect journal.
- **Work:** persist stable step/effect IDs and observed results; retry failed verification or remaining work instead of replaying all completed steps. Mark uncertain external outcomes for reconciliation; use integration idempotency keys where supported.
- **Accept:** simulated failure after an external success and before local acknowledgment cannot blindly resend; a failed review retains completed mutation evidence; resumed plans clearly distinguish done, uncertain, and pending work.
- **Dependencies:** RUN-01/04, BUS-02.

## Epic 6 — Give prompts clear trust and response contracts

Outcome: prompts preserve instruction authority, resist injected instructions, and request only information needed for the current phase.

### PROMPT-01 — Preserve role and provenance boundaries [P1, M]

- **Evidence — Observed:** [`MultiTurnLlmRuntime.create`](../llm/multi-turn-runtime.ts) sends initial assembled input as one user message. [`build-prompt-skeleton.txt`](../prompts/build-prompt-skeleton.txt) combines agent instructions, history, and the current request; memory is appended as more text. The adapter contract already supports system/developer roles.
- **Work:** separate trusted runtime policy, authorized user instructions, repository guidance, recalled memory, and tool evidence into explicit roles/sections. Label lower-trust content and prevent it from granting permissions or rewriting completion criteria. Do not claim role separation alone eliminates injection.
- **Accept:** provider conversion tests preserve intended authority; adversarial repository files, bus payloads, HTTP bodies, and memories cannot alter enforced permissions. The latest authorized user constraint remains present after compaction.
- **Dependencies:** SEC-01, PROV-02; evaluate with TEST-03.

### PROMPT-02 — Consolidate structured phase contracts [P1, M]

- **Evidence — Observed:** plans, feedback, and reviews use separate templates and parsers across [`prompt-parser.ts`](../prompt-parser.ts), [`response-format.ts`](../response-format.ts), and [`main.ts`](../main.ts); the system has multiple JSON retry paths.
- **Work:** define versioned schemas for plan, step outcome, replan, and review; generate concise formatting instructions from them; use native structured output when supported and validated text fallback otherwise. Keep tolerant parsing from inventing executable arguments or success statuses.
- **Accept:** table-driven tests cover malformed, fenced, truncated, extra-field, and wrong-phase responses across providers; every repair consumes budget and records the failure; invalid data cannot advance state.
- **Dependencies:** PROV-02, RUN-02/04.

### PROMPT-03 — Load relevant tool guidance and measure prompt changes [P2, M]

- **Evidence — Observed/Improvement:** [`ToolDefinition.usage_prompt`](../llm/adapter-contract.ts) asks the model to read usage files before first use; execution prompts include available tools and repeated instructions. This can consume extra tool turns and repeat stable context.
- **Work:** inject/cache required tool guidance at the runtime boundary, keyed by content hash and conversation; expose only tools needed for the phase while retaining discovery. Consolidate conflicting instruction sources without deleting operational constraints.
- **Accept:** a multi-step fixture does not repeatedly read unchanged tool guidance; changed guidance invalidates cache; relevant tools remain discoverable; prompt-token savings do not reduce task success or safety on the evaluation set.
- **Dependencies:** TOOL-01, PROMPT-01/02, TEST-03.

## Epic 7 — Keep integration queues and task transitions durable

Outcome: restarts neither lose incoming work nor silently duplicate outgoing effects.

### BUS-01 — Commit cursor and inbox state together [P1, M]

- **Evidence — Observed/Risk:** [`loop-busctl-read.ts`](../loop-busctl-read.ts) captures/persists a cursor while reading a batch; [`loop-queue.ts`](../loop-queue.ts) separately persists queued messages. Separate atomic files do not prove atomic handoff between cursor advancement and durable routing.
- **Work:** first reproduce crash windows across receive, classify, enqueue, cursor commit, and drain. Use a durable inbox with source message IDs and acknowledged positions; quarantine corrupt state instead of quietly treating lost work as an empty queue. Coordinate multiple consumers explicitly.
- **Accept:** crash injection at each boundary preserves at-least-once delivery with deduplication; cursor never advances beyond durably owned work; duplicate deliveries do not produce duplicate task execution.
- **Validate:** `test:loop-busctl-read`, `test:loop-queue`, `test:loop-poll`, `test:loop-mode`.

### BUS-02 — Reconcile partial Spec Keeper transitions [P1, M]

- **Evidence — Improvement:** task claim/completion and proof handling already have dedicated modules and tests: [`specKeeperTaskClaim.ts`](../specKeeperTaskClaim.ts), [`specKeeperTaskCompletion.ts`](../specKeeperTaskCompletion.ts), and [`specKeeperTaskLifecycle.ts`](../specKeeperTaskLifecycle.ts). Exercise the cross-call failure cases rather than replacing these modules.
- **Work:** specify expected ownership/version, idempotent transition behavior, and reconciliation when status succeeds but note/proof fails or a response is lost. Keep remote-state truth distinct from local intent.
- **Accept:** fake integration tests cover conflict, expired ownership, timeout-after-success, note failure, and restart; local success is not reported when required remote proof is missing; no duplicate completion writes are needed to reconcile.
- **Dependencies:** RUN-01/05; use fakes rather than posting real tasks during tests.

## Epic 8 — Make diagnostics useful without retaining secrets

Outcome: operators can diagnose cost, latency, and failure without full conversation capture being the default.

### SECLOG-01 — Redact and bound logs and persisted artifacts [P0, M]

- **Evidence — Observed:** [`MultiTurnLlmRuntime`](../llm/multi-turn-runtime.ts) always calls `appendLlmLog` and prints a full prompt on adapter errors. [`llm-log.ts`](../llm/llm-log.ts) appends synchronously without rotation or explicit file mode. `--log-prompts` controls an additional log, not this baseline log. [`normalizeToolParameters`](../tool-safety-classifier.ts) says normalized parameters must not be logged, but its runtime call flows through the shared logger.
- **Work:** default to metadata; make bounded content logging explicit; apply central redaction before every sink, including errors and memory; use restrictive permissions, rotation, retention, and safe log path resolution. Treat synthetic secret matching as a defense, not a guarantee of detecting all sensitive text.
- **Accept:** sentinel secrets in user text, tool errors, headers, memory, and adapter failures never appear in default logs or stderr; content logging is explicit and redacted; file modes and rotation are tested; classifier calls honor their logging policy.
- **Validate:** `test:llm-log`, `test:prompt-logger`, `test:multi-turn-memory`, plus error-path tests.

### SECLOG-02 — Track phase-level resource and outcome metrics [P2, M]

- **Evidence — Observed/Improvement:** [`recordUsage`](../main.ts) records selected responses in run state; the shared runtime logs model usage, but role/phase and all auxiliary calls are not a single complete run ledger. [`tool-timer.ts`](../tool-timer.ts) supplies useful timing infrastructure.
- **Work:** record run/session/step/call IDs, role, provider/model, retry count, duration, token usage, tool bytes, denial source, and completion evidence. Include classifier, router, summarizer, compactor, and failed attempts; mark unknown usage as unknown, not zero.
- **Accept:** a deterministic fake run reconciles all requests and retries; metrics work with content logging disabled; totals attribute latency/cost to phases and expose missing measurements.
- **Dependencies:** SECLOG-01, PROV-03, RUN-02.

### SECLOG-03 — Clean up artifact tracking policy [P1, S]

- **Evidence — Observed:** `git ls-files` lists `database.sqlite` and `llm2.log`; their contents were not inspected. `memory-output/` is untracked and not excluded by [`.gitignore`](../.gitignore), despite README describing it as ignored. This is an artifact-policy issue, not proof those files contain secrets.
- **Work:** inventory tracked generated artifacts by metadata first, classify fixtures versus runtime outputs, add precise ignore rules, and move sanitized examples into documented fixtures. Remove tracked runtime artifacts only after confirming their role; assess credential exposure only through an authorized redacted scan.
- **Accept:** a normal run leaves no memory/log/state artifacts eligible for accidental staging; required fixtures remain available; documentation matches ignore behavior. Do not rewrite history or rotate credentials without evidence and appropriate authorization.

## Epic 9 — Build repeatably and test production behavior

Outcome: a clean supported environment can build and run the agent, and tests fail when production orchestration regresses.

### BUILD-01 — Declare and enforce the supported Node toolchain [P1, S]

- **Evidence — Observed:** [`package.json`](../package.json) has no `engines` declaration. [`loadRuntimeEnvironment`](../llm/application.ts) calls `process.loadEnvFile`; the adapter suite fails on installed Node `v18.19.1`. The start command also uses Node-specific env-file options.
- **Work:** choose and pin a supported Node version compatible with all used APIs and dependency engines; add an early readable version check, engine metadata, and setup instructions. Use the lockfile for repeatable installation.
- **Accept:** clean install/build/tests pass on the declared runtime; unsupported Node exits with an actionable message before provider initialization; missing versus malformed environment files have deliberate behavior.
- **Validate:** rerun `test:llm-adapters` first, then all registered local suites.

### BUILD-02 — Produce a runnable, reproducible container [P1, M]

- **Evidence — Observed:** [`Dockerfile`](../Dockerfile) uses `ubuntu:latest`, installs distribution npm, copies only `package.json`, and runs `npm install`. It does not copy application source, build it, select a non-root user, or define an application command.
- **Work:** define whether the image is a development base or a runnable agent. For a runnable image, pin its runtime/base, use `npm ci` with the lockfile, build/package prompts and tools, run as non-root, and add a narrow build context excluding local state and secrets.
- **Accept:** a clean container can show CLI help and run a fake-provider smoke task; required assets resolve outside repository cwd; no credentials/runtime logs are copied; build is reproducible from tracked inputs.
- **Dependencies:** BUILD-01, PROV-04. Verify version/security choices at implementation time rather than relying on this snapshot.

### TEST-01 — Test the real orchestrator through injected dependencies [P1, L]

- **Evidence — Observed:** [`main.ts`](../main.ts) is 3,366 lines with module-level configuration and side effects. [`test/review-loop.test.js`](../test/review-loop.test.js) explicitly mirrors the algorithm; other tests assert source text. These can pass while runtime behavior diverges.
- **Work:** extract a callable runner with injected LLM, tools, store, clock, and integration clients. Keep the CLI thin. Replace mirrored/source-shape assertions incrementally with behavioral tests of production functions; retain useful pure tests.
- **Accept:** tests invoke actual planning/execution/review/direct/abort/resume paths without credentials, network, or importing the live CLI. Deliberately breaking a production transition causes a regression test to fail.
- **Dependencies:** BUILD-01; extract in small steps before restructuring behavior.

### TEST-02 — Add one reliable verification entry point [P1, M]

- **Evidence — Observed:** [`package.json`](../package.json) has many standalone test scripts but no top-level `test` script. Each script duplicates compiler flags and cleanup; no tracked `.github` workflow was listed in this review.
- **Work:** add a canonical local/CI check command, shared TypeScript configuration, and isolated temp build directories. Inventory test files not reached by scripts; distinguish offline tests from explicitly opted-in live integration tests. Add lint/type checks incrementally rather than burying changes in a whole-repo rewrite.
- **Accept:** one command runs all offline suites, returns nonzero on failure, and cleans temporary output; parallel invocations cannot delete each other's build directory; CI uses the declared runtime and lockfile without secrets.
- **Dependencies:** BUILD-01; include regressions introduced by other tasks.

### TEST-03 — Establish agent behavior evaluations [P2, M]

- **Evidence — Improvement:** focused unit tests are substantial, but this review did not establish an end-to-end task-success, prompt-injection, memory-quality, or efficiency benchmark.
- **Work:** create small deterministic scenarios: simple answer, multi-file edit, failing test repair, safety denial recovery, session resume, malicious tool output, provider interruption, and uncertain external effect. Score task evidence, unintended changes, cost, latency, and recovery behavior. Keep model-dependent evaluations separate from deterministic regression gates.
- **Accept:** baseline results are stored without sensitive content; prompt/provider changes compare against a fixed scenario set; repeated runs report variance; quality and safety regressions cannot be hidden by token savings.
- **Dependencies:** TEST-01, SECLOG-02; live runs require their normal explicit configuration/budget.

## Epic 10 — Make self-repair reviewable and safely activatable

Outcome: a repair is a candidate with evidence and rollback, not an unverified change to the currently executing agent.

### SELF-01 — Introduce a candidate repair lifecycle [P1, M]

- **Evidence — Observed/Improvement:** source modification already has an explicit flag in [`tool-safety-config.ts`](../tool-safety-config.ts); [`worktree.ts`](../worktree.ts) stages work in an isolated worktree and supports review. Build on those mechanisms.
- **Work:** represent repair states as proposed → reproduced → implemented → verified → candidate → activated/rolled-back. Record baseline revision, allowed paths, tests, changed policy, and migration needs. The running process continues using its original code until restart/activation.
- **Accept:** a fake self-repair produces an isolated diff and evidence manifest; failed verification prevents activation; activation selects an exact verified revision; reverting to the previous revision restores startup.
- **Dependencies:** all P0 tasks applicable to the deployment, TEST-01/02, RUN-04.

### SELF-02 — Bind verification to the exact candidate and protect user work [P1, M]

- **Evidence — Observed/Risk:** [`worktree.ts`](../worktree.ts) uses broad staging and [`runReviewPhase`](../main.ts) collects staged/committed diffs. Review evidence must match what is ultimately committed/activated, including tests and newly generated files.
- **Work:** record a candidate tree digest; invalidate approval/verification after changes; stage only intended artifacts; preserve pre-existing dirty files; explicitly flag modifications to tests, policy, or verification commands for review. Treat required external activation approval as distinct from creating a candidate.
- **Accept:** changing a file after verification blocks activation; unrelated user changes are excluded and preserved; missing/untracked required files fail packaging checks; a patch that disables its failing test cannot pass the unchanged verification policy.
- **Dependencies:** SELF-01, SECLOG-03.

### SELF-03 — Keep a repair ledger and turn failures into new tasks [P2, S]

- **Evidence — Improvement:** the repository has extensive design documents, but no single evidence-backed repair ledger was established by this review.
- **Work:** record task ID, status, baseline/candidate revision, reproduction, validation, behavior change, and rollback. Link recurring failures to existing tasks; propose a new bounded task only when evidence does not fit. Retire stale documentation and keep this backlog synchronized with completed work.
- **Accept:** a later agent can determine what changed, why, how it was checked, and what remains without reading conversation logs; every DONE task points to verification evidence; abandoned/unreproduced risks retain their rationale.
- **Dependencies:** SELF-01, SECLOG-02; do not store raw prompts or credentials in the ledger.

## Completion record template

Copy this under a task when starting it:

```text
Task ID:
Status: TODO | IN_PROGRESS | BLOCKED | DONE | CLOSED_NOT_REPRODUCED
Baseline revision:
Reproduction / observed behavior:
Implementation and changed files:
Validation commands and actual results:
Candidate revision / tree digest:
Residual limitations:
Rollback / migration notes:
Follow-up task IDs:
```

A task is DONE when its acceptance criteria are demonstrated, required checks pass on the supported toolchain, and its evidence is recorded. A document edit, a model's assertion, or a passing simulation alone is not proof of repaired production behavior.
