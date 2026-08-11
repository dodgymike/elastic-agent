import {
  normalizeProviderId,
  type AdapterConfigurationInput,
  type AdapterEnvironment,
} from "./adapter-registry.js";

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
