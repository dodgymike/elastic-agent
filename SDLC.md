# SDLC.md — Software Development Lifecycle Process

This document describes the development lifecycle followed by the `elastic-agent`
runtime when planning and executing a prompt. It is referenced directly by the
post-plan review phase (criterion (c) below), so it must stay in sync with the
process actually implemented in `main.ts`.

## Overview

The agent runs a plan-then-execute loop against a configurable LLM provider with
a mandatory post-plan **review phase**. The lifecycle is:

1. **Plan** — build a planning prompt and ask the model for a step-by-step
   execution plan.
2. **Execute** — run each plan step, invoking tools as needed, and collect a
   machine-readable execution-feedback block per step. Replanning is supported
   when a step requests it (up to `maxReplanAttempts`).
3. **Review** — after the plan is complete, run an automatic review of the
   completed work against the four criteria listed below.
4. **Finish or retry** — if the review passes, stop. If it does not pass and the
   retry budget remains, restart the **execution** phase (not the planning
   phase) with the review feedback and learnings injected; otherwise fail.

## Review phase

The review phase runs automatically after plan completion. It begins with a
**plan step** (the agent creates a plan for how to conduct the review) before the
review prompt is sent to the model.

The review prompt includes the full review instructions and asks the model to
assess all four of the following criteria:

- **(a) Prompt request fulfillment** — has the original prompt request been
  fully fulfilled by the executed work?
- **(b) End-result quality** — is the end result of good quality?
- **(c) SDLC.md compliance** — has the process described in this document been
  followed/met?
- **(d) Noted learnings** — any learnings worth carrying into the next
  execution attempt.

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
  is appended to the review prompt and the request is retried (up to a small
  number of retries). If it still cannot be parsed, the review is treated as
  failed with an unparseable-response reason.
- If the review does not pass and the review-attempt budget remains, execution
  is restarted from the **execution phase** (not the planning phase) with the
  review feedback and learnings injected into the step-execution prompts.
- The maximum number of review attempts is `maxReviewAttempts` (default `3`).
- If a fourth review would be required (i.e., the review fails on the final
  allowed attempt), the agent throws an error explaining why it is not
  finishing, rather than looping forever.

## Logging

Every LLM prompt and response (planning, execution, replanning, review planning,
review, and JSON retries) is recorded to `llm.log` in full, without truncation.

## Constants

| Constant            | Default | Meaning                                  |
|---------------------|---------|------------------------------------------|
| `maxReplanAttempts` | `3`     | Max focused replans within one execution |
| `maxReviewAttempts` | `3`     | Max post-plan review attempts            |
