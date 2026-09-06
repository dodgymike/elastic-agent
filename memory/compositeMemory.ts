/**
 * Composite MemoryModule for the elastic-agent runtime (MI-11 semantics).
 *
 * A `CompositeMemoryModule` composes one authoritative owner with optional
 * non-durable projection/cache layers and satisfies the transport-agnostic
 * `MemoryModule` contract from `memory/types.ts`.
 *
 * Design rules changed by MI-11:
 *  - `remember(input)` records the step on the authoritative `primary` owner
 *    exactly once. Projection layers are updated only when they explicitly
 *    advertise `durable: false`, so the same evidence is never appended as a
 *    durable write twice.
 *  - `getContext(request)` retrieves the owner first and merges projection
 *    blocks while dropping exact duplicate text, so each logical fact appears
 *    once. A projection whose text duplicates the owner contributes nothing.
 *  - Lifecycle operations (`finalize`, `initialize`, `flush`, `close`, and the
 *    compaction read/set surface) route to the authoritative owner exactly
 *    once; projections are derived and are never flushed, closed, or
 *    compacted.
 *  - Fail-safe: failures in a projection are absorbed and surfaced via
 *    `lastFailure`; they never abort the plan loop.
 */

import {
  capabilitiesOf,
  describeCapabilityGap,
  hasExplicitCapabilities,
} from "./backend-capabilities.js";
import type {
  MemoryCapabilitiesV2,
  MemoryCloseResultV2,
  MemoryFlushResultV2,
  MemoryForgetResultV2,
  MemoryForgetSelectionV2,
  MemoryInitResultV2,
  MemoryModuleV2,
  MemoryScopeV2,
} from "./contracts-v2.js";
import type { CompactionSummaryStore } from "./memoryCompaction.js";
import type {
  MemoryExportDocumentV1,
  MemoryExportOptions,
  MemoryExportResult,
  MemoryRestoreResult,
  RetentionApplyResult,
  RetentionPolicy,
  RetentionPreview,
} from "./retention.js";
import type {
  ContextRequest,
  MemoryContext,
  MemoryContextResult,
  MemoryModule,
  RememberInput,
} from "./types.js";

/**
 * The optional end-of-plan lifecycle exposed by durable backends (e.g.
 * `PersistentMemoryModule` or `PersistentV2MemoryModule`). Kept local to this
 * module so the composite can forward to a durable owner without importing the
 * concrete class.
 */
export interface FinalizableMemoryModule extends MemoryModule {
  /** Persist/flush the end-of-plan memory for `sessionId`. */
  finalize(sessionId: string): Promise<unknown>;
}

/** How a composite remember()/getContext() failure is reported to the caller. */
export interface CompositeFailureReport {
  /** True when the authoritative owner's remember()/getContext() threw. */
  primaryFailed: boolean;
  /** True when any projection's remember()/getContext() threw. */
  secondaryFailed: boolean;
  /** Non-empty strings describe the first failure(s). */
  errorMessages: string[];
}

/**
 * Header/label used to bracket the owner and the first projection block in the
 * merged getContext() output.
 */
export interface CompositeContextHeaders {
  /** Marker line above the owner's context (default "primary memory"). */
  readonly primary?: string;
  /** Marker line above the first projection's context (default "secondary memory"). */
  readonly secondary?: string;
}

/**
 * Factory options accepted by createCompositeMemoryModule.
 *
 * `primary` is the authoritative owner. `secondary`, `projections`, and
 * `delegate` are optional projection/cache layers; they may accelerate
 * retrieval but are never authoritative and never receive a durable write.
 */
export interface CompositeMemoryOptions {
  /** The authoritative MemoryModule whose writes/context win. */
  readonly primary: MemoryModule;
  /** Optional first projection/cache layer. */
  readonly secondary?: MemoryModule;
  /** Optional additional projection/cache layers. */
  readonly projections?: readonly MemoryModule[];
  /** Optional separator markers for merged context blocks. */
  readonly headers?: CompositeContextHeaders;
  /** Optional legacy delegate, treated as an additional projection. */
  readonly delegate?: MemoryModule;
}

/**
 * Composite MemoryModule with one authoritative owner and optional projections.
 */
export class CompositeMemoryModule implements MemoryModule {
  private readonly owner: MemoryModule;
  private readonly projections: readonly MemoryModule[];
  private readonly labels: { primary: string; secondary: string };

  /** The most recent non-fatal failure reported by this module, if any. */
  lastFailure: CompositeFailureReport | null = null;

  constructor(options: CompositeMemoryOptions) {
    if (!options.primary) {
      throw new Error("CompositeMemoryModule requires an authoritative primary MemoryModule");
    }
    this.owner = options.primary;
    this.projections = [
      options.secondary,
      ...(options.projections ?? []),
      options.delegate,
    ].filter((module): module is MemoryModule => module !== undefined);
    this.labels = {
      primary: options.headers?.primary ?? "primary memory",
      secondary: options.headers?.secondary ?? "secondary memory",
    };
  }

