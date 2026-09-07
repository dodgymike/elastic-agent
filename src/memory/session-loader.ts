/**
 * Session reload for the versioned event store (MI-04).
 *
 * `loadSession` is the explicit initialization/load path for an exact scope.
 * It distinguishes an absent session from a ready one and from a failure, and
 * rebuilds the session view from committed events. Retrieval on the store
 * itself already opens/migrates the database before querying, so the first
 * retrieval after a process restart waits for initialization instead of
 * returning an empty session.
 */

import { validateScope, type MemoryScopeV2 } from "./contracts-v2.js";
import type { MemoryEventStore } from "./event-store.js";

const RELOAD_PAGE_SIZE = 500;

/** Result of loading one session scope. */
export type SessionLoadResultV2 =
  | { readonly status: "absent"; readonly scope: MemoryScopeV2 }
  | {
      readonly status: "ready";
      readonly scope: MemoryScopeV2;
      readonly revision: number;
      readonly eventCount: number;
    }
  | { readonly status: "failure"; readonly scope: MemoryScopeV2; readonly reason: string };

/**
 * Load a session for an exact scope. Missing scopes report `absent`; invalid,
 * inaccessible, or incompatible stores report `failure`. A valid session is
 * rebuilt by paging through committed events.
 */
export async function loadSession(
  store: MemoryEventStore,
  scope: MemoryScopeV2,
): Promise<SessionLoadResultV2> {
  try {
    validateScope(scope);
    const metadata = await store.sessionMetadata(scope);
    if (metadata.event_count === 0 && metadata.last_sequence === 0) {
      return { status: "absent", scope };
    }
    let afterSequence: number | undefined;
    let revision = 0;
    let total = 0;
    while (true) {
      const page = await store.retrieve({
        scope,
        purpose: "replay",
        limit: RELOAD_PAGE_SIZE,
        ...(afterSequence !== undefined ? { afterSequence } : {}),
      });
      if (page.degraded) {
        return {
          status: "failure",
          scope,
          reason: page.degradedReason ?? "retrieval degraded while rebuilding the session",
        };
      }
      revision = page.revision;
      total += page.events.length;
      if (page.events.length === 0) break;
      afterSequence = page.events[page.events.length - 1].sequence;
      if (page.events.length < RELOAD_PAGE_SIZE) break;
    }
    return { status: "ready", scope, revision, eventCount: total };
  } catch (error) {
    return { status: "failure", scope, reason: describeError(error) };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
