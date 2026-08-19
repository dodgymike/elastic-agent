/**
 * Composite (concatenation) MemoryModule for the elastic-agent runtime.
 *
 * A `CompositeMemoryModule` wraps two `MemoryModule` instances — a `primary`
 * and a `secondary` — and satisfies the transport-agnostic `MemoryModule`
 * contract from `memory/types.ts` by forwarding every operation to both:
 *
 *  - `remember(input)` records the completed plan step on BOTH modules so each
 *    backend keeps an up-to-date history (e.g. the durable persistent store and
 *    the ephemeral in-memory store).
 *  - `getContext(request)` retrieves the summarized context from BOTH modules
 *    and concatenates them into a single LLM-ready text block, primary context
 *    first then secondary context, each under its own separator header. This is
 *    the "concatenation mode" that lets an agent surface durable long-term
 *    memory alongside volatile short-term memory in one prompt.
 *  - `finalize(sessionId)` is an optional end-of-plan passthrough. The base
 *    `MemoryModule` interface does not declare it, but `PersistentMemoryModule`
 *    (and other durable modules) expose it so the plan loop can persist the
 *    session summary at end of plan. When the primary exposes a `finalize`, the
 *    composite forwards the call so end-of-plan persistence still happens even
 *    though the composite itself is not a `PersistentMemoryModule`.
 *
 * Design goals (mirroring `memory/inMemory.ts` and `memory/persistent.ts`):
 *  - Transport-agnostic: no SDK objects, credentials, or storage backends.
 *  - Swappable via dependency injection: the two wrapped instances are injected
 *    through the factory, so any backend pairing can be composed.
 *  - Chainable: a composite may itself be wrapped or composed further, so a
 *    chain of stores can be built without changing the agent's call sites.
 *  - Fail-safe: a failure in one wrapped module is absorbed and surfaced via
 *    `lastFailure`; it is never propagated to abort the plan loop. On
 *    getContext(), if one module fails the other's context is still returned.
 *
 * Ordering: primary context is emitted before secondary context, each separated
 * by a named marker so the LLM prompt can distinguish the two sources. The
 * separator headers are configurable via options and default to a stable
 * human/LLM-readable form.
 */

import type {
  ContextRequest,
  MemoryContext,
  MemoryContextResult,
  MemoryModule,
  RememberInput,
} from "./types.js";

/**
 * The optional end-of-plan lifecycle exposed by durable backends (e.g.
 * `PersistentMemoryModule`). Kept local to this module so the composite can
 * forward to a durable primary without importing the concrete class.
 */
export interface FinalizableMemoryModule extends MemoryModule {
  /** Persist/summarise the end-of-plan memory for `sessionId`. */
  finalize(sessionId: string): Promise<unknown>;
}

/** How a composite getContext() failure is reported to the caller. */
export interface CompositeFailureReport {
  /** True when the primary module's getContext()/remember() threw. */
  primaryFailed: boolean;
  /** True when the secondary module's getContext()/remember() threw. */
  secondaryFailed: boolean;
  /** Non-empty strings describe the first primary/secondary error. */
  errorMessages: string[];
}

/**
 * Header/label used to bracket each wrapped module's context block in the
 * concatenated getContext() output.
 */
export interface CompositeContextHeaders {
  /** Marker line above the primary module's context (default "primary memory"). */
  readonly primary?: string;
  /** Marker line above the secondary module's context (default "secondary memory"). */
  readonly secondary?: string;
}

/**
 * Factory options accepted by createCompositeMemoryModule.
 *
 * `primary` and `secondary` are the two wrapped MemoryModules. `headers`
 * customises the separator markers; additional backend-specific options are
 * accepted via `MemoryModuleFactoryOptions`-style extras.
 */
export interface CompositeMemoryOptions {
  /** The first MemoryModule whose context/remember wins the ordering. */
  readonly primary: MemoryModule;
  /** The second MemoryModule whose context is appended after the primary. */
  readonly secondary: MemoryModule;
  /** Optional separator markers for the concatenated context blocks. */
  readonly headers?: CompositeContextHeaders;
  /** Optional delegate MemoryModule to forward remember/getContext calls to. */
  readonly delegate?: MemoryModule;
}

/**
 * Composite MemoryModule that delegates every operation to a primary and a
 * secondary MemoryModule and concatenates their summarized context.
 *
 * This implements the "concatenation mode": both stores are always written on
 * remember(), and both contribute distinct, labeled blocks to getContext().
 */
export class CompositeMemoryModule implements MemoryModule {
  private readonly primary: MemoryModule;
  private readonly secondary: MemoryModule;
  private readonly delegate?: MemoryModule;
  private readonly labels: { primary: string; secondary: string };

  /** The most recent non-fatal failure reported by this module, if any. */
  lastFailure: CompositeFailureReport | null = null;