  /** The composite advertises the authoritative owner's capabilities. */
  get capabilities(): MemoryCapabilitiesV2 {
    return capabilitiesOf(this.owner);
  }

  /**
   * Record one completed plan step on the authoritative owner exactly once,
   * then update non-durable projections (caches) without duplicating durable
   * writes. Projections that do not advertise capabilities are skipped.
   */
  async remember(input: RememberInput): Promise<void> {
    const report: CompositeFailureReport = {
      primaryFailed: false,
      secondaryFailed: false,
      errorMessages: [],
    };

    try {
      await this.owner.remember(input);
    } catch (error) {
      report.primaryFailed = true;
      report.errorMessages = [...report.errorMessages, summarizeError(error)];
    }

    for (const projection of this.projections) {
      // Only update projections that are explicitly known non-durable. This
      // prevents the same evidence from being appended to a second durable
      // store, while still letting a volatile cache accelerate retrieval.
      if (!hasExplicitCapabilities(projection) || capabilitiesOf(projection).durable) {
        continue;
      }
      try {
        await projection.remember(input);
      } catch (error) {
        report.secondaryFailed = true;
        report.errorMessages = [...report.errorMessages, summarizeError(error)];
      }
    }

    this.lastFailure = report.primaryFailed || report.secondaryFailed ? report : null;
  }

  /**
   * Retrieve merged context from the owner plus projections, dropping exact
   * duplicate text blocks so each logical fact appears once. Fail-safe: if a
   * projection's getContext() throws, the other blocks are still returned.
   */
  async getContext(request: ContextRequest): Promise<MemoryContextResult> {
    const owner = await this.safeGetContext(this.owner, request, "primary");
    const projectionResults: MemoryContextResult[] = [];
    for (const projection of this.projections) {
      const result = await this.safeGetContext(projection, request, "secondary");
      if (result) projectionResults.push(result);
    }

    const parts: string[] = [];
    const seenText = new Set<string>();
    const matched: MemoryContext[] = [];
    const seenContexts = new Set<MemoryContext>();

    const addBlock = (result: MemoryContextResult | null, label: string): void => {
      if (!result) return;
      const text = result.text.trim();
      if (text.length > 0 && !seenText.has(text)) {
        seenText.add(text);
        parts.push(`--- ${label} ---\n${text}`);
      }
      for (const context of result.matchedContexts) {
        if (!seenContexts.has(context)) {
          seenContexts.add(context);
          matched.push(context);
        }
      }
    };

    addBlock(owner, this.labels.primary);
    for (let index = 0; index < projectionResults.length; index += 1) {
      const label = index === 0 ? this.labels.secondary : `projection ${index + 1}`;
      addBlock(projectionResults[index], label);
    }

    let text = parts.join("\n\n");
    if (request.maxChars !== undefined && text.length > request.maxChars) {
      text = `${text.slice(0, request.maxChars)}…`;
    }

    const blocks = [owner, ...projectionResults].filter(
      (result): result is MemoryContextResult => result !== null,
    );
    const hasMemory = blocks.some((block) => block.hasMemory || block.text.length > 0);
    return { text, matchedContexts: matched, hasMemory };
  }

