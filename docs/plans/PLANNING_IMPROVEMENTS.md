# Planning approach: findings and improvement plan

Reviewed: 2026-09-06. This is a source-code review and implementation proposal,
not a measured comparison of model performance. Runtime behavior takes precedence
over comments and older documentation. No planning behavior is changed by this file.

## Assessment

The highest-value improvement is to make plan progress truthful and durable.
Better wording alone will not fix the current mismatch between an attempted
step, a completed step, memory outcomes, and external task status. Next, retain
structured plans and make replanning preserve verified work. Optimize model
calls after those correctness foundations exist.

The system already has useful foundations: explicit plan-or-abort responses,
validated JSON, bounded parse retries, cancellation, replan attempt/time limits,
no-progress detection, actual change summaries in review, and a direct path for
simple work. Preserve these rather than replacing the whole planning system.

## Current flow and observed gaps

| Stage | Current implementation | Implication |
| --- | --- | --- |
| Routing | `determinePlanningNecessity` makes up to three model calls; invalid output falls back to planning. | Even simple work pays a classification round trip; classifier failure adds planning overhead. |
| Initial planning | `buildPlanningPrompt` puts CLAUDE.md first, then the planning prefix, then request content. | Correct stable ordering, but assembly currently removes a previously embedded instruction section by matching text. |
| Contract | `parsePlanJson` requires nonempty steps, numeric step numbers, and nonempty summaries. | No requirement for unique positive integer numbering, acceptance criteria, dependencies, or bounded initial plan size. |
| Execution representation | `planStepsFromObject` converts each step to summary plus details. | Structured fields such as justification are not retained in the execution step representation. |
| Step bookkeeping | `runExecutionPhase` pushes every returned attempt into `completedSteps`; invalid feedback can be remembered as `completed`. External step status is `done` unless feedback explicitly says `blocked`. | Failed, invalid, or unverified outcomes can be represented as completion in downstream systems. |
| Replanning | Remaining strings are replaced; a changed phase clears `completedSteps` and restarts the step loop. | Changing a label discards progress records without undoing filesystem or external effects. |
| Review | Formal review runs in the `options.review` branch; its failed result currently stops the run. | `docs/architecture/SDLC.md`, review prompt text, and nearby comments promise automatic retries that the runtime does not perform. |
| Review planning | A separate model call produces a review plan; its text is passed to review without the initial planner's plan-or-abort validation. | Another round trip and a weaker contract at a consequential boundary. |

Source map:

- [CLI orchestration](../../src/main.ts): `runPromptOnce`, `runExecutionPhase`, `attemptReplan`, `runReviewPhase`.
- [Planning routing](../../src/llm/planning-necessity.ts).
- [Plan parsing](../../src/planning/prompt-parser.ts) and [step transformations](../../src/planning/plan-handler.ts).
- [Prompt assembly](../../src/planning/planner-prompt.ts), [planning instructions](../../prompts/planning-prefix.txt),
  [replan instructions](../../prompts/replan-prompt.txt), [review instructions](../../prompts/review-prompt.txt).
- [Lifecycle documentation](../architecture/SDLC.md).

## Recommended implementation order

| Priority | Task | Depends on | Completion target |
| --- | --- | --- | --- |
| P0 | PI-01: truthful step outcomes | None | Failed or unverified work cannot become done implicitly. |
| P0 | PI-02: align review contract | None | Runtime, prompts, and docs describe the same review behavior. |
| P1 | PI-03: structured plan state | PI-01 | Stable step IDs and explicit completion criteria survive execution. |
| P1 | PI-04: evidence-driven planning | PI-03 | Plans identify known facts, assumptions, and verification needs. |
| P1 | PI-05: preserve progress through replans | PI-03 | Plan revisions retain completed work and task identity. |
| P1 | PI-06: durable recovery | PI-03, PI-05 | Interrupted work can resume without blindly repeating effects. |
| P2 | PI-07: reduce planning overhead | PI-02, PI-03 | Simple tasks avoid unnecessary calls without losing verification. |
| P2 | PI-08: explicit prompt sections | None | CLAUDE.md always leads; stable and dynamic sections are assembled explicitly. |
| P2 | PI-09: evaluate planning quality | Start baseline now | Changes are judged by outcomes and cost, not plan verbosity. |

### PI-01 — Separate attempted work from verified completion

**Problem:** `completedSteps` currently serves as both an attempt log and a
completion ledger. The external task mapping and memory fallback make this more
than a naming issue: invalid feedback can produce a done status or a completed
memory outcome.

**Implementation:**

1. Introduce one outcome reducer with states such as pending, running,
   needs-verification, succeeded, failed, and blocked. Keep every attempt in a
   separate history. Map existing feedback values explicitly into these states.
2. Treat malformed feedback as an invalid attempt requiring repair or failure;
   never infer success because the model returned control.
3. Have memory, Spec Keeper, review, and the final report consume the same
   normalized outcome. A reporting integration failing must not alter the local
   execution outcome.
