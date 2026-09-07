# PROMPTS.md

This document describes the LLM prompts used by the `elastic-agent` runtime and
how they are loaded. Prior to the prompt-extraction refactor these prompt
strings and skeletons were embedded directly in source code (`src/main.ts` and
`src/llm/deepseek-v4-adapter.ts`). They now live as standalone files under
`/elastic-agent/prompts/` and are loaded at runtime with `readFileSync`, so the
prompt text can be edited and reviewed without touching source code.

## Purpose and scope

The `elastic-agent` CLI runs a plan-then-execute loop against a configurable LLM
provider (OpenAI, Bedrock Claude Sonnet, or DeepSeek V4). The loop:

1. builds a planning prompt,
2. asks the model for a step-by-step execution plan,
3. executes each numbered plan step (potentially invoking tools),
4. asks the model to return a machine-readable execution-feedback block per step,
5. applies local/plan updates and, when replanning is requested, builds a focused
   replan prompt,
6. when the run was started with `--review`, runs a post-plan **review phase**
   that begins with a plan step and then asks the model to review the completed
   work against four criteria, returning a structured JSON review result, and
7. if the review passes, commits/merges the work and finishes; if the review
   does not pass (or its JSON cannot be parsed after retries), the run stops,
   the worktree work is left uncommitted, and the run/epic/task are marked
   blocked.

Each stage uses a distinct prompt, captured in the files below. CLAUDE.md
agent-facing operating instructions are not part of this extraction.

## Directory layout

| File                            | Constant / use                         | Source        |
|---------------------------------|----------------------------------------|---------------|
| `planning-prefix.txt`           | `planningPrefix`                       | `src/main.ts`     |
| `execution-feedback-format.txt` | `executionFeedbackFormat`              | `src/main.ts`     |
| `build-prompt-skeleton.txt`     | `buildPromptTemplate`                  | `src/main.ts`     |
| `step-execution-prompt.txt`     | `stepExecutionPromptTemplate`          | `src/main.ts`     |
| `replan-prompt.txt`             | `replanPromptTemplate`                 | `src/main.ts`     |
| `review-prompt.txt`             | `reviewPromptTemplate`                 | `src/main.ts`     |
| `json-retry-hint.txt`           | `JSON_RETRY_HINT`                      | `src/llm/deepseek-v4-adapter.ts` |
| `self-modification-section.txt` | `selfModificationSection` (flag-gated) | `src/main.ts`     |
| `memory-compaction.md`          | `memoryCompactionPrompt` (new)         | memory-compaction runtime   |

## Tool safety classifier prompts

The tool-safety classifier (`src/safety/tool-safety-classifier.ts`) loads its LLM prompt
through `TOOL_SAFETY_PROMPT_PATH`, which defaults to
`prompts/tool-safety-classifier.md`. The prompt has been split into a shared
base and two strict filesystem-policy addenda. Startup container detection
selects wording but never grants additional filesystem permissions:

| File                                      | Purpose                                                                 |
|-------------------------------------------|-------------------------------------------------------------------------|
| `tool-safety-classifier.base.md`          | Shared classifier rules: JSON contract, data-loss/exfiltration/secret/destructive/injection denials, the edit/write gate, read-only allow patterns, and the AgentBus allowance. No filesystem-boundary policy and no TOOL CALL footer. |
| `tool-safety-classifier.non-docker.md`    | Strict filesystem addendum: reads and writes must stay inside the working/startup directory and configured trusted directories. Ends with the TOOL CALL footer. |
| `tool-safety-classifier.docker.md`        | Relaxed filesystem addendum: for a detected Docker container session, filesystem access outside the working/startup directory is permitted while data.json, credentials, secrets, and unsafe commands remain forbidden. Ends with the TOOL CALL footer. |
| `tool-safety-classifier.md`               | Assembled non-Docker variant (base + non-docker addendum). This remains the runtime default until startup-based variant selection is wired into the classifier loader. |

An assembled variant is always `base` followed by exactly one policy addendum;
the addendum supplies the `TOOL CALL:` footer so the footer stays at the end of
the assembled prompt. The loader appends the tool name and normalized
parameters after the footer.

