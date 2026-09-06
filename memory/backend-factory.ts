/**
 * Unified memory backend composition factory with validated selection (MI-11).
 *
 * The runtime previously selected backends with an inline `if/else` chain and
 * silently fell back to persistent memory for any unrecognized
 * `ELAGENT_MEMORY_TYPE`. This module replaces that with one composition entry
 * point that:
 *
 *  - validates the selection against a closed set and rejects unrecognized
 *    values with an actionable `MemoryBackendSelectionError`,
 *  - preserves every existing selection (`persistent`, `in-memory`, `graph`,
 *    `concat`/`both`) while adding `persistent-v2` as the explicit opt-in,
 *  - returns a `MemoryBackendHandle` that carries the v1 prompt-facing module,
 *    its advertised capabilities, the resolved compaction owner, and lifecycle
 *    routing (`initialize`/`flush`/`close`/`finalize`) so runtime integration
 *    never branches on concrete classes.
 *
 * Lifecycle operations route to the authoritative owner exactly once. For
 * legacy v1 modules without a v2 lifecycle, `initialize`/`close` succeed as
 * explicit no-ops and `flush` fails with an actionable reason rather than
 * silently claiming durability.
 */

import { capabilitiesOf } from "./backend-capabilities.js";
import { emptyHealthSnapshot, type MemoryHealthSnapshot } from "./health-metrics.js";
import { createCompositeMemoryModule } from "./compositeMemory.js";
import {
  validateScope,
  type MemoryCapabilitiesV2,
  type MemoryCloseResultV2,
  type MemoryFlushResultV2,
  type MemoryInitResultV2,
  type MemoryModuleV2,
  type MemoryScopeV2,
} from "./contracts-v2.js";
import { createGraphMemoryModule } from "./graph-memory.js";
import { createInMemoryMemoryModule, type MemorySummarizer } from "./inMemory.js";
import type { CompactionSummaryStore } from "./memoryCompaction.js";
import { createPersistentMemoryModule } from "./persistent.js";
import { createPersistentV2MemoryModule } from "./persistent-v2.js";
import type { MemoryModule } from "./types.js";

/** The closed set of advertised runtime backend selections. */
export const SUPPORTED_MEMORY_TYPES = [
  "persistent",
  "in-memory",
  "graph",
  "concat",
  "both",
  "persistent-v2",
] as const;

/** A validated runtime backend selection. */
export type MemoryTypeSelection = (typeof SUPPORTED_MEMORY_TYPES)[number];

/** Raised when an unrecognized backend selection is requested. */
export class MemoryBackendSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryBackendSelectionError";
  }
}

/** Options accepted by createMemoryBackend. */
export interface MemoryBackendFactoryOptions {
  readonly semanticExpander?: import("./semantic-query.js").SemanticQueryExpander;
  /** Raw `ELAGENT_MEMORY_TYPE` value; unset/empty selects the default. */
  readonly type?: string;
  /** Legacy persistent output directory. */
  readonly outputDir?: string;
  /** Legacy persistent output file path. */
  readonly filePath?: string;
  /** Dedicated SQLite event-store path for `persistent-v2`. */
  readonly eventStorePath?: string;
  /** Workspace path used to derive the `persistent-v2` workspace id. */
  readonly workspacePath?: string;
  /** Optional injected v1 summarizer for summary-based backends. */
  readonly summarizer?: MemorySummarizer;
  /** Optional delegate/projection module. */
  readonly delegate?: MemoryModule;
}

/**
 * A selected backend plus its capability and lifecycle routing surface.
 *
 * `module` is the v1 `MemoryModule` the prompt loop calls. Lifecycle methods
 * route to the authoritative owner once, even through wrappers, so callers do
 * not need concrete class or `instanceof` checks.
 */
export interface MemoryBackendHandle {
  /** The validated selection this handle was built for. */
  readonly kind: MemoryTypeSelection;
  /** The v1 prompt-facing memory module. */
  readonly module: MemoryModule;
  /** Advertised capabilities of the authoritative backend. */
  readonly capabilities: MemoryCapabilitiesV2;
  /** Resolved summary owner for compaction, or null when unsupported. */
  readonly compactionStore: CompactionSummaryStore | null;
  /** Prepare a scope for access. */
  initialize(scope: MemoryScopeV2): Promise<MemoryInitResultV2>;
  /** Flush durable state for a scope; unsupported backends fail explicitly. */
  flush(scope: MemoryScopeV2): Promise<MemoryFlushResultV2>;
  /** Close a scope and release resources; legacy no-ops report `closed`. */
  close(scope: MemoryScopeV2): Promise<MemoryCloseResultV2>;
  /** End-of-plan durable hook; resolves undefined for non-durable backends. */
  finalize(sessionId: string): Promise<unknown>;
  /** MI-14: metadata-only health snapshot for tests/monitoring and the CLI. */
  healthSnapshot(): MemoryHealthSnapshot;
}

/**
 * Validate a raw backend selection. Unset/empty selects the persistent default;
 * any other unrecognized value throws an actionable error.
 */
export function resolveMemoryTypeSelection(raw: string | undefined): MemoryTypeSelection {
  const value = (raw ?? "").trim();
  if (value === "") return "persistent";
  if ((SUPPORTED_MEMORY_TYPES as readonly string[]).includes(value)) {
    return value as MemoryTypeSelection;
  }
  throw new MemoryBackendSelectionError(
    `unrecognized memory backend type ${JSON.stringify(raw)}; expected one of: ${SUPPORTED_MEMORY_TYPES.join(", ")} (or unset for the default "persistent")`,
  );
}