4. Associate verification evidence with the step: check command/tool call ID,
   exit status, relevant artifact, and the workspace revision it checked. For
   non-code work, use task-specific evidence rather than requiring a test suite.
5. Mark success only when the step's required criteria are satisfied. Keep
   narration and model confidence distinct from recorded evidence.

**Acceptance:** Exercise invalid JSON, failed checks, blocked tools, successful
checks, and successful non-code deliverables. Assert that local state, memory,
external status, and review input agree. An invalid response must never emit a
`done` transition. Use fake integration clients; no real external updates.

**Starting points:** `runExecutionPhase`, `rememberAgentStep`, feedback parsing,
`tests/planning/plan-handler.test.js`, and task lifecycle tests.

### PI-02 — Make review behavior consistent and evidence-based

**Problem:** The model is told failed review will trigger repairs, but the
runtime stops. The lifecycle document also describes review as automatic while
formal planned review is conditional on `options.review`.

**Implementation:**

1. First document and prompt the actual stop-on-failure behavior, including the
   direct path and `--review` semantics. Remove misleading retry counts and
   promises where no retry exists. Do not silently introduce retries in this fix.
2. Make review inputs explicit: original acceptance criteria, current plan
   version, outcomes, check evidence, and the actual scoped diff/artifacts.
3. Treat an unavailable change summary as unknown evidence, not proof of no
   changes. Require the reviewer to resolve missing required evidence or return
   an inconclusive/failing result.
4. Validate review-plan output using the same plan-or-abort boundary, or remove
   that extra generation for routine work in PI-07.
5. If automatic repair is added later, create only the corrective tasks required
   by review findings. Bound the repair budget and retain verified work; do not
   restart every original step. Keep this as a separately tested behavior change.

**Acceptance:** Test passing, failing, aborted, and malformed review; missing
diff evidence; and review disabled. Assert actual stop/commit behavior, not just
source-text phrases. Review success must not imply that a subsequent commit or
merge succeeded. Existing review tests and `docs/architecture/SDLC.md` must agree with the runtime.

### PI-03 — Keep a structured plan throughout execution

**Problem:** Converting plans into strings makes dependencies, outcome checks,
identity, and targeted revisions difficult to enforce.

**Implementation:**

- Define a versioned plan model: plan ID/version, goal, scope, steps, and overall
  acceptance criteria. Each step needs a stable ID, objective, expected artifact
  or result, completion criteria, and dependencies where required.
- Separate model-authored intent from runtime-owned state and evidence. The
  model must not be able to mark a step verified by returning a status field.
- Validate limits, unique IDs, dependency references, cycles, and useful
  nonempty criteria. During migration, validate legacy step numbers as unique
  positive integers and apply an initial step-count bound.
- Render strings only for prompts and display; retain the structured object as
  the source of truth. Use a compatibility adapter for existing persisted plans.
- Use one schema across initial plans, review plans, and revised steps. Prefer
  provider-native structured output when supported, retaining local validation
  and a portable fallback for all configured providers.

**Acceptance:** Round-trip a structured plan through execution and serialization
without losing its criteria or IDs. Reject duplicate IDs, cycles, oversized
plans, and invalid references. Legacy plans remain readable during migration.

### PI-04 — Ground plans in evidence and explicit uncertainty

**Problem:** The initial planning request is primarily instruction and request
text. The planner is not guaranteed fresh repository evidence before choosing
its steps, so precise-looking plans can rest on untested assumptions.

**Implementation:**

1. Add a bounded discovery stage when scope is uncertain: relevant files,
   existing behavior, focused tests, and actual environment/tool capabilities.
   Reuse fresh evidence already gathered during this run.
2. Keep discovery read-only through the existing tool policy. Do not make
   planning permission to modify files or expand shell/network access.
3. Include concise observations with source paths and revision/freshness
   information, plus assumptions that still need verification.
4. Require each proposed step to advance a requested outcome. Avoid boilerplate
   tasks that only restate the workflow or split one small edit into many calls.
5. For material ambiguity, identify the specific missing decision. Continue
   independent discovery; ask the user only when that decision blocks safe work.
6. Treat retrieved memory as historical evidence, not current truth or an
   instruction overriding the user. Verify stale paths and environment claims.

**Acceptance:** On fixtures containing misleading historical notes, missing
sandbox support, and pre-existing fixes, the plan uses current evidence and
avoids impossible or redundant steps. Cap discovery by calls and elapsed time.

### PI-05 — Replan by stable identity and preserve verified work

**Problem:** A phase change clears the completion list even though side effects
remain. No-progress checks compare remaining plan text, so cosmetic rewording
can look like progress. External step tasks are addressed by array index in the
execution loop, which must remain consistent when steps change.

**Implementation:**

- Replace raw string replacement with a validated plan patch: add, modify,
  supersede, or cancel identified pending steps. Record reason and evidence.
