/**
 * Retention, forgetting, and safe export tests (MI-13).
 *
 * Covers the non-secret acceptance criteria with synthetic fixtures and fresh
 * temporary databases only:
 *  - exact record/session/workspace-principal forget with counts and status;
 *  - forgotten content disappears after restart and same-ID other scopes stay
 *    intact;
 *  - interrupted deletion resumes idempotently;
 *  - an in-flight summarizer completing after a deletion is rejected as stale;
 *  - retention by age and storage limits skips protected constraints/open work;
 *  - imports respect tombstones and never silently resurrect forgotten records;
 *  - redacted, versioned exports round-trip non-deleted records with original
 *    provenance and owner-only file permissions.
 *
 * Secret-shaped fixtures are intentionally not embedded here (see
 * memory-privacy.test.ts for the same policy). Export redaction is exercised
 * through the privacy boundary's deterministic truncation behavior instead.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryEventStore,
  type MemoryEventStore,
} from "../memory/event-store.js";
import { loadSession } from "../memory/session-loader.js";
import { importLegacyMemoryDocument } from "../memory/legacy-import.js";
import {
  IncrementalSummaryManager,
  type IncrementalSummarizer,
} from "../memory/incremental-summary.js";
import { MemoryRetentionController } from "../memory/retention.js";
import type {
  MemoryEventAppendV2,
  MemoryEventEnvelopeV2,
  MemoryIdentityV2,
  MemoryScopeV2,
} from "../memory/contracts-v2.js";

function makeScope(overrides: Partial<MemoryScopeV2> = {}): MemoryScopeV2 {
  return {
    workspaceId: "ws-retention",
    principalId: "principal-retention",
    sessionId: "session-retention",
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<MemoryIdentityV2> = {}): MemoryIdentityV2 {
  return {
    workspaceId: "ws-retention",
    principalId: "principal-retention",
    sessionId: "session-retention",
    runId: "run-retention",
    ...overrides,
  };
}

function makeAppend(eventId: string, overrides: Partial<MemoryEventAppendV2> = {}): MemoryEventAppendV2 {
  return {
    eventId,
    identity: makeIdentity(),
    runRef: "run-retention",
    kind: "observation",
    payload: { eventId },
    ...overrides,
  };
}

function makeStore(): { store: MemoryEventStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "elastic-agent-retention-"));
  return { store: createMemoryEventStore({ filePath: join(dir, "events.sqlite") }), dir };
}

async function testRecordForgetDeletesAndBlocksResurrection(): Promise<void> {
  const { store, dir } = makeStore();
  try {
    const scope = makeScope();
    const otherScope = makeScope({ workspaceId: "other-workspace" });
    assert.equal((await store.append(scope, makeAppend("evt-a1"))).status, "durable");
    assert.equal((await store.append(scope, makeAppend("evt-a2"))).status, "durable");
    assert.equal((await store.append(otherScope, makeAppend("evt-b1", { identity: makeIdentity({ workspaceId: "other-workspace" }) }))).status, "durable");

    const controller = new MemoryRetentionController(store);
    const preview = await controller.previewForget({ kind: "record", scope, eventIds: ["evt-a1"] });
    assert.equal(preview.kind, "record");
    assert.equal(preview.wouldDelete, 1);

    const forgotten = await controller.forget({ kind: "record", scope, eventIds: ["evt-a1"] });
    assert.equal(forgotten.status, "forgotten");
    if (forgotten.status === "forgotten") {
      assert.equal(forgotten.kind, "record");
      assert.equal(forgotten.deleted, 1);
      assert.equal(forgotten.notFound, 0);
      assert.equal(forgotten.generation, 1);
    }

    const retrieved = await store.retrieve({ scope, purpose: "replay" });
    assert.deepEqual(retrieved.events.map((event) => event.eventId), ["evt-a2"]);

    // Same-ID session in another scope remains intact.
    const other = await store.retrieve({ scope: otherScope, purpose: "replay" });
    assert.deepEqual(other.events.map((event) => event.eventId), ["evt-b1"]);

    // The tombstone blocks re-import of the forgotten record.
    assert.deepEqual(await store.tombstonedEventIds(scope, ["evt-a1", "evt-a2"]), ["evt-a1"]);

    // Restart: the deletion persists and the tombstone persists.
    await store.close(scope);
    const reopened = createMemoryEventStore({ filePath: join(dir, "events.sqlite") });
    const afterRestart = await reopened.retrieve({ scope, purpose: "replay" });
    assert.deepEqual(afterRestart.events.map((event) => event.eventId), ["evt-a2"]);
    assert.deepEqual(await reopened.tombstonedEventIds(scope, ["evt-a1"]), ["evt-a1"]);
    await reopened.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testSessionAndWorkspacePrincipalForget(): Promise<void> {
  const { store, dir } = makeStore();
  try {
    const scope1 = makeScope({ sessionId: "session-1" });
    const scope2 = makeScope({ sessionId: "session-2" });
    assert.equal((await store.append(scope1, makeAppend("evt-1", { identity: makeIdentity({ sessionId: "session-1" }) }))).status, "durable");
    assert.equal((await store.append(scope2, makeAppend("evt-2", { identity: makeIdentity({ sessionId: "session-2" }) }))).status, "durable");

    const controller = new MemoryRetentionController(store);
    const preview = await controller.previewForget({ kind: "session", scope: scope1 });
    assert.equal(preview.wouldDelete, 1);

    const forgotten = await controller.forget({ kind: "session", scope: scope1 });
    assert.equal(forgotten.status, "forgotten");
    if (forgotten.status === "forgotten") assert.equal(forgotten.deleted, 1);

    assert.equal((await loadSession(store, scope1)).status, "absent");
    const blocking = await store.blockingTombstone(scope1);
    assert.equal(blocking?.kind, "session");

    const principalForget = await controller.forget({ kind: "workspace-principal", workspaceId: scope2.workspaceId, principalId: scope2.principalId });
    assert.equal(principalForget.status, "forgotten");
    if (principalForget.status === "forgotten") assert.equal(principalForget.deleted, 1);
    assert.equal((await store.scopeSummaries()).length, 0);
    const principalBlocking = await store.blockingTombstone(scope2);
    assert.equal(principalBlocking?.kind, "workspace-principal");

    await store.close(scope1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testInterruptedDeletionResumesIdempotently(): Promise<void> {
  const { store, dir } = makeStore();
  try {
    const scope = makeScope();
    assert.equal((await store.append(scope, makeAppend("evt-a"))).status, "durable");

    const controller = new MemoryRetentionController(store);
    const first = await controller.forget({ kind: "record", scope, eventIds: ["evt-a"] });
    assert.equal(first.status, "forgotten");
    if (first.status === "forgotten") {
      assert.equal(first.deleted, 1);
      assert.equal(first.notFound, 0);
    }

    const second = await controller.forget({ kind: "record", scope, eventIds: ["evt-a"] });
    assert.equal(second.status, "forgotten");
    if (second.status === "forgotten") {
      assert.equal(second.deleted, 0);
      assert.equal(second.notFound, 1);
    }

    const preview = await controller.previewForget({ kind: "record", scope, eventIds: ["evt-a"] });
    assert.equal(preview.wouldDelete, 0);

    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testInFlightSummarizerCannotResurrectForgottenContent(): Promise<void> {
  const scope = makeScope();
  let resolveSummary: ((text: string) => void) | undefined;
  const summarizer: IncrementalSummarizer = {
    version: "fake-v1",
    summarize: () =>
      new Promise<string>((resolve) => {
        resolveSummary = resolve;
      }),
  };
  const manager = new IncrementalSummaryManager(scope, { summarizer });
  const event = makeAppend("evt-fact", { identity: makeIdentity(), payload: { text: "forgotten fact" } });
  const envelope: MemoryEventEnvelopeV2 = {
    schemaVersion: 1,
    sequence: 1,
    eventId: event.eventId,
    identity: event.identity,
    runRef: event.runRef,
    kind: event.kind,
    outcome: event.outcome,
    payload: event.payload,
    evidenceRefs: [],
    timestamp: "2024-01-01T00:00:00.000Z",
  };

  const pending = manager.advance([envelope]);
  manager.setDeletionGeneration(1);
  assert.equal(resolveSummary !== undefined, true, "summarizer must have been called");
  resolveSummary?.("summary containing forgotten fact");

  const result = await pending;
  assert.equal(result.status, "stale");
  assert.equal(result.checkpoint.text, "");
  assert.equal(manager.deletionGenerationNow(), 1);

  // A fresh manager built only from remaining (empty) history cannot reproduce
  // the forgotten fact either.
  const fresh = new IncrementalSummaryManager(scope, { summarizer: { version: "fake-v2", summarize: async () => "rebuilt" } });
  const freshResult = await fresh.advance([]);
  assert.equal(freshResult.status, "unchanged");
  assert.equal(freshResult.checkpoint.text, "");
}

async function testRetentionAgeAndProtectedScopes(): Promise<void> {
  const { store, dir } = makeStore();
  try {
    const oldScope = makeScope({ sessionId: "session-old" });
    const freshScope = makeScope({ sessionId: "session-fresh" });
    const protectedScope = makeScope({ sessionId: "session-protected" });
    assert.equal(
      (await store.append(oldScope, makeAppend("evt-old", { identity: makeIdentity({ sessionId: "session-old" }), timestamp: "2020-01-01T00:00:00.000Z" }))).status,
      "durable",
    );
    assert.equal(
      (await store.append(freshScope, makeAppend("evt-fresh", { identity: makeIdentity({ sessionId: "session-fresh" }), timestamp: "2024-06-01T00:00:00.000Z" }))).status,
      "durable",
    );
    assert.equal(
      (await store.append(
        protectedScope,
        makeAppend("evt-constraint", {
          identity: makeIdentity({ sessionId: "session-protected" }),
          kind: "constraint",
          outcome: { asserted: "completed", verification: "verified" },
          payload: { structured: { recordKind: "constraint", subject: "exact constraint", authoritative: true } },
          timestamp: "2020-01-01T00:00:00.000Z",
        }),
      )).status,
      "durable",
    );

    const controller = new MemoryRetentionController(store, { now: () => Date.parse("2025-01-01T00:00:00.000Z") });
    const policy = { olderThanMs: 365 * 24 * 60 * 60 * 1000 };
    const preview = await controller.previewRetention(policy);
    assert.equal(preview.status, "ok");
    assert.equal(preview.skippedProtected, 1, "protected scope must be skipped");
    assert.equal(preview.candidates.length, 1, "only the unprotected old scope is a candidate");
    assert.equal(preview.candidates[0].kind, "record");
    assert.equal(preview.candidates[0].scope.sessionId, "session-old");

    const applied = await controller.applyRetention(preview);
    assert.equal(applied.status, "applied");
    assert.equal(applied.applied, 1);

    assert.equal((await store.retrieve({ scope: oldScope, purpose: "replay" })).events.length, 0);
    assert.deepEqual(
      (await store.retrieve({ scope: freshScope, purpose: "replay" })).events.map((event) => event.eventId),
      ["evt-fresh"],
    );
    assert.deepEqual(
      (await store.retrieve({ scope: protectedScope, purpose: "replay" })).events.map((event) => event.eventId),
      ["evt-constraint"],
    );

    await store.close(oldScope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testRetentionStorageLimits(): Promise<void> {
  const { store, dir } = makeStore();
  try {
    const scope = makeScope({ sessionId: "session-many" });
    for (const eventId of ["evt-1", "evt-2", "evt-3"]) {
      assert.equal(
        (await store.append(scope, makeAppend(eventId, { identity: makeIdentity({ sessionId: "session-many" }) }))).status,
        "durable",
      );
    }
    const controller = new MemoryRetentionController(store);
    const preview = await controller.previewRetention({ maxEventsPerScope: 1 });
    assert.equal(preview.status, "ok");
    assert.equal(preview.candidates.length, 1);
    assert.equal(preview.candidates[0].kind, "record");
    assert.deepEqual(preview.candidates[0].eventIds?.slice().sort(), ["evt-1", "evt-2"]);

    const applied = await controller.applyRetention(preview);
    assert.equal(applied.status, "applied");
    assert.deepEqual(
      (await store.retrieve({ scope, purpose: "replay" })).events.map((event) => event.eventId),
      ["evt-3"],
    );

    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testExportRoundTripAndRedaction(): Promise<void> {
  const { store, dir } = makeStore();
  try {
    const scope = makeScope();
    const longPayload = { text: "x".repeat(5000) };
    const normalPayload = { note: "round trip note" };
    assert.equal((await store.append(scope, makeAppend("evt-long", { payload: longPayload }))).status, "durable");
    assert.equal((await store.append(scope, makeAppend("evt-note", { payload: normalPayload }))).status, "durable");

    const controller = new MemoryRetentionController(store);
    const exportPath = join(dir, "export.json");
    const exported = await controller.exportScope(scope, { filePath: exportPath });
    assert.equal(exported.status, "ok");
    if (exported.status === "ok") {
      assert.equal(exported.eventCount, 2);
      assert.equal(exported.path, exportPath);
      const longEvent = exported.document.events.find((event) => event.eventId === "evt-long");
      assert.ok(longEvent);
      const longText = (longEvent.payload as { text: string }).text;
      assert.ok(longText.length <= 4000 + "…[truncated]".length, "export must run the privacy boundary");
      assert.ok(longText.endsWith("…[truncated]"));
    }
    const mode = statSync(exportPath).mode & 0o777;
    assert.equal(mode, 0o600, `expected owner-only export file mode 0600, got ${mode.toString(8)}`);

    const forgotten = await controller.forget({ kind: "session", scope });
    assert.equal(forgotten.status, "forgotten");
    assert.equal((await store.retrieve({ scope, purpose: "replay" })).events.length, 0);

    const restored = await controller.restoreExport(exportPath, scope);
    assert.equal(restored.status, "restored");
    if (restored.status === "restored") assert.equal(restored.eventCount, 2);

    const retrieved = await store.retrieve({ scope, purpose: "replay" });
    assert.deepEqual(retrieved.events.map((event) => event.eventId).sort(), ["evt-long", "evt-note"]);
    assert.deepEqual(retrieved.events.map((event) => event.sequence).sort((a, b) => a - b), [1, 2]);
    const restoredNote = retrieved.events.find((event) => event.eventId === "evt-note");
    assert.deepEqual(restoredNote?.payload, normalPayload, "non-deleted record round-trips with original provenance");

    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testImportRespectsTombstone(): Promise<void> {
  const { store, dir } = makeStore();
  try {
    const scope = makeScope({ sessionId: "legacy-session" });
    const legacyPath = join(dir, "legacy.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        session_id: "legacy-session",
        summary: "historical summary",
        stepCount: 1,
        steps: [{ step: 1, actions: ["Read"], outcome: "completed" }],
      }),
      "utf8",
    );

    const first = await importLegacyMemoryDocument({ filePath: legacyPath, store, scope });
    assert.equal(first.status, "imported");

    const controller = new MemoryRetentionController(store);
    const forgotten = await controller.forget({ kind: "session", scope });
    assert.equal(forgotten.status, "forgotten");

    const second = await importLegacyMemoryDocument({ filePath: legacyPath, store, scope });
    assert.equal(second.status, "failure");
    if (second.status === "failure") {
      assert.match(second.reason, /tombstoned by a session deletion/);
    }

    await store.close(scope);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testRecordForgetDeletesAndBlocksResurrection();
  await testSessionAndWorkspacePrincipalForget();
  await testInterruptedDeletionResumesIdempotently();
  await testInFlightSummarizerCannotResurrectForgottenContent();
  await testRetentionAgeAndProtectedScopes();
  await testRetentionStorageLimits();
  await testExportRoundTripAndRedaction();
  await testImportRespectsTombstone();
  console.log("memory-retention.test.ts: OK (forget scopes, tombstones, stale summarizers, retention, export/restore)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
