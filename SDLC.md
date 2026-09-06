# SDLC.md — Software Development Lifecycle Process

This document describes the development lifecycle followed by the `elastic-agent`
runtime when planning and executing a prompt. It is referenced directly by the
post-plan review phase (criterion (c) below), so it must stay in sync with the
process actually implemented in the CLI orchestrator (`main.ts`) and its focused
modules described under [Module structure](#module-structure) below.

## Overview

The agent runs a plan-then-execute loop against a configurable LLM provider with
an optional post-plan **review phase** that runs only when the run was started
with `--review` (`options.review`). The lifecycle is:

1. **Plan** — build a planning prompt and let the model investigate through
   multiple tool-call turns before returning a validated execution plan.
2. **Execute** — run each plan step, invoking tools as needed, and collect a
   machine-readable execution-feedback block per step. Replanning is supported
   when a step requests it (up to `maxReplanAttempts`).
3. **Review** — when `--review` is enabled, run a review of the completed
   work against the four criteria listed below.
4. **Finish or stop** — if the review passes, the staged work is committed and
   merged into the main branch and the run finishes. If the review does not
   pass (or its JSON cannot be parsed after retries), the run stops: the
   worktree work is left uncommitted and the run, epic, and task are marked
   blocked.

### Step results and the final tldr

After each step completes, the execution loop appends the step's **result** —
derived only from the model's execution-feedback block (`stepStatus`, `summary`,
`findings`) or a validation error when feedback did not parse — alongside the
step number and text on `configData.completedSteps`. This per-step result is
secret-safe: it never includes file contents, `data.json`, or credentials.

At the end of a run, `reportImplementationTldr` (the final console recap) reads
those completed steps and prints a **`Step results/comments:`** section listing
each step's summary/findings (or a "no per-step feedback recorded" note when a
step ran without captured feedback). Existing consumers that only read a step's
number/text are unaffected by the added `result` field.

## Module structure

`main.ts` is the CLI orchestrator: it parses command-line arguments and options,
loads configuration, wires the provider and dependencies, and drives the overall
plan-then-execute flow (running steps, invoking tools, the replan request loop,
phase-restart application, and Spec Keeper / worktree / LLM interactions). The
stateful orchestration functions (`runExecutionPhase`, `runReviewPhase`,
`executePlanStep`, `dispatchToolCall`, and the tool-render wrappers) intentionally
remain in `main.ts`, anchored by the CLI's source-text structure tests and bound
to the run's module-level configuration.

The prompt-building, parsing, and deterministic plan/step logic is factored into
focused, dependency-light modules:

| Module             | Responsibility                                                                                     |
|--------------------|---------------------------------------------------------------------------------------------------|
| `planner-prompt.ts`| Pure assembly of the planner/replanner/review-plan LLM prompts from the `prompts/*.txt` templates. |
| `prompt-parser.ts` | Parsing and validating the model's JSON plan/step responses (plan, phase, abort; restart detection). |
| `plan-handler.ts`  | Deterministic plan/step shaping & reporting: `planSteps`, `actionablePlanSteps`, `formatPlan`, `appendSuggestedUpdate`, `applyExecutionFeedback`, `fightingDenialCount`, `reportExecutionFeedback`, `reportAppliedPlanChanges`, plus token-usage / tool-call / review-summary formatters. |

`main.ts` imports these helpers rather than re-implementing them. `prompt-builder.ts`
remains the leaf dependency (`renderPrompt`) used by `planner-prompt.ts`, and
`plan-printer.ts` owns the console plan indentation/output. The external prompt
*templates* stay under `prompts/` and are not duplicated in code.

## Review phase

The review phase runs only in the `--review` (`options.review`) branch, after
plan execution completes; without `--review`, execution completes directly with
no formal review. The review phase begins with a **plan step** (the agent
creates a plan for how to conduct the review) before the review prompt is sent
to the model.