## Loading mechanism

The prompt files are read synchronously at module load with Node's
`readFileSync`, resolved relative to the process working directory (the
repository root).

In `src/main.ts`:

```ts
const planningPrefix            = readFileSync("prompts/planning-prefix.txt", "utf-8");
const executionFeedbackFormat   = readFileSync("prompts/execution-feedback-format.txt", "utf-8");
const buildPromptTemplate       = readFileSync("prompts/build-prompt-skeleton.txt", "utf-8");
const stepExecutionPromptTemplate = readFileSync("prompts/step-execution-prompt.txt", "utf-8");
const replanPromptTemplate      = readFileSync("prompts/replan-prompt.txt", "utf-8");
const reviewPromptTemplate      = readFileSync("prompts/review-prompt.txt", "utf-8");
```

In `src/llm/deepseek-v4-adapter.ts`:

```ts
const JSON_RETRY_HINT = readFileSync("prompts/json-retry-hint.txt", "utf-8");
```

### Template interpolation

`build-prompt-skeleton.txt`, `step-execution-prompt.txt`, `replan-prompt.txt`,
and `review-prompt.txt` use named `${placeholder}` values. The renderer in
`src/planning/prompt-builder.ts` only substitutes own scalar values (string, number, boolean).
It rejects expressions, unknown names, getters, and malformed placeholders.
Backticks and backslashes stay literal. Substituted text is never evaluated or
rescanned for placeholders.

Callers compute `feedbackJson`, `remainingPlan`, `stepNumber`, and `stepCount`
before rendering. Custom templates using JavaScript expressions must migrate
to those named placeholders. No template can execute JavaScript.

The remaining files (`planning-prefix.txt`, `execution-feedback-format.txt`,
`json-retry-hint.txt`) are plain text with no interpolation; they are used
verbatim.

## Per-file reference

### `planning-prefix.txt`

The stable planning instructions placed after `CLAUDE.md` and before the dynamic content of a planning request so the model
returns a concrete, later-executable plan rather than just answering. Used in
the planning stage and the review-phase plan step of `main()`:

```ts
const planningResponse = await client.create({ input: buildPlanningPrompt(prompt, planningPrefix, claudeInstructions) });
```

Plain text; no interpolation.

The required plan JSON shape is `{ "tldr", "steps", "expected_outcome" }`.
The prefix also documents an **optional top-level `phase` field** (e.g.
`"phase": 1` or `"phase": "design"`) that identifies a major stage of work
with its own steps. `phase` may only be present for plans with **very high
complexity** that genuinely need multiple phases and multiple steps; for
low-/medium-complexity work it must be omitted. When present it must be a
non-empty string or integer. This field forms the contract that the
planning-response parser (`src/ui/plan-printer.ts`) and the phase-aware handler logic
in `src/main.ts` rely on.

The parser (`src/ui/plan-printer.ts`) recognizes `phase` as an optional top-level
field and exposes it on the parsed plan. When present, the value is validated —
it must be a trimmed non-empty string or an integer (`null`, booleans, floats,
arrays, objects, and whitespace-only strings are rejected). The parser's parse
functions accept a `PlanJsonOptions` argument with a `requirePhase` flag: for
very-high-complexity plans the caller passes `{ requirePhase: true }` and the
parser rejects a plan that omits `phase`; for low-/medium-complexity work the
flag is left unset so the field is optional and may be absent.

The handler (`src/main.ts`) stores the plan's top-level `phase` on the run state as
`configData.planPhase` when the plan is created, so it can recognize the phase
the plan is currently in while executing. The focused replanner
(`attemptReplan` in `src/main.ts`) parses an optional `phase` from the replan
response (`parseReplanResponse` in `src/llm/replan-abort.ts`, which validates it the
same way — a non-empty string or integer) and compares it to the stored phase
with `phaseRestartRequired`. A replan that proposes a *different* phase is a
full restart: the whole plan is replaced, executed progress is cleared, the
stored phase is advanced, and execution restarts from step 0. A replan that
keeps the same phase (or omits it, meaning only step edits) replaces only the
remaining steps and continues without restarting.

