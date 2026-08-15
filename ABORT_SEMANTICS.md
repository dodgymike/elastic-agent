# ABORT_SEMANTICS.md — Abort States and Exit Behavior

This document defines the abort semantics for the `elastic-agent` CLI
(`main.ts`). It is the normative contract for the abort feature: what counts
as an abort, what the process prints, which exit code it produces, and how
partial worktree/staging changes are handled. Implementation steps for the
abort feature must follow this document and update it if a decision changes.

The definition is deliberately implementation-neutral. It names the behavior,
not the exact variable placement.

## 1. Scope

The abort feature covers three abort states:

1. **User-triggered abort** — the user interrupts the run.
2. **LLM unable-to-complete** — the model reports, or the runtime determines,
   that no usable plan/replan/review result can be produced.
3. **Stuck / retry-exhausted plan** — replanning cannot make progress and the
   retry budget is exhausted.

A run that reaches any of these states stops doing planner, replanner, and LLM
work as soon as the abort is observed, reports a concise indented `[ABORT]`
message, performs the cleanup described below, and exits with the state's
assigned exit code.

Non-goals: this document does not change the successful exit path (`0`), the
existing generic failure path (`1`), or the review-failed outcome (which is a
legitimate negative result, not an abort, and remains exit code `1`).

## 2. Abort states

| State | Kind key | Trigger | Detection | Exit code |
| --- | --- | --- | --- | --- |
| User-triggered abort | `user` | SIGINT (Ctrl-C), SIGTERM, or an interactive abort command if one is added | `AbortController.abort(reason)` is called; `signal.aborted` is true. The abort reason carries the source signal or command. | `130` for SIGINT/abort command; `143` for SIGTERM |
| LLM unable-to-complete | `unable-to-complete` | Planner/replan/review cannot produce a usable result | Explicit JSON abort result (`{ "abort": true, "reason": "..." }`) from a planner/replan prompt; or JSON parse-retry exhaustion in the planner, replan, or review phase; or an LLM generation that is cancelled by the provider without our own signal being aborted | `2` |
| Stuck / retry-exhausted plan | `stuck` | Replanning is required but cannot make progress | Any of the stuck conditions in section 5: replan attempt limit reached while replan is still required, consecutive no-progress replans, or the replan time budget is exceeded | `3` |

All three states share one internal error type, `RunAbortError`, so the
top-level handler can distinguish "deliberate abort" from an unexpected crash.
`RunAbortError` has the shape:

```ts
{
  name: "RunAbortError",
  kind: "user" | "unable-to-complete" | "stuck",
  phase: string,        // planning | planning-necessity | execution | replan | review-plan | review | task-mode-setup | cleanup
  step?: number,        // 1-based plan step when the abort happened inside a step; absent otherwise
  reason: string,       // safe, bounded, secret-free explanation
  exitCode: number,     // one of 130 | 143 | 2 | 3
}
```

Abort precedence when multiple causes overlap: `user` > `unable-to-complete` >
`stuck` > generic failure. For example, a SIGINT that arrives while handling
an unable-to-complete response is reported as `user`.

## 3. Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. The run finished normally (direct execution, plan execution, or review passed). |
| `1` | Generic operational failure. Usage errors, task-mode setup failure, unexpected thrown errors, and the existing review-failed outcome. |
| `2` | LLM unable-to-complete (section 4). |
| `3` | Stuck / retry-exhausted plan (section 5). |
| `130` | User-triggered abort via SIGINT or an interactive abort command. |
| `143` | User-triggered abort via SIGTERM. |

Implementation rules for exit codes:

- Set `process.exitCode` in the single top-level abort handler; do **not** call
  `process.exit()` on the normal abort path.
- Keep the existing `process.exit(1)` for the pre-runtime CLI argument
  validation path (`resolveCliRunMode`).
- A second SIGINT after the first abort is the emergency escape hatch:
  `process.exit(130)` immediately so a wedged cleanup cannot trap the user.
- Spec Keeper update failures during abort cleanup must never change the
  abort's exit code; they are logged as warnings.

## 4. LLM unable-to-complete contract

### 4.1 Explicit JSON abort result

The planning and replan prompts are extended so the model may return an abort
object instead of a forced, possibly bogus plan. The accepted shape is:

```json
{ "abort": true, "reason": "why no plan could be produced" }
```

Validation rules:

- `abort` must be a boolean. When absent or `false`, normal plan parsing
  continues unchanged.
