/**
 * Focused contract/identity tests for the versioned memory surface (MI-01).
 *
 * Covers the acceptance criteria:
 *  - equal session names across different workspaces/principals are distinct;
 *  - task IDs never stand in for principal IDs;
 *  - retries reuse a stable event ID while new events get different IDs;
 *  - a scope is required before store access and mismatches cannot fall back;
 *  - versioned envelopes round-trip JSON and invalid kinds/identity/sequence/
 *    schema versions are rejected;
 *  - the legacy compatibility adapter fails closed on durability instead of
 *    presenting a non-durable append as durable success.
 *
 * Follows the project's test conventions: plain `node:assert/strict`, a
 * `main().catch(...)` entrypoint, compiled with tsc and run with node. All
 * fixtures are synthetic temporary paths.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertScopeMatches,
  buildEventEnvelope,
  canonicalizeWorkspacePath,
  computeEventDigest,
  deriveWorkspaceId,
  freshEventId,
  parseEventEnvelope,
  resolveLocalPrincipalId,
  resolvePrincipalId,
  scopeFromIdentity,
  scopesEqual,
  serializeEventEnvelope,
  stableEventId,
  validateEventAppend,
  validateEventEnvelope,
  validateIdentity,
  validateScope,
} from "../memory/contracts-v2.js";
import type {
  MemoryEventAppendV2,
  MemoryIdentityV2,
  MemoryScopeV2,
} from "../memory/contracts-v2.js";
import {
  LegacyMemoryModuleAdapter,
  adaptLegacyMemoryModule,
} from "../memory/legacy-compat.js";
import { createInMemoryMemoryModule, InMemoryMemoryModule } from "../memory/inMemory.js";

function makeScope(overrides: Partial<MemoryScopeV2> = {}): MemoryScopeV2 {
  return {
    workspaceId: "ws-a",
    principalId: "principal-a",
    sessionId: "session-1",
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<MemoryIdentityV2> = {}): MemoryIdentityV2 {
  return {
    workspaceId: "ws-a",
    principalId: "principal-a",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  };
}

function makeAppend(overrides: Partial<MemoryEventAppendV2> = {}): MemoryEventAppendV2 {
  return {
    eventId: "evt-1",
    identity: makeIdentity(),
    runRef: "run-1",
    stepRef: "0",
    timestamp: "2026-09-06T00:00:00.000Z",
    kind: "observation",
    outcome: { asserted: "completed", verification: "verified" },
    payload: { step: 1 },
    evidenceRefs: [],
    ...overrides,
  };
}

async function testScopeRequiresAllFieldsWithoutFallback(): Promise<void> {
  const valid = validateScope({ workspaceId: "w", principalId: "p", sessionId: "s" });
  assert.deepEqual(valid, { workspaceId: "w", principalId: "p", sessionId: "s" });

  assert.throws(() => validateScope({ workspaceId: "w", principalId: "p" }), /sessionId/);
  assert.throws(() => validateScope({ workspaceId: "w", sessionId: "s" }), /principalId/);
  assert.throws(() => validateScope({ principalId: "p", sessionId: "s" }), /workspaceId/);
  assert.throws(() => validateScope(null), /object/);
  assert.throws(() => validateScope({ workspaceId: "", principalId: "p", sessionId: "s" }), /workspaceId/);
}

async function testEqualSessionNamesAcrossWorkspacesAreDistinct(): Promise<void> {
  const a = makeScope({ workspaceId: "ws-a", sessionId: "same-session" });
  const b = makeScope({ workspaceId: "ws-b", sessionId: "same-session" });
  const c = makeScope({ workspaceId: "ws-a", principalId: "principal-b", sessionId: "same-session" });

  assert.equal(scopesEqual(a, b), false);
  assert.equal(scopesEqual(a, c), false);
  assert.equal(scopesEqual(a, makeScope({ sessionId: "same-session" })), true);

  assert.throws(() => assertScopeMatches(a, b, "store access"), /mismatch/);

  // Stable event IDs must also diverge across workspaces/principals even when
  // the session name and semantic key are identical.
  const key = "run-1:step:1";
  assert.notEqual(stableEventId(a, key), stableEventId(b, key));
  assert.notEqual(stableEventId(a, key), stableEventId(c, key));
}

async function testTaskIdNeverStandsInForPrincipal(): Promise<void> {
  const identity = makeIdentity({ taskId: "task-42", principalId: "principal-a" });
  const scope = scopeFromIdentity(identity);
  assert.equal(scope.principalId, "principal-a");
  assert.notEqual(scope.principalId, "task-42");

  // The local principal is explicit and workspace-derived, never a task ID or
  // credential-derived value.
  const local = resolveLocalPrincipalId("ws-a");
  assert.equal(local, "local:ws-a");
  assert.notEqual(local, "task-42");
  assert.equal(resolvePrincipalId("ws-a"), "local:ws-a");
  assert.equal(resolvePrincipalId("ws-a", "authenticated-user"), "authenticated-user");
}

async function testRetriesReuseStableEventIdsAndNewEventsDiffer(): Promise<void> {
  const scope = makeScope();
  const retryKey = "run-1:step:3";
  assert.equal(stableEventId(scope, retryKey), stableEventId(scope, retryKey));
  assert.notEqual(stableEventId(scope, retryKey), stableEventId(scope, "run-1:step:4"));
  assert.notEqual(stableEventId(scope, retryKey), freshEventId());
  assert.notEqual(freshEventId(), freshEventId());
}

async function testEventEnvelopeRoundTripsThroughJson(): Promise<void> {
  const append = makeAppend();
  const envelope = buildEventEnvelope(append, 1);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.sequence, 1);
  assert.equal(envelope.evidenceRefs.length, 0);

  const json = serializeEventEnvelope(envelope);
  const parsed = parseEventEnvelope(json);
  assert.deepEqual(parsed, envelope);
}

async function testInvalidEnvelopesAreRejected(): Promise<void> {
  const envelope = buildEventEnvelope(makeAppend(), 1);

  // Unsupported schema version.
  assert.throws(
    () => parseEventEnvelope(JSON.stringify({ ...envelope, schemaVersion: 2 })),
    /unsupported schema version/,
  );

  // Invalid sequence values.
  assert.throws(() => validateEventEnvelope({ ...envelope, sequence: 0 }), /positive integer/);
  assert.throws(() => validateEventEnvelope({ ...envelope, sequence: -1 }), /positive integer/);
  assert.throws(() => validateEventEnvelope({ ...envelope, sequence: 1.5 }), /positive integer/);
  assert.throws(() => validateEventEnvelope({ ...envelope, sequence: "1" }), /positive integer/);

  // Invalid kinds.
  assert.throws(
    () => validateEventAppend({ ...makeAppend(), kind: "not-a-kind" }),
    /event.kind must be one of/,
  );

  // Missing identity and missing runId.
  const noIdentity = makeAppend() as unknown as Record<string, unknown>;
  delete noIdentity.identity;
  assert.throws(() => validateEventAppend(noIdentity), /identity must be an object/);
  assert.throws(
    () => validateIdentity({ workspaceId: "w", principalId: "p", sessionId: "s" }),
    /runId/,
  );

  // Missing/invalid runRef and non-JSON-safe payloads.
  assert.throws(() => validateEventAppend({ ...makeAppend(), runRef: "" }), /runRef/);
  assert.throws(
    () => validateEventAppend({ ...makeAppend(), payload: { bad: 10n } }),
    /JSON-safe/,
  );

  // Invalid outcome vocabularies.
  assert.throws(
    () => validateEventAppend({ ...makeAppend(), outcome: { asserted: "maybe", verification: "verified" } }),
    /outcome.asserted/,
  );
  assert.throws(
    () => validateEventAppend({ ...makeAppend(), outcome: { asserted: "completed", verification: "probably" } }),
    /outcome.verification/,
  );
}

async function testContentDigestDetectsConflictsOnReusedIds(): Promise<void> {
  const base = makeAppend({ eventId: "evt-retry" });
  const sameContentDifferentTimestamp = {
    ...base,
    timestamp: "2026-09-06T01:00:00.000Z",
  };
  assert.equal(computeEventDigest(base), computeEventDigest(sameContentDifferentTimestamp));

  const differentPayload = { ...base, payload: { step: 2 } };
  assert.notEqual(computeEventDigest(base), computeEventDigest(differentPayload));

  const differentOutcome = {
    ...base,
    outcome: { asserted: "failed" as const, verification: "verified" as const },
  };
  assert.notEqual(computeEventDigest(base), computeEventDigest(differentOutcome));
}

async function testWorkspaceCanonicalizationIsStableAndIsolatedByPath(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mi01-ws-"));
  try {
    const parentA = join(root, "a");
    const parentB = join(root, "b");
    // Equal basenames in different parents must not imply sharing.
    const repoA = join(parentA, "repo");
    const repoB = join(parentB, "repo");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    mkdirSync(join(repoA, "sub"), { recursive: true });

    const canonicalA = canonicalizeWorkspacePath(join(repoA, "sub", ".."));
    assert.equal(canonicalA, realpathSync(repoA));
    assert.equal(canonicalizeWorkspacePath(repoA), canonicalA);

    const idA1 = deriveWorkspaceId(canonicalA);
    const idA2 = deriveWorkspaceId(canonicalizeWorkspacePath(repoA));
    const idB = deriveWorkspaceId(canonicalizeWorkspacePath(repoB));
    assert.equal(idA1, idA2);
    assert.notEqual(idA1, idB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testLegacyAdapterFailsClosedOnDurability(): Promise<void> {
  const legacy = new InMemoryMemoryModule({});
  const adapter = new LegacyMemoryModuleAdapter(legacy);
  const scope = makeScope();
  const identity = makeIdentity();
  const event = makeAppend({ identity });

  const init = await adapter.initialize(scope);
  assert.equal(init.status, "ready");
  if (init.status === "ready") {
    assert.deepEqual(init.scope, scope);
  }

  // A legacy `remember()` returns void, so the adapter must not claim durable
  // success even though the in-process store accepted the step.
  const append = await adapter.append(scope, event);
  assert.equal(append.status, "failure");
  if (append.status === "failure") {
    assert.match(append.reason, /does not report durable append semantics/);
  }
  // The legacy store still holds the step for the current process.
  assert.equal(legacy.countForSession("session-1"), 1);

  // A scope mismatch must never fall back to the legacy store's own session.
  const otherScope = makeScope({ sessionId: "other-session" });
  const mismatch = await adapter.append(otherScope, event);
  assert.equal(mismatch.status, "failure");
  if (mismatch.status === "failure") {
    assert.match(mismatch.reason, /mismatch/);
  }

  // Retrieval is degraded but still surfaces the legacy rendered context.
  const retrieved = await adapter.retrieve({ scope, purpose: "prompt-context" });
  assert.equal(retrieved.degraded, true);
  assert.equal(retrieved.scope.workspaceId, scope.workspaceId);
  assert.ok(retrieved.text !== undefined && retrieved.text.length > 0);

  // The convenience wrapper returns the same adapter shape.
  const wrapped = adaptLegacyMemoryModule(createInMemoryMemoryModule({}));
  assert.equal(wrapped.capabilities.durable, false);
}

async function main(): Promise<void> {
  await testScopeRequiresAllFieldsWithoutFallback();
  await testEqualSessionNamesAcrossWorkspacesAreDistinct();
  await testTaskIdNeverStandsInForPrincipal();
  await testRetriesReuseStableEventIdsAndNewEventsDiffer();
  await testEventEnvelopeRoundTripsThroughJson();
  await testInvalidEnvelopesAreRejected();
  await testContentDigestDetectsConflictsOnReusedIds();
  await testWorkspaceCanonicalizationIsStableAndIsolatedByPath();
  await testLegacyAdapterFailsClosedOnDurability();
  console.log("memory-contract-v2.test.ts: OK (scope/identity, event envelope, digest, adapter)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
