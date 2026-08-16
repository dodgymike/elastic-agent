/**
 * Prompt building and template rendering.
 *
 * This module contains the pure prompt-construction helpers used by the CLI:
 * `renderPrompt` evaluates a `${...}` interpolation template against a variable
 * map, and `buildPrompt` assembles the main agentic prompt from command-line
 * history, tool-call TLDRs, and the build-prompt skeleton. The helpers perform
 * no I/O and have no side effects so they can be unit tested without booting
 * the CLI or touching the filesystem.
 *
 * `buildPrompt` gates the self-modification section on the resolved
 * `allowAgentSourceModifications` boolean. The section is appended only when
 * the agent was started with `--allow-agent-source-modifications`; the default
 * path, standard agentic prompt, and classifier prompt do not receive it.
 */

/** Stable marker present in the self-modification section; used by tests. */
export const SELF_MODIFICATION_ENABLED_MARKER = "[SELF-MODIFICATION-ENABLED]";

/** Inputs consumed by `buildPrompt`. */
export interface BuildPromptOptions {
  /** Previous command-line prompts, oldest first. */
  readonly commandPrompts: readonly string[];
  /** Previous tool-call TLDR summaries, oldest first. */
  readonly toolCallTldrs: readonly string[];
  /** The current command-line prompt value to interpolate into the template. */
  readonly commandLinePromptValue: string;
  /** The build-prompt skeleton template with `${...}` interpolation points. */
  readonly template: string;
  /** The CLAUDE.md agent instructions loaded by the CLI. */
  readonly claudeInstructions: string;
  /** How many history entries are kept in the prompt. */
  readonly historyLimit: number;
  /** The self-modification instructions appended when modifications are allowed. */
  readonly selfModificationSection: string;
  /** True when the self-modification section should be appended. */
  readonly allowAgentSourceModifications: boolean;
}

/**
 * Render a prompt template by evaluating its `${...}` interpolation expressions
 * against the supplied variable map. The template text comes from the external
 * prompt files under /elastic-agent/prompts/; all `${...}` occurrences are
 * interpolation points resolved at call time. Backticks in the template are
 * escaped so JSON fence markers in prompt text cannot break the evaluation.
 */
export function renderPrompt(template: string, variables: Record<string, unknown>): string {
    const names = Object.keys(variables);
    const values = names.map((name) => variables[name]);
    const evaluator = new Function(...names, `return \`${template.replace(/`/g, "\\`")}\`;`);
    return evaluator(...values);
}

/**
 * Build the main agentic prompt from the command-line prompt history, tool-call
 * TLDR history, and the current command-line prompt. When
 * `allowAgentSourceModifications` is true the self-modification section is
 * appended after the rendered skeleton; otherwise the rendered skeleton is
 * returned unchanged.
 */
export function buildPrompt(options: BuildPromptOptions): string {
    const {
        commandPrompts,
        toolCallTldrs,
        commandLinePromptValue,
        template,
        claudeInstructions,
        historyLimit,
        selfModificationSection,
        allowAgentSourceModifications,
    } = options;
    const promptHistory = commandPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n") || "(none)";
    const toolHistory = toolCallTldrs.map((tldr, index) => `${index + 1}. ${tldr}`).join("\n") || "(none)";
    const renderedPrompt = renderPrompt(template, {
        claudeInstructions,
        historyLimit,
        promptHistory,
        toolHistory,
        commandLinePrompt: commandLinePromptValue,
    });
    return allowAgentSourceModifications
        ? `${renderedPrompt}\n\n${selfModificationSection}`
        : renderedPrompt;
}