- When `abort` is `true`, `reason` must be a non-empty string after trimming.
- If `abort` is `true` and plan steps are also present, `abort` wins. The
  reason is reported and the run aborts with kind `unable-to-complete`.
- The reason is bounded to 400 characters and must contain no secrets,
  credentials, or unbounded response bodies before it is printed or stored.

The prompt text for both planning and replanning must show this alternative
shape and state that `abort: true` is the correct response when no usable plan
can honestly be produced, rather than inventing a plan.

### 4.2 Parse-retry exhaustion

- Planning: the existing plan-JSON parse fallback may remain for lenient
  responses, but if the planner returns no parseable plan (or an explicit
  `abort: true`) the run aborts as `unable-to-complete` instead of falling
  back to a single synthesized step. A parse retry may be attempted once with
  the parse error appended; if that retry also fails, abort.
- Replan: the existing `actionablePlanSteps` validation gains an abort-aware
  parser. An explicit abort object aborts the run; an unparseable or invalid
  revised plan after the replan retry budget aborts as `unable-to-complete`
  (this is distinct from `stuck`; see section 5).
- Review: the existing review-JSON retry behavior stays, but if the review
  JSON is still unparseable after the review retry budget, the run aborts as
  `unable-to-complete` with phase `review`, rather than synthesizing a
  failed-review result.

### 4.3 Provider cancellation without our signal

If an LLM generation finishes with `finishReason === "cancelled"` (or the
equivalent adapter-specific signal) while our own `AbortSignal` is **not**
aborted, the run treats it as `unable-to-complete` with the reason
`"provider cancelled generation"` plus any bounded adapter diagnostic. This
distinguishes an external cancellation from a user-triggered abort.

## 5. Stuck / retry-exhausted plan detection

Stuck detection applies to the replanning loop inside the execution phase.
A run is marked `stuck` and aborts with exit code `3` when **any** of these
conditions is true:

1. **Replan attempt limit reached while replan is still required.**
   A step returns `replanRequired: true` and `replanAttemptCount` is already
   at `maxReplanAttempts` (default `3`) when the replan would be attempted.
   This replaces today's behavior of silently keeping the existing remaining
   plan.

2. **No-progress replans.**
   Before and after an accepted replan, compute a normalized key of the
   remaining steps (`steps.map(trim).filter(Boolean).join("\n")`). If the key
   is unchanged, increment `consecutiveNoProgressReplans`. When
   `consecutiveNoProgressReplans` reaches `maxConsecutiveNoProgressReplans`
   (default `2`), the run is stuck. A duplicate revised plan is a no-progress
   replan even though it parsed successfully.

3. **Replan time budget exceeded.**
   Total wall-clock time spent inside replan attempts across the run exceeds
   `maxReplanDurationMs` (default `120000`). The budget is checked before
   each replan attempt and after each attempt returns.

Reasons must state which condition fired and include the relevant budget
values, for example:

- `"replan attempt limit reached (3/3) while step 2 still requires replanning"`
- `"no progress after 2 consecutive identical replans"`
- `"replan time budget exceeded (120000 ms)"`

When `stuck` fires, the run aborts immediately: no further step execution,
replanning, or review work is started.

## 6. Console output contract

Add a `status.abort` renderer alongside the existing `status.*` renderers. It
uses `chalk.red.bold("[ABORT]")` and the same `printStatusLine`/hierarchy
indent helpers so multi-line messages stay aligned and indentation stays
consistent with the existing phase/plan/step scheme.

Every abort prints exactly one concise, indented abort block before cleanup,
using this format:

```text
[ABORT] <state label>
  phase: <phase>
  step: <step or "-">
  reason: <bounded reason>
  exit code: <code>
```

State labels:

- `user` -> `Aborted by user`
- `unable-to-complete` -> `LLM could not complete the request`
- `stuck` -> `Plan is stuck`

Rules:

- `<step>` is the 1-based plan step when known, otherwise `-`.
- `<reason>` is bounded to 400 characters and secret-safe.
- Aborts do **not** print a stack trace. Unexpected errors keep the existing
  stack-trace behavior in the top-level catch.
- After the first abort message, no further `[PLAN]`, `[STEP]`, `[REPLAN]`,
  `[RESPONSE]`, or `[SUCCESS]` phase/step lines may be emitted except cleanup
  and Spec Keeper best-effort diagnostics.

## 7. Partial worktree / staging cleanup

Cleanup is centralized in one abort path and follows a single principle:
**never destroy user work in the main checkout; always remove the dedicated
execution worktree.**