  /**
   * End-of-plan passthrough: forwards to the authoritative owner's finalize()
   * exactly once. Projections are derived and are never finalized. Returns
   * undefined when the owner is not finalizable.
   */
  async finalize(sessionId: string): Promise<unknown> {
    const finalizable = this.owner as Partial<FinalizableMemoryModule>;
    if (typeof finalizable.finalize !== "function") return undefined;
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

  /** v2 lifecycle routing: initialize the authoritative owner exactly once. */
  async initialize(scope: MemoryScopeV2): Promise<MemoryInitResultV2> {
    const owner = this.owner as Partial<Pick<MemoryModuleV2, "initialize">>;
    if (typeof owner.initialize === "function") return owner.initialize(scope);
    return { status: "ready", scope };
  }

  /** v2 lifecycle routing: flush the authoritative owner exactly once. */
  async flush(scope: MemoryScopeV2): Promise<MemoryFlushResultV2> {
    const owner = this.owner as Partial<Pick<MemoryModuleV2, "flush">>;
    if (typeof owner.flush === "function") return owner.flush(scope);
    return { status: "failure", reason: "composite owner is not durable; flush is unsupported" };
  }

  /** v2 lifecycle routing: close the authoritative owner exactly once. */
  async close(scope: MemoryScopeV2): Promise<MemoryCloseResultV2> {
    const owner = this.owner as Partial<Pick<MemoryModuleV2, "close">>;
    if (typeof owner.close === "function") return owner.close(scope);
    return { status: "closed" };
  }

  /** MI-13: route an exact forget selection to the authoritative owner. */
  async forget(selection: MemoryForgetSelectionV2): Promise<MemoryForgetResultV2> {
    if (!capabilitiesOf(this.owner).supportsForget) {
      return { status: "failure", reason: describeCapabilityGap(capabilitiesOf(this.owner), "forget") };
    }
    const owner = this.owner as Partial<{ forget(selection: MemoryForgetSelectionV2): Promise<MemoryForgetResultV2> }>;
    if (typeof owner.forget !== "function") {
      return { status: "failure", reason: "composite owner does not implement forget" };
    }
    try {
      return await owner.forget(selection);
    } catch (error) {
      return { status: "failure", reason: summarizeError(error) };
    }
  }

  /** MI-13: route safe export to the authoritative owner. */
  async exportScope(scope: MemoryScopeV2, options?: MemoryExportOptions): Promise<MemoryExportResult> {
    if (!capabilitiesOf(this.owner).supportsExport) {
      return { status: "failure", reason: describeCapabilityGap(capabilitiesOf(this.owner), "export") };
    }
    const owner = this.owner as Partial<{
      exportScope(scope: MemoryScopeV2, options?: MemoryExportOptions): Promise<MemoryExportResult>;
    }>;
    if (typeof owner.exportScope !== "function") {
      return { status: "failure", reason: "composite owner does not implement exportScope" };
    }
    try {
      return await owner.exportScope(scope, options);
    } catch (error) {
      return { status: "failure", reason: summarizeError(error) };
    }
  }

  /** MI-13: route explicit restore to the authoritative owner. */
  async restoreExport(input: MemoryExportDocumentV1 | string, targetScope?: MemoryScopeV2): Promise<MemoryRestoreResult> {
    const owner = this.owner as Partial<{
      restoreExport(input: MemoryExportDocumentV1 | string, targetScope?: MemoryScopeV2): Promise<MemoryRestoreResult>;
    }>;
    if (typeof owner.restoreExport !== "function") {
      return { status: "failure", reason: "composite owner does not implement restoreExport" };
    }
    try {
      return await owner.restoreExport(input, targetScope);
    } catch (error) {
      return { status: "failure", reason: summarizeError(error) };
    }
  }

  /** MI-13: route retention preview to the authoritative owner. */
  async previewRetention(policy: RetentionPolicy): Promise<RetentionPreview> {
    const owner = this.owner as Partial<{
      previewRetention(policy: RetentionPolicy): Promise<RetentionPreview>;
    }>;
    if (typeof owner.previewRetention !== "function") {
      return { status: "failure", reason: "composite owner does not implement previewRetention", policy, candidates: [], skippedProtected: 0 };
    }
    try {
      return await owner.previewRetention(policy);
    } catch (error) {
      return { status: "failure", reason: summarizeError(error), policy, candidates: [], skippedProtected: 0 };
    }
  }

  /** MI-13: route retention apply to the authoritative owner. */
  async applyRetention(preview: RetentionPreview): Promise<RetentionApplyResult> {
    const owner = this.owner as Partial<{
      applyRetention(preview: RetentionPreview): Promise<RetentionApplyResult>;
    }>;
    if (typeof owner.applyRetention !== "function") {
      return { status: "failure", applied: 0, failed: 1, errors: ["composite owner does not implement applyRetention"] };
    }
    try {
      return await owner.applyRetention(preview);
    } catch (error) {
      return { status: "failure", applied: 0, failed: 1, errors: [summarizeError(error)] };
    }
  }

  /** Compaction read surface routed to the authoritative owner. */
  getSummary(sessionId: string): string | undefined {
    return this.ownerSummaryStore()?.getSummary(sessionId);
  }

  /** Compaction write surface routed to the authoritative owner. */
  setSummary(sessionId: string, summary: string): void {
    this.ownerSummaryStore()?.setSummary(sessionId, summary);
  }

  private ownerSummaryStore(): CompactionSummaryStore | null {
    const owner = this.owner as Partial<CompactionSummaryStore> & {
      summaryForSession?: (id: string) => string | undefined;
      setSummaryForSession?: (id: string, summary: string) => void;
    };
    const get =
      typeof owner.getSummary === "function"
        ? owner.getSummary.bind(owner)
        : typeof owner.summaryForSession === "function"
          ? (id: string): string | undefined => owner.summaryForSession!(id)
          : undefined;
    const set =
      typeof owner.setSummary === "function"
        ? owner.setSummary.bind(owner)
        : typeof owner.setSummaryForSession === "function"
          ? (id: string, summary: string): void => owner.setSummaryForSession!(id, summary)
          : undefined;
    if (!get || !set) return null;
    return { getSummary: get, setSummary: set };
  }

  private async safeGetContext(
    module: MemoryModule,
    request: ContextRequest,
    which: "primary" | "secondary",
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
 * `MemoryModuleFactory` reference so the runtime can compose one owner with
 * optional projections.
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
