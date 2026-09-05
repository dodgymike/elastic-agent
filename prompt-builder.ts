/**
 * Prompt building and template rendering.
 *
 * This module contains the pure prompt-construction helpers used by the CLI:
 * `renderPrompt` substitutes a `${...}` interpolation template against a variable
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

/** Render own, scalar named placeholders without evaluating template code.
 * Substituted values are literal text and are never scanned a second time.
 */
export function renderPrompt(template: string, variables: Record<string, unknown>): string {
    return template.replace(/\$\{([^}]*)\}|\$\{/g, (placeholder, name: string | undefined) => {
        if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error("Invalid prompt placeholder: only named values are supported.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(variables, name);
        if (!descriptor || !("value" in descriptor)) throw new Error(`Unknown prompt placeholder: ${name}`);
        const value = descriptor.value;
        if (!["string", "number", "boolean"].includes(typeof value)) {
            throw new Error(`Prompt placeholder ${name} must be a scalar value.`);
        }
        return String(value);
    });
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
