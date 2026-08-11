import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LlmAdapter } from "./adapter-contract.js";
import { LlmAdapterRegistry, type AdapterConfigurationInput, type AdapterEnvironment } from "./adapter-registry.js";
import { bedrockClaudeAdapterFactory } from "./bedrock-claude-adapter.js";
import { deepSeekV4AdapterFactory } from "./deepseek-v4-adapter.js";
import { openAiAdapterFactory } from "./openai-adapter.js";

/** Runtime settings used to load non-secret provider selection and compose adapters. */
export interface RuntimeLlmOptions {
  /** Environment file to load before resolving LLM_PROVIDER. Set false to disable file loading. */
  readonly envFile?: string | false;
  /** Primarily supports embedding and tests; production uses process.env. */
  readonly environment?: AdapterEnvironment;
  /** Provider selection supplied by the CLI boundary, ahead of LLM_PROVIDER. */
  readonly configuration?: AdapterConfigurationInput;
}

/**
 * Load an optional local runtime environment file without replacing values
 * already supplied by the process environment or deployment secret manager.
 * Node's loader parses standard dotenv syntax and does not expose values here.
 */
export function loadRuntimeEnvironment(envFile: string | false = ".env"): AdapterEnvironment {
  if (envFile !== false) {
    const filename = resolve(envFile);
    if (existsSync(filename)) process.loadEnvFile(filename);
  }
  return Object.freeze({ ...process.env });
}

/**
 * Register the provider factories supported by this deployment. Provider
 * selection determines which factory runs, so only the selected factory reads
 * its provider-specific runtime configuration: OPENAI_API_KEY, AWS_REGION (or
 * AWS_DEFAULT_REGION) with the normal AWS credential chain, or DEEPSEEK_API_KEY.
 */
export function createRuntimeLlmRegistry(): LlmAdapterRegistry {
  return new LlmAdapterRegistry([
    openAiAdapterFactory,
    bedrockClaudeAdapterFactory,
    deepSeekV4AdapterFactory,
  ]);
}

/**
 * Construct the selected runtime adapter after loading the runtime environment.
 * CLI configuration takes precedence over LLM_PROVIDER. The selected factory,
 * not the registry, resolves only its documented provider-specific environment
 * variables and never receives credentials from this composition boundary.
 */
export async function createRuntimeLlmAdapter(options: RuntimeLlmOptions = {}): Promise<LlmAdapter> {
  const environment = options.environment ?? loadRuntimeEnvironment(options.envFile);
  return createRuntimeLlmRegistry().createFromEnvironment(options.configuration, environment);
}
