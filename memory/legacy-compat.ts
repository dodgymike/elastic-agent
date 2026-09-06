/**
 * Compatibility adapter from the existing v1 `MemoryModule` contract to the
 * versioned `MemoryModuleV2` lifecycle interface (MI-01).
 *
 * The v1 backends (`InMemoryMemoryModule`, `PersistentMemoryModule`,
 * `GraphMemoryModule`, and the composite wrapper) keep working through their
 * existing factories. This adapter surfaces them behind the new interface so
 * code that depends on `MemoryModuleV2` can consume a legacy factory until the
 * rollout task migrates the default selection.
 *
 * Honesty rules enforced here:
 *  - The legacy `remember()` contract returns `void`, so it cannot establish a
 *    durable write. `append` therefore reports `failure` (fail-closed on
 *    durability) rather than presenting a non-durable acceptance as durable
 *    success.
 *  - `retrieve` reports `degraded: true` because legacy modules do not expose
 *    structured envelopes, evidence references, or a durable revision.
 */

import type {
  ContextRequest,
  MemoryContext,
  MemoryJsonValue,
  MemoryModule,
  RememberInput,
} from "./types.js";
import {
  assertScopeMatches,
  scopeFromIdentity,
  validateRetrievalPurpose,
  validateScope,
  type MemoryAppendResultV2,
  type MemoryCapabilitiesV2,
  type MemoryCloseResultV2,
  type MemoryEventAppendV2,
  type MemoryFlushResultV2,
  type MemoryInitResultV2,
  type MemoryModuleV2,
  type MemoryRetrieveRequestV2,
  type MemoryRetrieveResultV2,
  type MemoryScopeV2,
} from "./contracts-v2.js";

const LEGACY_CAPABILITIES: MemoryCapabilitiesV2 = {
  durable: false,
  retrievalPurposes: ["prompt-context"],
  supportsCompaction: false,
  supportsForget: false,
  supportsExport: false,
};

/**
 * Adapter exposing a legacy v1 `MemoryModule` as a `MemoryModuleV2`.
 *
 * Appends are non-durable by definition, so `append` fails closed with an
 * actionable reason instead of reporting success. Retrieval best-effort maps a
 * v2 request to the v1 `getContext()` call and marks the result degraded.
 */
export class LegacyMemoryModuleAdapter implements MemoryModuleV2 {
  readonly capabilities: MemoryCapabilitiesV2 = LEGACY_CAPABILITIES;

  constructor(private readonly delegate: MemoryModule) {}

  async initialize(scope: MemoryScopeV2): Promise<MemoryInitResultV2> {
    try {
      validateScope(scope);
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
    return { status: "ready", scope };
  }

  async append(scope: MemoryScopeV2, event: MemoryEventAppendV2): Promise<MemoryAppendResultV2> {
    try {
      validateScope(scope);
      assertScopeMatches(scope, scopeFromIdentity(event.identity), "append scope");
      await this.delegate.remember(toRememberInput(event));
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
    // The legacy contract returns void and cannot report durability. Report
    // failure (not durable success) so callers never mistake this for a
    // persisted write; the in-process legacy state still serves this run.
    return {
      status: "failure",
      reason: "legacy MemoryModule completed remember() but does not report durable append semantics",
    };
  }

  async retrieve(request: MemoryRetrieveRequestV2): Promise<MemoryRetrieveResultV2> {
    try {
      validateScope(request.scope);
      validateRetrievalPurpose(request.purpose);
      const legacy = await this.delegate.getContext(toContextRequest(request));
      return {
        scope: request.scope,
        revision: 0,
        events: [],
        evidenceRefs: [],
        degraded: true,
        degradedReason: "legacy MemoryModule is non-durable and exposes no structured events",
        text: legacy.text,
      };
    } catch (error) {
      return {
        scope: request.scope,
        revision: 0,
        events: [],
        evidenceRefs: [],
        degraded: true,
        degradedReason: describeError(error),
      };
    }
  }

  async flush(scope: MemoryScopeV2): Promise<MemoryFlushResultV2> {
    try {
      validateScope(scope);
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
    return { status: "failure", reason: "legacy MemoryModule is not durable; flush is unsupported" };
  }

  async close(scope: MemoryScopeV2): Promise<MemoryCloseResultV2> {
    try {
      validateScope(scope);
    } catch (error) {
      return { status: "failure", reason: describeError(error) };
    }
    return { status: "closed" };
  }
}

/** Wrap an existing legacy `MemoryModule` behind the v2 interface. */
export function adaptLegacyMemoryModule(delegate: MemoryModule): MemoryModuleV2 {
  return new LegacyMemoryModuleAdapter(delegate);
}

function toRememberInput(event: MemoryEventAppendV2): RememberInput {
  const contextRecord: Record<string, MemoryJsonValue> = {
    workspaceId: event.identity.workspaceId,
    principalId: event.identity.principalId,
    sessionId: event.identity.sessionId,
    runId: event.identity.runId,
    runRef: event.runRef,
    eventId: event.eventId,
  };
  if (event.identity.taskId !== undefined) contextRecord.taskId = event.identity.taskId;
  if (event.stepRef !== undefined) contextRecord.stepRef = event.stepRef;
  const context: MemoryContext = {
    session_id: event.identity.sessionId,
    user_id: event.identity.principalId,
    context: contextRecord,
  };
  return {
    context,
    actions: [{ name: event.kind, description: event.runRef }],
    outcome: event.outcome?.asserted ?? "unknown",
    outcomeDetail: event.payload as MemoryJsonValue | undefined,
    reasoning: event.outcome ? `verification=${event.outcome.verification}` : undefined,
    timestamp: event.timestamp,
  };
}

function toContextRequest(request: MemoryRetrieveRequestV2): ContextRequest {
  const contextRequest: ContextRequest = {
    session_id: request.scope.sessionId,
    user_id: request.scope.principalId,
    maxChars: request.maxChars,
    hints: request.hints,
  };
  return contextRequest;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