The same `phase` field is documented in the replanner prompt
(`replan-prompt.txt`), where a proposed phase change is treated as a signal to
fully restart the plan, while changes confined to the current phase do not
restart it.

### `execution-feedback-format.txt`

The machine-readable execution-feedback contract appended to each step-execution
prompt. It instructs the model to report exactly one fenced JSON block with the
schema validated by `validateExecutionFeedback` / `parseExecutionFeedback` in
`src/main.ts` (fields `stepStatus`, `summary`, `findings`, `suggestedStepUpdate`,
`suggestedPlanUpdates`, `replanRequired`, `replanReason`).

Injected as the `executionFeedbackFormat` variable into
`step-execution-prompt.txt` via `renderPrompt`. Plain text; no interpolation.

### `build-prompt-skeleton.txt`

The skeleton template for the opening planning prompt, combining operating
instructions with recent command-line prompts and tool-call TLDR history.

Interpolation points:

| Expression             | Variable                          |
|------------------------|-----------------------------------|
| `${claudeInstructions}`| contents of `CLAUDE.md`           |
| `${historyLimit}`      | `historyLimit` (default `10`)     |
| `${promptHistory}`     | recent command-line prompts (numbered) |
| `${toolHistory}`       | recent tool-call TLDRs (numbered) |
| `${commandLinePrompt}` | the current positional CLI prompt |

Rendered by `buildPrompt()` before the planning prefix is appended.

### `self-modification-section.txt`

Plain-text self-modification instructions appended to the opening prompt only
when the tool-safety configuration has `allowAgentSourceModifications` enabled
(the agent was started with `--allow-agent-source-modifications`). It instructs
the model to keep edits scoped to the configured directories, preserve tests
and documentation, never read or write secret files such as `data.json`, run
verification, and commit the work when finished. The stable marker
`[SELF-MODIFICATION-ENABLED]` lets tests assert presence or absence of the
section. Plain text; no interpolation.

### `step-execution-prompt.txt`

The per-step execution prompt used to start each plan step's first model call in
`executePlanStep`. It tells the model to carry out only the current step and
appends the execution-feedback format.

Interpolation points:

| Expression | Variable |
|------------|----------|
| `${claudeInstructions}` | contents of `CLAUDE.md` |
| `${plan}` | the full formatted plan |
| `${stepNumber}` | one-based step index |
| `${stepCount}` | total number of plan steps |
| `${step}` | the current step's text |
| `${executionFeedbackFormat}` | the contents of `execution-feedback-format.txt` |
| `${executionContext}` | `(none)`; reserved — a failed review no longer restarts execution with feedback/learnings |

### `replan-prompt.txt`

The focused replanning prompt used by `attemptReplan` when a step's feedback
requests replanning. It asks the model to replace only the remaining work
without repeating completed steps or executing tools, and to return a concise
numbered revised plan. The revised plan is validated by
`actionablePlanSteps` (must contain 1–`maxRevisedPlanSteps` numbered steps) and
by `parseReplanResponse` in `src/llm/replan-abort.ts`.

The prompt is phase-aware. It documents the optional top-level `phase` field
that mirrors the planner prompt (`planning-prefix.txt`): a `phase` may only be
proposed for very-high-complexity plans that genuinely span multiple phases and
multiple steps, and when present it must be a non-empty string or integer. The
prompt states that proposing a **different** phase than the current one causes a
full restart (executed progress is abandoned and the whole plan restarts from
the first step), while changing individual tasks or revising steps **within** the
current phase does not restart the plan. The current phase is injected via
`${currentPhase}` (rendered as `"(none)"` when the plan has no phase).

Interpolation points:

| Expression | Variable |
|------------|----------|
| `${claudeInstructions}` | contents of `CLAUDE.md` |
| `${completedWork}` | completed step list |
| `${feedbackJson}` | the validated feedback object |
| `${toolFindings}` | recent tool-result TLDRs |
| `${remainingPlan}` | formatted remaining steps |
| `${currentPhase}` | the phase the plan is currently in, or `(none)` |
| `${...}` (as needed) | remaining interpolation via `renderPrompt` |

