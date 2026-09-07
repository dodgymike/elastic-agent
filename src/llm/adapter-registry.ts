import {
  type LlmAdapter,
  type ProviderId,
  LlmAdapterError,
} from "./adapter-contract.js";

/**
 * Provider options are deliberately opaque to the registry. Each provider
 * factory owns validation of its own non-secret settings and credentials, so
 * this boundary remains independent of provider SDKs.
 */
export type AdapterOptions = Readonly<Record<string, unknown>>;

/** The environment shape needed for deterministic provider selection. */
export type AdapterEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Selects one registered provider. The explicit provider takes precedence over
 * `LLM_PROVIDER` when resolveAdapterConfiguration is used. Provider-specific
 * options are never read implicitly from the environment by this registry.
 */
export interface AdapterConfiguration {
  readonly provider: ProviderId;
  readonly options?: AdapterOptions;
}

export interface AdapterConfigurationInput {
  readonly provider?: ProviderId;
  readonly options?: AdapterOptions;
}

/** A provider boundary that constructs an adapter without exposing its SDK. */
export interface LlmAdapterFactory {
  readonly provider: ProviderId;
  create(options: AdapterOptions): LlmAdapter | Promise<LlmAdapter>;
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const REGISTRY_PROVIDER = "registry";

function configurationError(message: string): LlmAdapterError {
  return new LlmAdapterError(REGISTRY_PROVIDER, "configuration", message);
}

/** Normalize provider names once, so registrations and selections compare reliably. */
export function normalizeProviderId(provider: ProviderId): ProviderId {
  if (typeof provider !== "string") {
    throw configurationError("LLM provider must be a string.");
  }
  const normalized = provider.trim().toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(normalized)) {
    throw configurationError("LLM provider must use lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return normalized;
}

function isOptions(value: unknown): value is AdapterOptions {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyOptions(options: AdapterOptions | undefined): AdapterOptions {
  if (!isOptions(options)) {
    throw configurationError("LLM adapter options must be a plain object when provided.");
  }
  return Object.freeze({ ...(options ?? {}) });
}

/**
 * Resolve provider selection using the established explicit-option-over-
 * environment precedence. This intentionally resolves only `LLM_PROVIDER`;
 * concrete adapters own their provider-specific environment variables.
 */
export function resolveAdapterConfiguration(
  input: AdapterConfigurationInput = {},
  environment: AdapterEnvironment = {},
): AdapterConfiguration {
  const configuredProvider = input.provider ?? environment.LLM_PROVIDER;
  if (configuredProvider === undefined || configuredProvider.trim() === "") {
    throw configurationError("An LLM provider is required. Set an explicit provider or LLM_PROVIDER.");
  }
  return Object.freeze({
    provider: normalizeProviderId(configuredProvider),
    options: copyOptions(input.options),
  });
}

/**
 * Configurable registry for lazy, provider-neutral adapter construction.
 *
 * Register concrete factories during application composition. The registry does
 * not import provider adapters, SDKs, or credentials, avoiding an accidental
 * dependency on providers that are not selected at runtime.
 */
export class LlmAdapterRegistry {
  private readonly factories = new Map<ProviderId, LlmAdapterFactory>();

  constructor(factories: readonly LlmAdapterFactory[] = []) {
    for (const factory of factories) this.register(factory);
  }

  register(factory: LlmAdapterFactory): this {
    if (!factory || typeof factory !== "object" || typeof factory.create !== "function") {
      throw configurationError("An LLM adapter factory must provide a create function.");
    }
    const provider = normalizeProviderId(factory.provider);
    if (this.factories.has(provider)) {
      throw configurationError(`An LLM adapter factory is already registered for '${provider}'.`);
    }
    this.factories.set(provider, factory);
    return this;
  }

  has(provider: ProviderId): boolean {
    return this.factories.has(normalizeProviderId(provider));
  }

  providers(): readonly ProviderId[] {
    return Object.freeze([...this.factories.keys()].sort());
  }

  async create(configuration: AdapterConfiguration): Promise<LlmAdapter> {
    if (!configuration || typeof configuration !== "object") {
      throw configurationError("An LLM adapter configuration is required.");
    }
    const provider = normalizeProviderId(configuration.provider);
    const factory = this.factories.get(provider);
    if (!factory) {
      const available = this.providers();
      const suffix = available.length === 0 ? " No providers are registered." : ` Registered providers: ${available.join(", ")}.`;
      throw configurationError(`No LLM adapter factory is registered for '${provider}'.${suffix}`);
    }

    const adapter = await factory.create(copyOptions(configuration.options));
    if (!adapter || typeof adapter !== "object" || typeof adapter.generate !== "function") {
      throw configurationError(`The '${provider}' LLM adapter factory returned an invalid adapter.`);
    }
    if (normalizeProviderId(adapter.provider) !== provider) {
      throw configurationError(`The '${provider}' LLM adapter factory returned an adapter for a different provider.`);
    }
    return adapter;
  }

  createFromEnvironment(
    input: AdapterConfigurationInput = {},
    environment: AdapterEnvironment = {},
  ): Promise<LlmAdapter> {
    return this.create(resolveAdapterConfiguration(input, environment));
  }
}