### 7.1 Review-mode execution worktree

When the review-mode execution worktree exists (`.worktrees/review-worktree`):

- Call the existing `cleanupWorktree("review-worktree", mainCwd)` (which runs
  `git worktree remove --force` and deletes the branch) exactly once,
  best-effort. Set `executionWorktreePath = null` afterward.
- Print one concise line:

  ```text
  [ABORT] removed execution worktree .worktrees/review-worktree (staged work discarded)
  ```

- If cleanup fails, print a `[WARNING]` with the bounded git error; do not
  change the abort exit code.

### 7.2 Main checkout

- Do **not** run `git reset`, `git checkout`, `git clean`, or any other
  rollback command in the main checkout on abort. Any work already committed
  by non-review execution stays committed; any staged or uncommitted changes
  stay exactly where they are.
- Print one concise line when the main checkout may contain partial work:

  ```text
  [ABORT] main-checkout changes were left as-is; no automatic rollback was performed
  ```

- Temporary artifacts are removed only when this run created and owns them
  (for example atomic-write temp files already cleaned by their own error
  paths). User files are never deleted.

### 7.3 Config data

Before exiting, best-effort persist the run's `configData` with a `lastAbort`
entry containing `kind`, `phase`, `step`, `reason`, and a timestamp. Use the
existing `saveData` behavior and the existing redaction rules; never write
credentials or secret-store content.

## 8. Spec Keeper task-mode updates

When task mode is active and the task lifecycle has not already been
finalized:

- Best-effort update the claimed task to `blocked` (not `failed`) with a
  status note and task note of the form `Aborted (<kind>): <bounded reason>`.
- Reuse the existing task-mode failure helpers
  (`finalizeTaskModeFailure`/`failSpecKeeperTask`) so the status, note, and
  proof sequence stays consistent.
- A Spec Keeper update failure during abort cleanup is logged as a
  `[WARNING]` and must not mask the abort reason or change the exit code.
- For prompt-mode Spec Keeper artifacts (epic/run task/step tasks), apply the
  same best-effort `blocked` transition that the existing failure path uses,
  with the abort reason as the status note.

## 9. Abort signal plumbing (contract)

- A single `AbortController` is created at the CLI entrypoint before any LLM
  or planner work starts.
- Its `signal` is passed through `MultiTurnLlmRuntime.create` into the
  `GenerateRequest.signal` already defined in `llm/adapter-contract.ts`, and
  from there into each provider adapter that supports an abort signal.
- Before every phase (planning necessity, planning, execution step, replan,
  review plan, review) and before every retry/replan attempt, the runtime
  checks `signal.aborted`. If aborted, it throws or returns the matching
  `RunAbortError` immediately and starts no new work.
- In-flight LLM requests are aborted where the adapter supports it; adapters
  that do not support cancellation still honor the next check before starting
  any subsequent request.
- SIGINT and SIGTERM handlers call `controller.abort(reason)` and do not call
  `process.exit()` except on the second SIGINT emergency path described in
  section 3.

## 10. Constants

| Constant | Default | Meaning |
| --- | --- | --- |
| `maxReplanAttempts` | `3` | Existing replan attempt budget; reaching it while replan is still required now aborts as `stuck`. |
| `maxConsecutiveNoProgressReplans` | `2` | Consecutive accepted replans that leave the remaining plan unchanged before the run is `stuck`. |
| `maxReplanDurationMs` | `120000` | Total wall-clock replan budget before the run is `stuck`. |
| `maxReplanParseRetries` | `2` | Parse retries for a single replan response before it is `unable-to-complete`. |
| `maxPlanParseRetries` | `1` | Parse retries for the initial planning response before it is `unable-to-complete`. |
| `maxReviewParseRetries` | `2` | Parse retries for a review result before it is `unable-to-complete`. |
| `abortReasonMaxLength` | `400` | Maximum printed/stored abort reason length. |

## 11. Acceptance notes for later steps

- Step 3 (AbortController plumbing) implements section 9 and the `RunAbortError`
  type from section 2.
- Step 4 (user-facing abort handling) implements sections 3, 6, and the signal
  handlers from section 9.
- Step 5 (unable-to-complete and stuck detection) implements sections 4 and 5
  and updates `prompts/planning-suffix.txt` and `prompts/replan-prompt.txt`.
- Step 6 (cleanup and status reporting) implements sections 7 and 8.
- Step 7 (tests) asserts each exit code, each abort message shape, and the
  cleanup rules above with mocked adapters and temporary worktrees.
