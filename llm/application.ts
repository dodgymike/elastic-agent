import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LlmAdapter } from "./adapter-contract.js";
import { LlmAdapterRegistry, type AdapterEnvironment } from "./adapter-registry.js";
import { deepSeekV4AdapterFactory } from "./deepseek-v4-adapter.js";

/** Runtime settings used to load non-secret provider selection and compose adapters. */
export interface RuntimeLlmOptions {
  /** Environment file to load before resolving LLM_PROVIDER. Set false to disable file loading. */
  readonly envFile?: string | false;
  /** Primarily supports embedding and tests; production uses process.env. */
  readonly environment?: AdapterEnvironment;
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

/** Register the adapters supported by this deployment at the composition boundary. */
export function createRuntimeLlmRegistry(): LlmAdapterRegistry {
  return new LlmAdapterRegistry([deepSeekV4AdapterFactory]);
}

/**
 * Construct the configured runtime adapter after loading the runtime environment.
 * LLM_PROVIDER must select one of the explicitly registered deployment adapters.
 */
export async function createRuntimeLlmAdapter(options: RuntimeLlmOptions = {}): Promise<LlmAdapter> {
  const environment = options.environment ?? loadRuntimeEnvironment(options.envFile);
  return createRuntimeLlmRegistry().createFromEnvironment({}, environment);
}
