import { LlmAdapterError, type ProviderId } from "./adapter-contract.js";
import { normalizeProviderId, type AdapterEnvironment } from "./adapter-registry.js";

/** The model setting resolved for a selected built-in provider. */
export interface ModelConfiguration {
  readonly provider: ProviderId;
  readonly model: string;
  /** The provider-specific runtime variable that may override the default. */
  readonly environmentVariable: string;
}

/** The highest-capability model setting resolved for a provider (for compaction/refinement tasks). */
export interface HighestModelConfiguration {
  readonly provider: ProviderId;
  readonly model: string;
  /** The provider-specific runtime variable that may override the highest default. */
  readonly environmentVariable: string;
}

interface ProviderModelDefault {
  readonly model: string;
  readonly highestModel: string;
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
    highestModel: "gpt-4.1",
    environmentVariable: "OPENAI_MODEL",
  }),
  "bedrock-claude": Object.freeze({
    model: "anthropic.claude-sonnet-4-20250514-v1:0",
    highestModel: "anthropic.claude-opus-4-20250514-v1:0",
    environmentVariable: "BEDROCK_CLAUDE_MODEL",
  }),
  "deepseek-v4": Object.freeze({
    model: "deepseek-chat",
    highestModel: "deepseek-v4-pro",
    environmentVariable: "DEEPSEEK_MODEL",
  }),
});

/** Suffix appended to a provider's model variable to form its highest-model override. */
export const HIGHEST_MODEL_ENV_SUFFIX = "MODEL_HIGHEST";

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

/**
 * Resolve the "highest"-capability model for the selected built-in provider.
 *
 * Compaction/refinement tasks (e.g. memory compaction) benefit from a stronger
 * model than the default per-step model. A non-empty provider-specific
 * `*_MODEL_HIGHEST` environment override has precedence over the documented
 * highest model; a blank override is rejected rather than silently picked. When
 * neither a dedicated override nor a provider highest default exists, this falls
 * back to the provider's ordinary default model so the runtime never fails open
 * into an unresolvable model.
 */
export function resolveHighestModelConfiguration(
  provider: ProviderId,
  environment: AdapterEnvironment = {},
): HighestModelConfiguration {
  const normalizedProvider = normalizeProviderId(provider);
  const definition = PROVIDER_MODEL_DEFAULTS[normalizedProvider];
  if (!definition) {
    throw configurationError(`No default model is configured for LLM provider '${normalizedProvider}'.`);
  }

  // The highest-model override variable is `<PROVIDER>_MODEL_HIGHEST`, derived
  // from the provider's model variable by trimming its trailing `_MODEL` suffix
  // (e.g. OPENAI_MODEL -> OPENAI_MODEL_HIGHEST, DEEPSEEK_MODEL ->
  // DEEPSEEK_MODEL_HIGHEST, BEDROCK_CLAUDE_MODEL -> BEDROCK_CLAUDE_MODEL_HIGHEST).
  const baseVariable = definition.environmentVariable.replace(/_MODEL$/, "");
  const overrideVariable = `${baseVariable}_MODEL_HIGHEST`;
  const override = environment[overrideVariable];
  if (override !== undefined && override.trim() === "") {
    throw configurationError(`${overrideVariable} must be a non-empty model ID when set.`);
  }
  const model = override?.trim() || definition.highestModel || definition.model;

  return Object.freeze({
    provider: normalizedProvider,
    model,
    environmentVariable: overrideVariable,
  });
}
