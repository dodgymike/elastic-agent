import { LlmAdapterError, type ProviderId } from "./adapter-contract.js";
import { normalizeProviderId, type AdapterEnvironment } from "./adapter-registry.js";

/** The model setting resolved for a selected built-in provider. */
export interface ModelConfiguration {
  readonly provider: ProviderId;
  readonly model: string;
  /** The provider-specific runtime variable that may override the default. */
  readonly environmentVariable: string;
}

interface ProviderModelDefault {
  readonly model: string;
  readonly environmentVariable: string;
}

/**
 * Deliberate portable-runtime defaults. Deployments may override only the
 * selected provider through its documented provider-specific variable; a
 * provider selector never implies that another provider's model setting is
 * read.
 */
const PROVIDER_MODEL_DEFAULTS: Readonly<Record<string, ProviderModelDefault>> = Object.freeze({
  openai: Object.freeze({
    model: "gpt-4.1-mini",
    environmentVariable: "OPENAI_MODEL",
  }),
  "bedrock-claude": Object.freeze({
    model: "anthropic.claude-sonnet-4-20250514-v1:0",
    environmentVariable: "BEDROCK_CLAUDE_MODEL",
  }),
  "deepseek-v4": Object.freeze({
    model: "deepseek-chat",
    environmentVariable: "DEEPSEEK_MODEL",
  }),
});

function configurationError(message: string): LlmAdapterError {
  return new LlmAdapterError("model-defaults", "configuration", message);
}

/**
 * Resolve the model for the selected built-in provider. A non-empty
 * provider-specific environment override has precedence over the documented
 * default. Blank overrides are rejected rather than silently changing the
 * runtime's configured model.
 */
export function resolveModelConfiguration(
  provider: ProviderId,
  environment: AdapterEnvironment = {},
): ModelConfiguration {
  const normalizedProvider = normalizeProviderId(provider);
  const definition = PROVIDER_MODEL_DEFAULTS[normalizedProvider];
  if (!definition) {
    throw configurationError(`No default model is configured for LLM provider '${normalizedProvider}'.`);
  }

  const configuredModel = environment[definition.environmentVariable];
  if (configuredModel !== undefined && configuredModel.trim() === "") {
    throw configurationError(`${definition.environmentVariable} must be a non-empty model ID when set.`);
  }

  return Object.freeze({
    provider: normalizedProvider,
    model: configuredModel?.trim() || definition.model,
    environmentVariable: definition.environmentVariable,
  });
}