### `review-prompt.txt`

The post-plan review prompt used by `runReviewPhase` / `runReview` after the
plan has completed. It includes the full review instructions and asks the model
to assess all four review criteria: (a) prompt request fulfillment,
(b) end-result quality, (c) docs/architecture/SDLC.md compliance, and (d) noted learnings. It
requires a structured JSON review result (`{ "passed": boolean, "reasons":
[string], "learnings": [string] }`), validated by `validateReviewResult` /
`parseReviewResult` in `src/main.ts`. The `${changes}` block contains the concrete
staged diff, or the latest committed work from the execution worktree when the
staged diff is empty (so committed work is still visible to the reviewer).

Interpolation points:

| Expression | Variable |
|------------|----------|
| `${claudeInstructions}` | contents of `CLAUDE.md` |
| `${originalPrompt}` | the original command-line prompt request |
| `${plan}` | the full formatted plan |
| `${executedSteps}` | the list of executed steps |
| `${changes}` | staged diff (`git diff --cached`) or, when empty, the latest committed work from the execution worktree |
| `${reviewPlan}` | the review plan created at the start of the review phase |
| `${learnings}` | accumulated learnings recap (rendered by `formatLearnings`; currently `(none)` because a failing review stops the run) |
| `${reviewAttempt}` | the current one-based review attempt label |
| `${maxReviewAttempts}` | display ceiling for the attempt label; a failing review stops the run (no restart loop) |

### `json-retry-hint.txt`

The JSON-purity hint injected by `src/llm/deepseek-v4-adapter.ts` as a trailing
system message on the single retry issued when a DeepSeek response returns
tool-call arguments that could not be parsed even after exhaustive JSON repair
(see `buildRetryPayload` and the retry path in `DeepSeekV4Adapter.generate`).
It tells the model to return pure, well-formed JSON with no prose, fences,
comments, trailing commas, or unescaped characters.

Plain text; no interpolation.

### `memory-compaction.md`

The memory-compaction prompt used to compress an overgrown per-session memory
summary down to a reusable size before it is re-injected into a prompt. It is
a `${...}` interpolation template with a stable `[MEMORY-COMPACTION]` marker.
The prompt is intended to be rendered with `renderPrompt` and sent to the
highest-capability model so the compression preserves important detail.

Interpolation points:

| Expression | Variable |
|------------|----------|
| `${plan}` | the active plan (for context) |
| `${memory}` | the current session memory to compress |

The prompt instructs the model to preserve all important facts, decisions,
constraints, and outstanding work while removing redundancy and low-value
detail, and it forbids JSON output, code fences, and echoing the input back —
the response is the plain-text summary that replaces the memory. Tests in
`tests/memory/memory-compaction-prompt.test.ts` assert the placeholder and compression
contract.

## Prompt-cache ordering (canonical)

LLM providers with prompt caching (OpenAI `cached_tokens`, DeepSeek
`prompt_cache_hit_tokens`) match cache entries by **leading prefix**. A change
to the first bytes of an initial request invalidates the entire cache for that
request, so every initial (non-continuation) prompt MUST begin with a stable
prefix and keep all dynamic content after it.

The canonical order is:

1. **Stable role/rules/system instructions first.** For every prompt that
   carries `CLAUDE.md` this is `${claudeInstructions}`. For prompts that do not
   carry it, the prompt's own static instructional body is the stable prefix
   (`planning-necessity.prompt` for the classifier, the `reviewPlanGoal` string
   for the review-plan prompt).
2. **Static long-lived context second.** Stable prompt files/prose that are not
   deployment-specific, placed before dynamic sections when they currently
   interleave. Concretely, `execution-feedback-format.txt` moves to immediately
   after `${claudeInstructions}` in `step-execution-prompt.txt`.