The review prompt includes the full review instructions and asks the model to
assess all four of the following criteria:

- **(a) Prompt request fulfillment** — has the original prompt request been
  fully fulfilled by the executed work?
- **(b) End-result quality** — is the end result of good quality?
- **(c) SDLC.md compliance** — has the process described in this document been
  followed/met?
- **(d) Noted learnings** — any learnings worth recording from the execution,
  the plan, or earlier review attempts.

The model returns a structured JSON review result:

```json
{
  "passed": true,
  "reasons": [],
  "learnings": []
}
```

- `passed` is `true` only if all four criteria pass.
- `reasons` lists why the review did not pass (required when `passed` is false).
- `learnings` records any learnings.
- `reasons` and `learnings` must be arrays of strings.

### Retry / failure behavior

- The review result is parsed as JSON. If it cannot be parsed, the parsing error
  is appended to the review prompt and the same review request is retried (up to
  `maxReviewParseRetries`, default `2`, so at most three parse attempts). If it
  still cannot be parsed, the review phase aborts with an `unable-to-complete`
  review error and the run is finalized as blocked.
- A review that returns `passed: false` stops the run immediately: no commit is
  made, the worktree work is left uncommitted, and the run/epic/task are marked
  blocked (task mode finalizes its claimed task with the failing review
  reasons). There is no automatic re-execution of the plan.
- There is no max-attempt restart loop. `maxReviewAttempts` is kept only as a
  display label for the current review attempt in status and prompt text; the
  model gets a single formal review attempt per run.

## Logging

The planning prompt is not echoed to the terminal, including in verbose mode.
Planning status and the generated plan remain visible.

Every LLM prompt and response (planning, execution, replanning, review planning,
review, and JSON retries) is recorded to `llm.log` in full, without truncation.

Prompt logging is opt-in. Pass `--log-prompts` (or set `PROMPT_LOG_PATH` to
override the path) to append **every** LLM prompt — including the finalized
`messages` array with any injected session-memory context — to `prompt.log` in
the working directory. This covers all memory modes (in-memory, graph,
persistent, composite). Because the captured payload can include sensitive
session-memory content, `prompt.log` should be handled with care and kept out
of the repository (`prompt.log` is gitignored alongside `llm.log`).

## Constants

| Constant                | Default | Meaning                                                                        |
|-------------------------|---------|-------------------------------------------------------------------------------|
| `maxReplanAttempts`     | `3`     | Max focused replans within one execution                                      |
| `maxReviewAttempts`     | `3`     | Display label for the current review attempt; a failing review stops the run  |
| `maxReviewParseRetries` | `2`     | JSON parse retries within a single review attempt                             |

## Investigative planning

Formal initial planning uses `llm/planning-loop.ts`. The planner can read named
files, list/find/grep local source, inspect read-only Git modes, and research
permitted URLs or search API endpoints through HTTP GET/HEAD. There is no
built-in web-search provider; existing HTTP origin and network policies apply.
Planning advertises only these research tools and rejects mutation calls before
dispatch. Allowed calls use the normal safety classifier, execution policy,
rendering, and tool handlers. Shell commands are deferred to execution.

Research can span 100 tool-call rounds and 250 calls, including calls made during
JSON repair. Exhausting either limit aborts planning before further tools run.
Tools retain their existing per-call limits, and user cancellation is honored.
These are call-count limits, not a new overall wall-clock deadline.

The runtime preserves the conversation and tool results between research turns.
A final text response must parse as a plan or explicit abort; one JSON repair is
allowed and receives the gathered evidence. Intermediate tool turns are not
parsed as final plans. Planning calls contribute to usage and normal LLM logs,
and research calls contribute to tool history, without being recorded as
completed execution steps. CLAUDE.md remains the first prompt section.

The no-plan fast path remains direct execution. Review planning and focused
replanning retain their existing behavior. Run `npm run test:planning-loop` for
research-loop regression tests.
