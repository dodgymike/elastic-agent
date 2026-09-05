import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LlmAdapter } from "./adapter-contract.js";
import { LlmAdapterRegistry, resolveAdapterConfiguration, type AdapterConfigurationInput, type AdapterEnvironment } from "./adapter-registry.js";
import { bedrockClaudeAdapterFactory } from "./bedrock-claude-adapter.js";
import { deepSeekV4AdapterFactory } from "./deepseek-v4-adapter.js";
import { resolveModelConfiguration, type ModelConfiguration } from "./model-defaults.js";
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
 * Error raised when the optional runtime environment file exists but cannot be
 * loaded: either the Node.js runtime lacks `process.loadEnvFile`, or the file's
 * dotenv syntax is malformed/unreadable. Both fail closed so a broken or
 * half-read environment cannot silently produce a differently-configured run.
 */
export class RuntimeEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEnvironmentError";
  }
}

/**
 * Load an optional local runtime environment file without replacing values
 * already supplied by the process environment or deployment secret manager.
 * Node's loader parses standard dotenv syntax and does not expose values here.
 *
 * Behavior is deliberate:
 * - `envFile === false` skips file loading entirely (caller-supplied environment).
 * - A missing file is treated as absent: only `process.env` is used.
 * - A present file on an unsupported runtime, or a malformed/unreadable file,
 *   throws `RuntimeEnvironmentError` with an actionable diagnostic.
 */
export function loadRuntimeEnvironment(envFile: string | false = ".env"): AdapterEnvironment {
  if (envFile !== false) {
    const filename = resolve(envFile);
    if (existsSync(filename)) {
      if (typeof process.loadEnvFile !== "function") {
        throw new RuntimeEnvironmentError(
          `Cannot load environment file "${filename}": process.loadEnvFile is unavailable on Node.js ${process.version}. ` +
            'This project requires Node.js >= 22.9.0 (see README.md "Requirements").',
        );
      }
      try {
        process.loadEnvFile(filename);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new RuntimeEnvironmentError(
          `Failed to parse environment file "${filename}": ${detail}. Fix or remove the file; a missing environment file is treated as absent and only the process environment is used.`,
        );
      }
    }
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
 * Resolve the selected provider's default model without constructing an
 * adapter. Each built-in provider has an explicit default and may be
 * overridden only through its own model environment variable.
 */
export function resolveRuntimeLlmModel(options: RuntimeLlmOptions = {}): ModelConfiguration {
  const environment = options.environment ?? loadRuntimeEnvironment(options.envFile);
  const configuration = resolveAdapterConfiguration(options.configuration, environment);
  return resolveModelConfiguration(configuration.provider, environment);
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