3. **Dynamic memory, tool lists, conversation history, and tool-use responses
   last**, in this relative order:
   a. tool list (`toolsAvailable`);
   b. conversation/history recap (`${promptHistory}`, `${toolHistory}`);
   c. run/step-specific values (current prompt/work order, plan, step index and
      text, commit instruction, execution context, completed work, feedback,
      tool findings, remaining steps, original prompt, changes, review plan,
      learnings, review attempt);
   d. memory context (`[SESSION MEMORY …]` block) — appended as a **trailing**
      section by `src/llm/multi-turn-runtime.ts`, never prepended;
   e. tool-use responses — conversation continuations appended after the initial
      user message (the runtime already appends these; the initial user message
      stays untouched).

**Hard invariant (P0):** no dynamic text may appear before the stable prefix.
Trailing, cache-friendly additions that already satisfy the invariant are left
where they are: `self-modification-section.txt` (flag
gated), `startDirWarning`, retry/parse-error hints, and the DeepSeek JSON retry
hint (a trailing system message).

Per-prompt target order:

| Prompt | Current | Target |
|---|---|---|
| Planning-necessity | `planning-necessity.prompt` → user request → memory | `planning-necessity.prompt` → user request → memory |
| Opening planning | `CLAUDE.md` → `planning-prefix.txt` → history → current prompt → memory | `CLAUDE.md` → `planning-prefix.txt` → history → current prompt → memory |
| Review-plan | `CLAUDE.md` → `planning-prefix.txt` → `reviewPlanGoal` → memory | `CLAUDE.md` → `planning-prefix.txt` → `reviewPlanGoal` → memory |
| Step execution | `CLAUDE.md` → `execution-feedback-format.txt` → `toolsAvailable` → commit → plan → step → execution context | `CLAUDE.md` → `execution-feedback-format.txt` → `toolsAvailable` → commit → plan → step → execution context |
| Replan | `CLAUDE.md` → completed work/feedback/findings/remaining steps | unchanged (already stable-first) |
| Review | `CLAUDE.md` → original prompt/plan/executed steps/changes/learnings | unchanged (already stable-first) |
| Direct (prompt mode) | `buildPrompt` (stable-first) → `toolsAvailable` → commit → start-dir warning | unchanged |
| Direct (task mode) | `CLAUDE.md` → work-order sections → commit instruction → `toolsAvailable` | `CLAUDE.md` → work-order sections → commit instruction → `toolsAvailable` |
| Tool-use continuations | initial user message untouched; tool-result messages appended | unchanged |
| DeepSeek JSON retry | trailing system message | unchanged |

No violations remain: every initial prompt is stable-first and the memory
context is emitted as a trailing section.

`buildTaskWorkOrderPrompt` now emits a leading stable section (the task-mode
caller passes `claudeInstructions`) followed by the dynamic work-order header,
commit instruction, and `toolsAvailable`. The multi-turn runtime's memory
injection is a trailing append: the `[SESSION MEMORY …]` block is emitted as a
trailing section so it can never shift the stable prefix. Changing memory, the
tool list, or a tool-use response therefore never alters the leading bytes of
an initial request.

## Editing prompts

- Edit the file under `/elastic-agent/prompts/` directly; the runtime loads it
  from disk, so no source recompile is needed for text-only changes.
- Keep interpolation placeholders (`${...}`) intact in the template files
  (`build-prompt-skeleton.txt`, `step-execution-prompt.txt`,
  `replan-prompt.txt`, `review-prompt.txt`). They are resolved at call time by
  `renderPrompt`.
- Preserve the JSON fence markers ( ```json ` ... ` ``` ) and the field
  names in `execution-feedback-format.txt`; they must stay consistent with
  `validateExecutionFeedback` in `src/main.ts`.
- Preserve the review result field names (`passed`, `reasons`, `learnings`) in
  `review-prompt.txt`; they must stay consistent with `validateReviewResult` in
  `src/main.ts`.
- Do not introduce secrets or credentials into any prompt file.

### Research before initial planning

The initial planner may use the supplied research tools over multiple turns
before returning the plan JSON. `src/llm/planning-loop.ts` retains tool results,
enforces research-only calls and shared round/call budgets, and validates the
final plan. See [Investigative planning](architecture/SDLC.md#investigative-planning).
The standalone assembly examples above describe the initial prompt; production
initial planning passes it to this loop rather than a single generation.