  constructor(options: CompositeMemoryOptions) {
    if (!options.primary) {
      throw new Error("CompositeMemoryModule requires a primary MemoryModule");
    }
    if (!options.secondary) {
      throw new Error("CompositeMemoryModule requires a secondary MemoryModule");
    }
    this.primary = options.primary;
    this.secondary = options.secondary;
    this.delegate = options.delegate;
    this.labels = {
      primary: options.headers?.primary ?? "primary memory",
      secondary: options.headers?.secondary ?? "secondary memory",
    };
  }

  /**
   * Record one completed plan step on both wrapped modules.
   *
   * Failures in either module are absorbed into `lastFailure` and reported via
   * the returned error list; they never reject, so the plan loop can continue
   * safely. The primary is written first, then the secondary.
   */
  async remember(input: RememberInput): Promise<void> {
    const report: CompositeFailureReport = { primaryFailed: false, secondaryFailed: false, errorMessages: [] };

    try {
      await this.primary.remember(input);
    } catch (error) {
      report.primaryFailed = true;
      report.errorMessages = [...report.errorMessages, summarizeError(error)];
    }

    try {
      await this.secondary.remember(input);
    } catch (error) {
      report.secondaryFailed = true;
      report.errorMessages = [...report.errorMessages, summarizeError(error)];
    }

    if (this.delegate) {
      try {
        await this.delegate.remember(input);
      } catch (error) {
        report.errorMessages = [...report.errorMessages, summarizeError(error)];
      }
    }

    this.lastFailure = report.primaryFailed || report.secondaryFailed ? report : null;
  }

  /**
   * Retrieve the summarized context from both wrapped modules and concatenate
   * them, primary first then secondary, each under a named separator header.
   *
   * Fail-safe: if one module's getContext() throws, the other's context is
   * still returned (the failure is recorded on `lastFailure`). Empty blocks
   * are omitted so a store with no memory does not pollute the summary.
   */
  async getContext(request: ContextRequest): Promise<MemoryContextResult> {
    const primary = await this.safeGetContext("primary", this.primary, request);
    const secondary = await this.safeGetContext("secondary", this.secondary, request);

    const blocks = [primary, secondary].filter(
      (result): result is MemoryContextResult => result !== null,
    );
    const matched: MemoryContext[] = [];
    for (const block of blocks) {
      for (const context of block.matchedContexts) {
        if (!matched.includes(context)) matched.push(context);
      }
    }

    const parts: string[] = [];
    const labelFor = (block: MemoryContextResult, label: string): void => {
      const text = block.text.trim();
      if (text.length === 0) return;
      parts.push(`--- ${label} ---\n${text}`);
    };
    if (primary) labelFor(primary, this.labels.primary);
    if (secondary) labelFor(secondary, this.labels.secondary);

    let text = parts.join("\n\n");
    if (request.maxChars !== undefined && text.length > request.maxChars) {
      text = `${text.slice(0, request.maxChars)}…`;
    }

    const hasMemory = blocks.some((block) => block.hasMemory || block.text.length > 0);
    return { text, matchedContexts: matched, hasMemory };
  }

  /**
   * Optional end-of-plan passthrough.
   *
   * The base `MemoryModule` interface does not declare finalize(); this method
   * exists so a durable primary (e.g. `PersistentMemoryModule`) can still be
   * flushed when the composite is used in concatenation mode. When the primary
   * exposes a finalize, it is invoked and its result returned; otherwise this
   * returns undefined. Failures are absorbed and recorded on `lastFailure`.
   */
  async finalize(sessionId: string): Promise<unknown> {
    const finalizable = this.primary as Partial<FinalizableMemoryModule>;
    if (typeof finalizable.finalize !== "function") {
      return undefined;
    }
    try {
      return await finalizable.finalize(sessionId);
    } catch (error) {
      this.lastFailure = {
        primaryFailed: false,
        secondaryFailed: false,
        errorMessages: [summarizeError(error)],
      };
      return undefined;
    }
  }

  private async safeGetContext(
    which: "primary" | "secondary",
    module: MemoryModule,
    request: ContextRequest,
  ): Promise<MemoryContextResult | null> {
    try {
      return await module.getContext(request);
    } catch (error) {
      const failed =
        which === "primary"
          ? { primaryFailed: true, secondaryFailed: false }
          : { primaryFailed: false, secondaryFailed: true };
      this.lastFailure = {
        ...failed,
        errorMessages: [...(this.lastFailure?.errorMessages ?? []), summarizeError(error)],
      };
      return null;
    }
  }
}

/**
 * Dependency-injection factory for CompositeMemoryModule, satisfying the
 * `MemoryModuleFactory` reference so the runtime can compose two stores.
 */
export const createCompositeMemoryModule = (
  options: CompositeMemoryOptions,
): MemoryModule => {
  return new CompositeMemoryModule(options);
};

/** Convenience alias matching the documented "concatenation mode" naming. */
export const createConcatenationMemoryModule = createCompositeMemoryModule;

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
