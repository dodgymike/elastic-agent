/**
 * Explicit, non-destructive legacy memory importer (MI-04).
 *
 * Imports a caller-selected version-1 `PersistentMemoryDocument` (or the older
 * docs-example shape) into the versioned event store under an explicit target
 * scope. It never auto-discovers similarly named files and never modifies the
 * original. Imported model summaries and steps are historical claims, imported
 * with `verification: "unverified"` and never manufactured timestamps,
 * evidence, or verified outcomes.
 *
 * Rerunning the import is idempotent: event IDs are derived from the source
 * file digest plus the step index, so unchanged files map to the same events
 * and produce duplicates rather than new history.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  redactMemoryText,
  sanitizeMemoryJson,
} from "./privacy.js";
import {
  stableEventId,
  validateScope,
  type MemoryEventAppendV2,
  type MemoryOutcomeAssertionV2,
  type MemoryScopeV2,
} from "./contracts-v2.js";
import type { MemoryEventStore } from "./event-store.js";

/** Migration/import version recorded on imported events. */
export const LEGACY_IMPORT_MIGRATION_VERSION = 1 as const;

/** Default maximum accepted legacy file size. */
export const DEFAULT_MAX_LEGACY_FILE_BYTES = 1_000_000;

const ASSERTIONS = new Set<string>(["completed", "failed", "aborted", "skipped", "unknown"]);

/** Result of a legacy import attempt. */
export type LegacyImportResult =
  | {
      readonly status: "imported";
      readonly scope: MemoryScopeV2;
      readonly eventCount: number;
      readonly sourceDigest: string;
    }
  | {
      readonly status: "unchanged";
      readonly scope: MemoryScopeV2;
      readonly sourceDigest: string;
      readonly reason: string;
    }
  | { readonly status: "failure"; readonly reason: string };

export interface LegacyImportOptions {
  /** Caller-selected legacy file to import. */
  readonly filePath: string;
  /** Target event store. */
  readonly store: MemoryEventStore;
  /** Explicit target scope; the document's session id must match. */
  readonly scope: MemoryScopeV2;
  /** Optional size limit override. */
  readonly maxBytes?: number;
}

interface LegacyDocument {
  readonly version: number;
  readonly sessionId: string;
  readonly userId?: string;
  readonly persistedAt?: string;
  readonly summary?: string;
  readonly steps: readonly LegacyStep[];
}

interface LegacyStep {
  readonly stepNumber: number;
  readonly actions: readonly string[];
  readonly outcome?: string;
  readonly description?: string;
  readonly reasoning?: string;
  readonly timestamp?: string;
}

/** Import a legacy document into the event store without modifying the source. */
export async function importLegacyMemoryDocument(
  options: LegacyImportOptions,
): Promise<LegacyImportResult> {
  const scope = validateScope(options.scope);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LEGACY_FILE_BYTES;
  try {
    const raw = readFileSync(options.filePath);
    if (raw.length > maxBytes) {
      return { status: "failure", reason: `legacy file too large (${raw.length} bytes; limit ${maxBytes})` };
    }
    const sourceDigest = createHash("sha256").update(raw).digest("hex");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      return { status: "failure", reason: `legacy file is not valid JSON: ${redactMemoryText(describeError(error))}` };
    }
    const document = validateLegacyDocument(parsed);
    if (document.sessionId !== scope.sessionId) {
      return {
        status: "failure",
        reason: "legacy document session_id does not match the explicit target scope",
      };
    }

    const events = buildImportEvents(document, scope, sourceDigest);

    // MI-13: imports must respect tombstones. A workspace/principal- or
    // session-level deletion blocks the whole import; record-level tombstones
    // block the specific records. Resurrection is only possible through the
    // explicit restore operation, never through a silent re-import.
    const blocking = await options.store.blockingTombstone(scope);
    if (blocking) {
      return {
        status: "failure",
        reason: `scope is tombstoned by a ${blocking.kind} deletion; use an explicit restore operation instead of import`,
      };
    }
    const tombstoned = await options.store.tombstonedEventIds(
      scope,
      events.map((event) => event.eventId),
    );
    if (tombstoned.length > 0) {
      return {
        status: "failure",
        reason: `import would resurrect forgotten records (${tombstoned.join(", ")}); use an explicit restore operation`,
      };
    }

    let durable = 0;
    let duplicate = 0;
    for (const event of events) {
      const result = await options.store.append(scope, event);
      if (result.status === "durable") {
        durable += 1;
      } else if (result.status === "duplicate") {
        duplicate += 1;
      } else {
        return {
          status: "failure",
          reason: result.status === "conflict" ? result.reason : result.reason,
        };
      }
    }
    if (durable === 0 && duplicate > 0) {
      return {
        status: "unchanged",
        scope,
        sourceDigest,
        reason: "all imported events were already present",
      };
    }
    return { status: "imported", scope, eventCount: events.length, sourceDigest };
  } catch (error) {
    return { status: "failure", reason: redactMemoryText(describeError(error)) };
  }
}