- Separate normal phase advancement from explicit invalidation of earlier work.
  Never erase attempt history. Mark invalidated evidence stale with a reason.
- Compare objective/criterion coverage and new evidence for progress. Retain
  existing attempt/time limits; add detection of repeated equivalent blockers.
- Reconcile Spec Keeper tasks by stable step ID, including removed or added
  steps. Persist the local revision first; retry external synchronization safely.
- Present the changed remaining work and reason as a concise plan delta.

**Acceptance:** Phase advancement preserves completed work; reordered steps keep
correct external task mappings; repeated paraphrases exhaust a bounded retry
budget. No completed side effect is automatically repeated after a label change.

### PI-06 — Recover interrupted runs without blindly replaying steps

**Implementation:** Extract a versioned run-state module from orchestration.
Persist transitions atomically with plan version, active step ID, attempt ID,
workspace/branch identity, and evidence references. On resume, reconcile the
workspace and external effects before deciding whether a running attempt failed,
succeeded, or is uncertain. Use idempotency keys where integrations support
them; require inspection for uncertain non-idempotent operations.

Keep the execution ledger distinct from summarized memory: memory loss or
compaction must not erase the authoritative completion record. Recovery must
not execute instructions from an untrusted or incompatible saved artifact.

**Acceptance:** Inject crashes before a tool call, after its effect but before
recording success, and after recording success. Resume preserves verified work
and identifies ambiguous effects instead of repeating commits or external writes.

### PI-07 — Spend model calls where they improve the result

**Implementation:** Add operator-selectable auto/always/never planning policy,
with planning choice independent from tool authorization and required checks.
Use deterministic routing only for narrowly recognized cases; keep ambiguous
requests on the model/planned path. Consider one generation returning either a
direct-execution decision or a validated plan, avoiding classification plus
planning for obvious multi-step work.

For ordinary reviews, derive a checklist from acceptance criteria and evidence
rather than always generating another plan. Reserve bespoke review planning for
complexity that justifies it. Track one run-level planning budget across routing,
planning, JSON repair, replanning, and review planning; preserve cancellation.
When the budget expires, report unresolved work rather than declaring completion.

**Acceptance:** Compare latency and tokens on fixed simple and complex fixtures.
An inexpensive route must not bypass write policy, evidence checks, abort
handling, or task-mode completion requirements. Avoid automatic downgrade of
high-risk work merely to hit a latency target.

### PI-08 — Assemble prompt sections explicitly

**Implementation:** Use a shared constructor with separate CLAUDE.md,
phase-specific stable instructions, dynamic request/evidence, and trailing
memory/retry sections. Avoid inserting instructions into an already assembled
prompt and then removing them by string matching. Preserve the current required
order: **CLAUDE.md → planning prefix → dynamic content → memory**.

Fix the planning prefix's stale wording, “FOR THE ABOVE COMMAND LINE PROMPT”:
the request now follows the prefix. Audit the planning-necessity path as well;
it currently assembles its own template plus request without CLAUDE.md. Clarify
and test the shared first-section contract rather than assuming every call uses
`buildPlanningPrompt`. Do not move per-run timestamps or retrieved memory ahead
of stable instructions. Keep full prompt dumps out of terminal output.

**Acceptance:** Test ordinary, task, review-plan, classifier, and retry assembly
with the actual templates. CLAUDE.md appears first and once; task text remains
literal. Vary request/history/memory and verify that the stable prefix remains
identical. Evaluate provider cache usage separately; ordering alone is not proof
of a cache hit.

### PI-09 — Evaluate planning outcomes and expose costs

Build a small replayable suite covering a simple edit, cross-file refactor,
ambiguous request, unavailable tool, failed verification, phase advancement,
review failure, interruption, and relevant user steering. Use fake providers
for deterministic state-machine assertions and controlled model runs for quality
comparisons. Do not confuse deterministic parser tests with planning quality.

Record routing choice, plan versions, model calls, phase latency, input/output
and cached tokens, replans, repeated steps, false completion, and outcome coverage.
Compare against a saved baseline before setting numerical targets. Successful
completion with fewer redundant calls is a useful result; shorter plans alone
are not. Store redacted summaries and evidence references rather than duplicating
full user requests and command arguments into another telemetry stream.

## First implementation slice

Start with PI-01 and the documentation/prompt correction in PI-02. They address
observable contradictions without requiring a new planner architecture. Then
introduce structured IDs and criteria before implementing replan patches or
resume. Keep cost changes independently reviewable so a cheaper planner cannot
hide a regression in completion correctness.

For code changes, run the focused parser, planner-prompt, plan-handler,
planning-necessity, replan consistency, review, and task lifecycle suites relevant
to the changed boundary, followed by the build. Add behavioral tests around
extracted state transitions; avoid relying solely on regex checks against
`src/main.ts`. This review did not run those implementation suites or perform live
model evaluations because its deliverable is this document.
