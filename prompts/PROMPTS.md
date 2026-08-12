# PROMPTS.md

This document describes the LLM prompts used by the `elastic-agent` runtime and
how they are loaded. Prior to the prompt-extraction refactor these prompt
strings and skeletons were embedded directly in source code (`main.ts` and
`llm/deepseek-v4-adapter.ts`). They now live as standalone files under
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
   replan prompt.

Each stage uses a distinct prompt, captured in the files below. CLAUDE.md
agent-facing operating instructions are not part of this extraction.

## Directory layout

| File                            | Constant / use                         | Source        |
|---------------------------------|----------------------------------------|---------------|
| `planning-suffix.txt`           | `planningSuffix`                       | `main.ts`     |
| `execution-feedback-format.txt` | `executionFeedbackFormat`              | `main.ts`     |
| `build-prompt-skeleton.txt`     | `buildPromptTemplate`                  | `main.ts`     |
| `step-execution-prompt.txt`     | `stepExecutionPromptTemplate`          | `main.ts`     |
| `replan-prompt.txt`             | `replanPromptTemplate`                 | `main.ts`     |
| `json-retry-hint.txt`           | `JSON_RETRY_HINT`                      | `llm/deepseek-v4-adapter.ts` |

## Loading mechanism

All six files are read synchronously at module load with Node's `readFileSync`,
resolved relative to the process working directory (the repository root).

In `main.ts`:

```ts
const planningSuffix            = readFileSync("prompts/planning-suffix.txt", "utf-8");
const executionFeedbackFormat   = readFileSync("prompts/execution-feedback-format.txt", "utf-8");
const buildPromptTemplate       = readFileSync("prompts/build-prompt-skeleton.txt", "utf-8");
const stepExecutionPromptTemplate = readFileSync("prompts/step-execution-prompt.txt", "utf-8");
const replanPromptTemplate      = readFileSync("prompts/replan-prompt.txt", "utf-8");
```

In `llm/deepseek-v4-adapter.ts`:

```ts
const JSON_RETRY_HINT = readFileSync("prompts/json-retry-hint.txt", "utf-8");
```

### Template interpolation

`build-prompt-skeleton.txt`, `step-execution-prompt.txt`, and
`replan-prompt.txt` are templates containing `${...}` interpolation
expressions. They are rendered at call time by the `renderPrompt(template,
variables)` helper in `main.ts`:

```ts
function renderPrompt(template, variables) {
    const names = Object.keys(variables);
    const values = names.map((name) => variables[name]);
    const evaluator = new Function(...names, `return \`${template.replace(/`/g, "\\`")}\`;`);
    return evaluator(...values);
}
```

`renderPrompt` evaluates each `${...}` expression inside the template against
the supplied variable map, so the template files remain authoritative while the
actual values (e.g. `claudeInstructions`, `plan`, `feedback`) are supplied by
the runtime at call time. Any backticks in prompt text (such as the JSON fence
markers in `execution-feedback-format.txt`) are escaped so they cannot break the
template evaluation.

The remaining files (`planning-suffix.txt`, `execution-feedback-format.txt`,
`json-retry-hint.txt`) are plain text with no interpolation; they are used
verbatim.

## Per-file reference

### `planning-suffix.txt`

The exact suffix appended to the end of the planning request so the model
returns a concrete, later-executable plan rather than just answering. Used in
the planning stage of `main()`:

```ts
const planningResponse = await client.create({ input: `${prompt}\n\n${planningSuffix}` });
```

Plain text; no interpolation.

### `execution-feedback-format.txt`

The machine-readable execution-feedback contract appended to each step-execution
prompt. It instructs the model to report exactly one fenced JSON block with the
schema validated by `validateExecutionFeedback` / `parseExecutionFeedback` in
`main.ts` (fields `stepStatus`, `summary`, `findings`, `suggestedStepUpdate`,
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

Rendered by `buildPrompt()` before the planning suffix is appended.

### `step-execution-prompt.txt`

The per-step execution prompt used to start each plan step's first model call in
`executePlanStep`. It tells the model to carry out only the current step and
appends the execution-feedback format.

Interpolation points:

| Expression | Variable |
|------------|----------|
| `${claudeInstructions}` | contents of `CLAUDE.md` |
| `${plan}` | the full formatted plan |
| `${index + 1}` | one-based step index |
| `${steps.length}` | total number of plan steps |
| `${step}` | the current step's text |
| `${executionFeedbackFormat}` | the contents of `execution-feedback-format.txt` |

### `replan-prompt.txt`

The focused replanning prompt used by `attemptReplan` when a step's feedback
requests replanning. It asks the model to replace only the remaining work
without repeating completed steps or executing tools, and to return a concise
numbered revised plan. The revised plan is validated by
`actionablePlanSteps` (must contain 1–`maxRevisedPlanSteps` numbered steps).

Interpolation points:

| Expression | Variable |
|------------|----------|
| `${claudeInstructions}` | contents of `CLAUDE.md` |
| `${completedWork}` | completed step list |
| `${JSON.stringify(feedback)}` | the validated feedback object |
| `${toolFindings}` | recent tool-result TLDRs |
| `${formatPlan(remainingSteps)}` | formatted remaining steps |
| `${...}` (as needed) | remaining interpolation via `renderPrompt` |

### `json-retry-hint.txt`

The JSON-purity hint injected by `llm/deepseek-v4-adapter.ts` as a trailing
system message on the single retry issued when a DeepSeek response returns
tool-call arguments that could not be parsed even after exhaustive JSON repair
(see `buildRetryPayload` and the retry path in `DeepSeekV4Adapter.generate`).
It tells the model to return pure, well-formed JSON with no prose, fences,
comments, trailing commas, or unescaped characters.

Plain text; no interpolation.

## Editing prompts

- Edit the file under `/elastic-agent/prompts/` directly; the runtime loads it
  from disk, so no source recompile is needed for text-only changes.
- Keep interpolation placeholders (`${...}`) intact in the template files
  (`build-prompt-skeleton.txt`, `step-execution-prompt.txt`,
  `replan-prompt.txt`). They are resolved at call time by `renderPrompt`.
- Preserve the JSON fence markers (` ```json ` ... ` ``` `) and the field
  names in `execution-feedback-format.txt`; they must stay consistent with
  `validateExecutionFeedback` in `main.ts`.
- Do not introduce secrets or credentials into any prompt file.