/** Copy a corrupt/unreadable legacy file to an owner-only quarantine directory. */
export function quarantineLegacyFile(sourcePath: string, quarantineDir?: string): string {
  const source = resolve(sourcePath);
  const dir = resolve(quarantineDir ?? join(dirname(source), "quarantine"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = join(dir, `${basename(source)}.quarantine-${Date.now()}`);
  copyFileSync(source, destination);
  return destination;
}

function validateLegacyDocument(value: unknown): LegacyDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("legacy document must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "number") {
    throw new Error("legacy document version must be a number");
  }
  if (record.version > 1) {
    throw new Error(`unsupported legacy document version ${record.version}`);
  }
  if (record.version !== 1) {
    throw new Error("legacy document version must be 1");
  }
  if (typeof record.session_id !== "string" || record.session_id.length === 0) {
    throw new Error("legacy document session_id must be a non-empty string");
  }
  const summary = record.summary;
  if (summary !== undefined && typeof summary !== "string") {
    throw new Error("legacy document summary must be a string when present");
  }
  const stepCount = record.stepCount;
  const steps = record.steps;
  if (!Array.isArray(steps)) {
    throw new Error("legacy document steps must be an array");
  }
  if (stepCount !== undefined && (typeof stepCount !== "number" || !Number.isInteger(stepCount))) {
    throw new Error("legacy document stepCount must be an integer when present");
  }
  if (stepCount !== undefined && steps.length !== stepCount) {
    throw new Error("legacy document step count does not match its steps array");
  }
  const parsedSteps = steps.map((step, index): LegacyStep => {
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      throw new Error(`legacy step ${index + 1} must be an object`);
    }
    const s = step as Record<string, unknown>;
    const stepNumberValue = s.step ?? s.index;
    let stepNumber: number;
    if (stepNumberValue === undefined) {
      stepNumber = index + 1;
    } else if (typeof stepNumberValue === "number" && Number.isInteger(stepNumberValue) && stepNumberValue > 0) {
      stepNumber = stepNumberValue;
    } else {
      throw new Error(`legacy step ${index + 1} has an invalid step/index`);
    }
    let actions: readonly string[];
    if (Array.isArray(s.actions)) {
      actions = s.actions.filter((action): action is string => typeof action === "string");
      if (actions.length !== s.actions.length) {
        throw new Error(`legacy step ${stepNumber} actions must be strings`);
      }
    } else if (typeof s.action === "string") {
      actions = [s.action];
    } else {
      throw new Error(`legacy step ${stepNumber} must provide actions or an action`);
    }
    for (const field of ["outcome", "description", "reasoning", "timestamp"] as const) {
      const value = s[field];
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`legacy step ${stepNumber} ${field} must be a string when present`);
      }
    }
    return {
      stepNumber,
      actions,
      outcome: s.outcome as string | undefined,
      description: s.description as string | undefined,
      reasoning: s.reasoning as string | undefined,
      timestamp: s.timestamp as string | undefined,
    };
  });
  return {
    version: record.version,
    sessionId: record.session_id as string,
    userId: typeof record.user_id === "string" ? record.user_id : undefined,
    persistedAt: typeof record.persistedAt === "string" ? record.persistedAt : undefined,
    summary,
    steps: parsedSteps,
  };
}

function buildImportEvents(
  document: LegacyDocument,
  scope: MemoryScopeV2,
  sourceDigest: string,
): MemoryEventAppendV2[] {
  const events: MemoryEventAppendV2[] = [];
  const runId = `legacy-import:${sourceDigest.slice(0, 16)}`;
  const timestamp = document.persistedAt ?? undefined;
  for (const step of document.steps) {
    const semanticKey = `legacy-import:${sourceDigest}:${document.sessionId}:step:${step.stepNumber}`;
    const outcome = mapOutcome(step.outcome);
    const payload = sanitizeMemoryJson({
      legacy: {
        actions: step.actions,
        description: step.description,
        reasoning: step.reasoning === undefined ? undefined : redactMemoryText(step.reasoning),
        user_id: document.userId,
        import: {
          migrationVersion: LEGACY_IMPORT_MIGRATION_VERSION,
          sourceDigest,
        },
      },
    });
    events.push({
      eventId: stableEventId(scope, semanticKey),
      identity: { ...scope, runId },
      runRef: "legacy-import",
      stepRef: String(step.stepNumber),
      ...(timestamp !== undefined ? { timestamp } : {}),
      kind: "observation",
      ...(outcome !== undefined ? { outcome } : {}),
      ...(payload !== undefined ? { payload } : {}),
    });
  }
  // Import the narrative summary as an unverified historical claim.
  if (document.summary !== undefined && document.summary.length > 0) {
    const payload = sanitizeMemoryJson({
      legacySummary: redactMemoryText(document.summary),
      import: {
        migrationVersion: LEGACY_IMPORT_MIGRATION_VERSION,
        sourceDigest,
      },
    });
    events.push({
      eventId: stableEventId(scope, `legacy-import:${sourceDigest}:${document.sessionId}:summary`),
      identity: { ...scope, runId },
      runRef: "legacy-import",
      stepRef: "summary",
      ...(timestamp !== undefined ? { timestamp } : {}),
      kind: "fact",
      ...(payload !== undefined ? { payload } : {}),
    });
  }
  return events;
}

function mapOutcome(value: string | undefined): { asserted: MemoryOutcomeAssertionV2; verification: "unverified" } | undefined {
  if (value === undefined || !ASSERTIONS.has(value)) return undefined;
  return { asserted: value as MemoryOutcomeAssertionV2, verification: "unverified" };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
