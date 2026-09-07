import type { ProviderId } from "./adapter-contract.js";
import {
  normalizeProviderId,
  type AdapterConfigurationInput,
  type AdapterEnvironment,
} from "./adapter-registry.js";
import {
  providerSupportsModel,
  supportedModelsForProvider,
  supportedProviders,
} from "./model-defaults.js";

/**
 * Provider selection resolved at the CLI boundary before application composition.
 * The runtime adapter is intentionally not constructed here: compatibility with
 * the active multi-turn executor is established in a later plan step.
 */
export interface CliProviderSelection {
  /** Canonical provider ID selected by --provider or LLM_PROVIDER. */
  readonly configuration: AdapterConfigurationInput;
  /** Arguments with the provider option removed for the existing CLI parser. */
  readonly remainingArgs: readonly string[];
}

function selectionError(message: string): Error {
  return new Error(`LLM provider selection error: ${message}`);
}

/**
 * Remove the provider option while preserving every other argument verbatim.
 * `--provider=value` is accepted alongside the canonical `--provider value`
 * form so shell wrappers can use either standard spelling.
 */
function readExplicitProvider(args: readonly string[]): {
  provider: string | undefined;
  remainingArgs: readonly string[];
} {
  const remainingArgs: string[] = [];
  let provider: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--provider") {
      if (provider !== undefined) throw selectionError("--provider may be specified only once.");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw selectionError("--provider requires a provider ID.");
      }
      provider = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--provider=")) {
      if (provider !== undefined) throw selectionError("--provider may be specified only once.");
      provider = argument.slice("--provider=".length);
      continue;
    }
    remainingArgs.push(argument);
  }

  return { provider, remainingArgs: Object.freeze(remainingArgs) };
}

/**
 * Define deterministic provider selection for all CLI runtimes:
 * `--provider <id>` has precedence over `LLM_PROVIDER`; neither source implies
 * a default. The selected value is normalized with the registry's canonical
 * provider-ID rules, but registered-provider validation remains composition's
 * responsibility.
 */
export function selectCliProvider(
  args: readonly string[],
  environment: AdapterEnvironment = {},
): CliProviderSelection {
  const explicit = readExplicitProvider(args);
  const candidate = explicit.provider ?? environment.LLM_PROVIDER;
  if (candidate === undefined || candidate.trim() === "") {
    throw selectionError("set --provider <provider-id> or LLM_PROVIDER.");
  }

  return Object.freeze({
    configuration: Object.freeze({ provider: normalizeProviderId(candidate) }),
    remainingArgs: explicit.remainingArgs,
  });
}

function plannerModelError(message: string): Error {
  return new Error(`LLM planner model selection error: ${message}`);
}

/**
 * Resolve the optional `--planner-model` override at the CLI boundary. When
 * the flag is omitted the selected provider's default planner model is used
 * (undefined is returned); when supplied the value is trimmed and must be
 * non-empty. Commander parses both `--planner-model <model-id>` and
 * `--planner-model=<model-id>` before this runs, so this resolver only
 * validates the captured value and never re-reads process.argv.
 */
export function resolvePlannerModelOverride(explicitModel?: string): string | undefined {
  if (explicitModel === undefined) return undefined;
  const trimmed = explicitModel.trim();
  if (trimmed === "") {
    throw plannerModelError("--planner-model requires a non-empty model ID.");
  }
  return trimmed;
}

/** The provider/model pair selected for the planner runtime. */
export interface PlannerModelProviderSelection {
  readonly provider: ProviderId;
  readonly model: string;
}

/**
 * Resolve which provider should serve an explicit `--planner-model` value.
 *
 * The currently selected (default) provider wins when its catalog includes the
 * requested model ID. Otherwise every built-in provider is searched in a
 * stable, sorted order and the first provider whose catalog includes the model
 * is selected, so duplicate model IDs resolve deterministically. When no
 * provider supports the model, the returned error lists every supported
 * planner model instead of silently falling back to the default model.
 *
 * Returns `undefined` when no explicit planner model was supplied so callers
 * can preserve the selected provider's default planner behavior.
 */
export function resolvePlannerModelProvider(
  plannerModel: string | undefined,
  defaultProvider: ProviderId,
): PlannerModelProviderSelection | undefined {
  if (plannerModel === undefined) return undefined;

  const requestedModel = plannerModel.trim();
  if (requestedModel === "") {
    throw plannerModelError("--planner-model requires a non-empty model ID.");
  }

  const currentProvider = normalizeProviderId(defaultProvider);
  const providers = supportedProviders();

  // Prefer the currently selected provider so an override that is already in
  // the default provider's catalog never changes providers unnecessarily.
  if (providers.includes(currentProvider) && providerSupportsModel(currentProvider, requestedModel)) {
    return Object.freeze({ provider: currentProvider, model: requestedModel });
  }

  // Deterministic fallback: the sorted provider order guarantees the same
  // provider wins every time when several providers advertise one model ID.
  for (const provider of providers) {
    if (providerSupportsModel(provider, requestedModel)) {
      return Object.freeze({ provider, model: requestedModel });
    }
  }

  throw plannerModelError(
    `No provider supports planner model '${requestedModel}'. Supported planner models: ${supportedPlannerModelsSummary()}.`,
  );
}

function supportedPlannerModelsSummary(): string {
  return supportedProviders()
    .map((provider) => `${provider}: ${supportedModelsForProvider(provider).join(", ")}`)
    .join("; ");
}
