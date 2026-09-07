/**
 * Capability declarations and inspection for memory backends (MI-11).
 *
 * The versioned contract (`src/memory/contracts-v2.ts`) defines a small capability
 * surface — durable appends, retrieval purposes, compaction, forgetting, and
 * export — so callers can route lifecycle work to the authoritative owner
 * instead of branching on concrete classes. This module supplies:
 *
 *  - canonical capability constants for each supported backend family,
 *  - `capabilitiesOf()` for reading a module's advertised capabilities (with a
 *    conservative non-durable fallback for modules that do not advertise any),
 *  - `hasExplicitCapabilities()` so wrappers can distinguish "known
 *    non-durable" from "unknown" before deciding whether a projection may be
 *    updated, and
 *  - `describeCapabilityGap()` for actionable diagnostics when a required
 *    operation is not supported.
 *
 * Backends that implement the v2 interface (for example `MemoryEventStore`)
 * already expose `capabilities`. The legacy v1 backends advertise an inline,
 * structurally-compatible `capabilities` property on their classes so this
 * module never needs a concrete class check.
 */

import type { MemoryCapabilitiesV2 } from "./contracts-v2.js";

/** A module that may advertise the v2 capability surface. */
export interface MemoryBackendCapabilityProvider {
  readonly capabilities?: MemoryCapabilitiesV2;
}

/**
 * Capabilities of the volatile in-memory backend. Appends are not durable, but
 * the summary read/write surface exists so the compactor can run against it.
 */
export const VOLATILE_MEMORY_CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: false,
  retrievalPurposes: ["prompt-context"],
  supportsCompaction: true,
  supportsForget: false,
  supportsExport: false,
};

/**
 * Capabilities of the legacy persistent backend. `remember()` is in-process
 * and therefore not durable per append; durability is established only by the
 * end-of-plan `finalize()` document write. Summary compaction is supported.
 */
export const LEGACY_PERSISTENT_CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: false,
  retrievalPurposes: ["prompt-context"],
  supportsCompaction: true,
  supportsForget: false,
  supportsExport: false,
};

/**
 * Capabilities of the graph backend. It is an in-memory projection over the
 * same steps and advertises neither durability, compaction, forgetting, nor
 * export. Graph nodes are not persisted.
 */
export const GRAPH_PROJECTION_CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: false,
  retrievalPurposes: ["prompt-context"],
  supportsCompaction: false,
  supportsForget: false,
  supportsExport: false,
};

/**
 * Capabilities of the opt-in `persistent-v2` event-store backend. Appends are
 * durably persisted, every structured retrieval purpose is available, and the
 * MI-13 retention surface adds forgetting plus safe export. Compaction remains
 * unsupported and is deliberately not advertised yet.
 */
export const PERSISTENT_V2_CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: true,
  retrievalPurposes: ["prompt-context", "replay", "audit", "export"],
  supportsCompaction: false,
  supportsForget: true,
  supportsExport: true,
};

/**
 * Conservative fallback for modules that do not advertise capabilities. An
 * unknown module is never assumed durable.
 */
export const UNKNOWN_BACKEND_CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: false,
  retrievalPurposes: ["prompt-context"],
  supportsCompaction: false,
  supportsForget: false,
  supportsExport: false,
};

/** True when a module explicitly advertises a capability surface. */
export function hasExplicitCapabilities(module: unknown): boolean {
  if (typeof module !== "object" || module === null) return false;
  return (module as MemoryBackendCapabilityProvider).capabilities !== undefined;
}

/** Read a module's advertised capabilities; unknown modules fall back conservatively. */
export function capabilitiesOf(module: unknown): MemoryCapabilitiesV2 {
  if (hasExplicitCapabilities(module)) {
    return (module as MemoryBackendCapabilityProvider).capabilities as MemoryCapabilitiesV2;
  }
  return UNKNOWN_BACKEND_CAPABILITIES;
}

/** Build an actionable reason for an unsupported operation. */
export function describeCapabilityGap(
  capabilities: MemoryCapabilitiesV2,
  operation: string,
): string {
  return (
    `${operation} is not supported by this backend ` +
    `(durable=${capabilities.durable}, compaction=${capabilities.supportsCompaction}, ` +
    `forget=${capabilities.supportsForget}, export=${capabilities.supportsExport})`
  );
}