/**
 * Compose one validated backend and return its handle. Preserves the previous
 * selection behavior for all legacy values and adds `persistent-v2` as opt-in.
 */
export function createMemoryBackend(options: MemoryBackendFactoryOptions = {}): MemoryBackendHandle {
  const kind = resolveMemoryTypeSelection(options.type);
  let module: MemoryModule;
  switch (kind) {
    case "persistent":
      module = createPersistentMemoryModule({
        outputDir: options.outputDir,
        filePath: options.filePath,
        summarizer: options.summarizer,
        delegate: options.delegate,
      });
      break;
    case "in-memory":
      module = createInMemoryMemoryModule({
        summarizer: options.summarizer,
        delegate: options.delegate,
      });
      break;
    case "graph":
      module = createGraphMemoryModule({ delegate: options.delegate });
      break;
    case "concat":
    case "both":
      // One authoritative owner (persistent) + one non-durable projection
      // (in-memory). The composite writes the owner once and merges retrieval
      // without repeating identical context blocks.
      module = createCompositeMemoryModule({
        primary: createPersistentMemoryModule({
          outputDir: options.outputDir,
          filePath: options.filePath,
        }),
        secondary: createInMemoryMemoryModule({}),
        delegate: options.delegate,
        headers: { primary: "persistent memory", secondary: "in-memory memory" },
      });
      break;
    case "persistent-v2":
      module = createPersistentV2MemoryModule({
        eventStorePath: options.eventStorePath,
        semanticExpander: options.semanticExpander,
        workspacePath: options.workspacePath,
        delegate: options.delegate,
      });
      break;
  }
  return buildHandle(kind, module);
}

/**
 * Resolve the summary owner a compactor should target. Wrappers (for example
 * the composite) expose the same narrow read/set surface and route it to their
 * authoritative owner, so this remains a capability check rather than a
 * concrete class check.
 */
export function resolveCompactionStore(
  module: MemoryModule | null | undefined,
): CompactionSummaryStore | null {
  if (!module) return null;
  const store = module as Partial<CompactionSummaryStore> & {
    summaryForSession?: (id: string) => string | undefined;
    setSummaryForSession?: (id: string, summary: string) => void;
  };
  const get =
    typeof store.getSummary === "function"
      ? store.getSummary.bind(store)
      : typeof store.summaryForSession === "function"
        ? (id: string): string | undefined => store.summaryForSession!(id)
        : undefined;
  const set =
    typeof store.setSummary === "function"
      ? store.setSummary.bind(store)
      : typeof store.setSummaryForSession === "function"
        ? (id: string, summary: string): void => store.setSummaryForSession!(id, summary)
        : undefined;
  if (!get || !set) return null;
  return { getSummary: get, setSummary: set };
}

function buildHandle(kind: MemoryTypeSelection, module: MemoryModule): MemoryBackendHandle {
  return {
    kind,
    module,
    capabilities: capabilitiesOf(module),
    compactionStore: resolveCompactionStore(module),
    initialize: (scope) => routeInitialize(module, scope),
    flush: (scope) => routeFlush(module, kind, scope),
    close: (scope) => routeClose(module, scope),
    finalize: (sessionId) => routeFinalize(module, sessionId),
    healthSnapshot: () => routeHealth(module, kind),
  };
}

async function routeInitialize(
  module: MemoryModule,
  scope: MemoryScopeV2,
): Promise<MemoryInitResultV2> {
  const v2 = module as Partial<Pick<MemoryModuleV2, "initialize">>;
  if (typeof v2.initialize === "function") return v2.initialize(scope);
  try {
    validateScope(scope);
  } catch (error) {
    return { status: "failure", reason: describeError(error) };
  }
  return { status: "ready", scope };
}

async function routeFlush(
  module: MemoryModule,
  kind: MemoryTypeSelection,
  scope: MemoryScopeV2,
): Promise<MemoryFlushResultV2> {
  const v2 = module as Partial<Pick<MemoryModuleV2, "flush">>;
  if (typeof v2.flush === "function") return v2.flush(scope);
  return { status: "failure", reason: `${kind} backend is not durable; flush is unsupported` };
}

async function routeClose(
  module: MemoryModule,
  scope: MemoryScopeV2,
): Promise<MemoryCloseResultV2> {
  const v2 = module as Partial<Pick<MemoryModuleV2, "close">>;
  if (typeof v2.close === "function") return v2.close(scope);
  return { status: "closed" };
}

function routeHealth(module: MemoryModule, kind: MemoryTypeSelection): MemoryHealthSnapshot {
  const provider = module as Partial<{ healthSnapshot(): MemoryHealthSnapshot }>;
  if (typeof provider.healthSnapshot === "function") return provider.healthSnapshot();
  return emptyHealthSnapshot({
    backendType: kind,
    durability: capabilitiesOf(module).durable ? "durable" : "volatile",
  });
}

async function routeFinalize(module: MemoryModule, sessionId: string): Promise<unknown> {
  const finalizable = module as Partial<{ finalize(sessionId: string): Promise<unknown> }>;
  if (typeof finalizable.finalize === "function") return finalizable.finalize(sessionId);
  return undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
