// Unit tests for run-state.ts: the versioned durable run-state module (PI-06).
// Compiled into test/.run-state-build by the test:run-state npm script.
import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
    RUN_STATE_KIND,
    RUN_STATE_SCHEMA_VERSION,
    completedStepIds,
    createRunState,
    isRunState,
    isStepCompleted,
    loadRunState,
    normalizeRunState,
    runStateDigest,
    serializeRunState,
    validateRunState,
    writeRunState,
    type RunState,
    type RunStateCompletionRecord,
} from "../run-state.js";

const tmp = mkdtempSync(join(tmpdir(), "run-state-test-"));

function baseState(overrides: Record<string, unknown> = {}): RunState {
    const workspaceIdentity = overrides.workspaceIdentity !== undefined
        ? overrides.workspaceIdentity
        : { workspacePath: "/srv/workspace", branch: "main", worktreePath: null };
    const completedSteps: RunStateCompletionRecord[] = [
        {
            stepId: 1,
            outcome: "succeeded",
            completionCriteria: ["build exits 0", "tests pass"],
            attemptId: "attempt-1",
            feedbackResponseId: "resp-1",
            recordedAt: "2026-01-01T00:00:00.000Z",
        },
    ];
    return createRunState({
        planId: "PLAN-RS",
        planVersion: 3,
        activeStepId: overrides.activeStepId !== undefined ? overrides.activeStepId as number : 2,
        attemptId: overrides.attemptId !== undefined ? overrides.attemptId as string : "attempt-1",
        workspaceIdentity: workspaceIdentity as RunState["workspaceIdentity"],
        evidenceReferences: [
            { stepId: 1, attemptId: "attempt-1", feedbackResponseId: "resp-1", evidence: { summary: "ok" }, recordedAt: "2026-01-01T00:00:00.000Z" },
        ],
        completedSteps: overrides.completedSteps !== undefined ? overrides.completedSteps as RunStateCompletionRecord[] : completedSteps,
        updatedAt: "2026-01-01T00:00:01.000Z",
    });
}

function rawState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schemaVersion: RUN_STATE_SCHEMA_VERSION,
        planId: "PLAN-RS",
        planVersion: 3,
        activeStepId: 2,
        attemptId: "attempt-1",
        workspaceIdentity: { workspacePath: "/srv/workspace", branch: "main", worktreePath: null },
        evidenceReferences: [],
        completedSteps: [
            { stepId: 1, outcome: "succeeded", completionCriteria: ["criteria one"] },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

/** Minimal canonical serializer for constructing tampered-but-well-digested envelopes. */
function canonical(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            out[key] = canonical((value as Record<string, unknown>)[key]);
        }
        return out;
    }
    return value;
}

function envelopeWithState(state: unknown, digest?: string): string {
    const serialized = JSON.stringify(canonical(state)) + "\n";
    const computed = digest ?? createHash("sha256").update(serialized, "utf8").digest("hex");
    return JSON.stringify({ kind: RUN_STATE_KIND, schemaVersion: RUN_STATE_SCHEMA_VERSION, digest: computed, state }, null, 2) + "\n";
}

async function testCreateAndNormalize(): Promise<void> {
    const state = baseState();
    assert.equal(state.schemaVersion, RUN_STATE_SCHEMA_VERSION);
    assert.equal(state.planId, "PLAN-RS");
    assert.equal(state.planVersion, 3);
    assert.equal(state.activeStepId, 2);
    assert.equal(state.attemptId, "attempt-1");
    assert.deepEqual(state.workspaceIdentity, { workspacePath: "/srv/workspace", branch: "main", worktreePath: null });
    assert.equal(state.evidenceReferences.length, 1);
    assert.equal(state.completedSteps.length, 1);
    assert.deepEqual(state.completedSteps[0].completionCriteria, ["build exits 0", "tests pass"]);
    assert.equal(isRunState(state), true);

    const defaults = createRunState({
        planId: "PLAN-RS",
        planVersion: 1,
        workspaceIdentity: { workspacePath: "/srv/workspace", branch: null, worktreePath: null },
    });
    assert.equal(defaults.activeStepId, null);
    assert.equal(defaults.attemptId, null);
    assert.deepEqual(defaults.evidenceReferences, []);
    assert.deepEqual(defaults.completedSteps, []);
    assert.ok(!Number.isNaN(Date.parse(defaults.updatedAt)));

    const fromRaw = normalizeRunState(rawState());
    assert.equal(fromRaw.planId, "PLAN-RS");
    assert.equal(fromRaw.planVersion, 3);
    assert.deepEqual(fromRaw.completedSteps[0].completionCriteria, ["criteria one"]);

    // String-form positive integers are accepted and normalized.
    const numericStrings = normalizeRunState(rawState({ planVersion: "3", activeStepId: "2" }));
    assert.equal(numericStrings.planVersion, 3);
    assert.equal(numericStrings.activeStepId, 2);
    console.log("  ok: createRunState and normalizeRunState build validated state");
}

async function testSchemaRejectsInvalidFields(): Promise<void> {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
        [rawState({ planId: "" }), /'planId' must be a non-empty string/],
        [rawState({ planVersion: 0 }), /'planVersion' must be a positive integer/],
        [rawState({ activeStepId: 0 }), /'activeStepId' must be a positive integer/],
        [rawState({ attemptId: "" }), /'attemptId' must be a non-empty string/],
        [rawState({ workspaceIdentity: null }), /'workspaceIdentity' must be an object/],
        [rawState({ workspaceIdentity: { workspacePath: "", branch: null, worktreePath: null } }), /'workspaceIdentity.workspacePath' must be a non-empty string/],
        [rawState({ workspaceIdentity: { workspacePath: "a\u0000b", branch: null, worktreePath: null } }), /must not contain control characters/],
        [rawState({ evidenceReferences: {} }), /'evidenceReferences' must be an array/],
        [rawState({ completedSteps: {} }), /'completedSteps' must be an array/],
        [rawState({ updatedAt: "not-a-date" }), /'updatedAt' must be an ISO-8601 timestamp/],
        [rawState({ extraField: true }), /must not contain the field 'extraField'/],
        [rawState({ schemaVersion: 2 }), /schema version 2 is incompatible/],
    ];
    for (const [raw, pattern] of cases) {
        assert.throws(() => normalizeRunState(raw), pattern, JSON.stringify(raw));
    }

    assert.throws(() => normalizeRunState(null), /must be a JSON object/);
    assert.throws(() => normalizeRunState([]), /must be a JSON object/);
    console.log("  ok: schema rejects invalid, unknown, and incompatible fields");
}

async function testCompletionRecordValidation(): Promise<void> {
    // A terminal outcome and criteria round-trip exactly.
    const valid = normalizeRunState(rawState({
        completedSteps: [{ stepId: 4, outcome: "blocked", completionCriteria: ["a", "b"], feedbackResponseId: null }],
    }));
    assert.equal(valid.completedSteps[0].stepId, 4);
    assert.equal(valid.completedSteps[0].outcome, "blocked");
    assert.deepEqual(valid.completedSteps[0].completionCriteria, ["a", "b"]);
    assert.equal(valid.completedSteps[0].feedbackResponseId, null);

    const cases: Array<[unknown, RegExp]> = [
        [rawState({ completedSteps: [{ stepId: 1, outcome: "needs-verification", completionCriteria: ["x"] }] }), /must be a terminal step outcome/],
        [rawState({ completedSteps: [{ stepId: 1, outcome: "succeeded", completionCriteria: [] }] }), /completionCriteria.*non-empty array/],
        [rawState({ completedSteps: [{ stepId: 0, outcome: "succeeded", completionCriteria: ["x"] }] }), /stepId.*positive integer/],
        [rawState({ completedSteps: [{ stepId: 1, outcome: "succeeded", completionCriteria: ["x"], extra: 1 }] }), /must not contain the field 'extra'/],
        [rawState({
            completedSteps: [
                { stepId: 1, outcome: "succeeded", completionCriteria: ["x"] },
                { stepId: 1, outcome: "failed", completionCriteria: ["y"] },
            ],
        }), /must not contain duplicate step id 1/],
    ];
    for (const [raw, pattern] of cases) {
        assert.throws(() => normalizeRunState(raw), pattern);
    }
    console.log("  ok: completion records validate terminal outcomes, criteria, and uniqueness");
}

async function testEvidenceReferenceValidation(): Promise<void> {
    const valid = normalizeRunState(rawState({
        evidenceReferences: [{ stepId: 3, attemptId: "a1", feedbackResponseId: "r1", evidence: { findings: ["f"] }, recordedAt: "2026-01-01T00:00:00.000Z" }],
    }));
    assert.equal(valid.evidenceReferences[0].stepId, 3);
    assert.deepEqual(valid.evidenceReferences[0].evidence, { findings: ["f"] });

    assert.throws(
        () => normalizeRunState(rawState({ evidenceReferences: [{ attemptId: "a1" }] })),
        /stepId.*positive integer/,
    );
    assert.throws(
        () => normalizeRunState(rawState({ evidenceReferences: [{ stepId: 1, recordedAt: "yesterday" }] })),
        /recordedAt.*ISO-8601 timestamp/,
    );
    assert.throws(
        () => normalizeRunState(rawState({ evidenceReferences: [{ stepId: 1, unknown: true }] })),
        /must not contain the field 'unknown'/,
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(
        () => normalizeRunState(rawState({ evidenceReferences: [{ stepId: 1, evidence: circular }] })),
        /must be JSON-serializable/,
    );
    console.log("  ok: evidence references validate step id, evidence, and timestamps");
}

async function testWriteAndLoadRoundTrip(): Promise<void> {
    const file = join(tmp, "roundtrip", "run-state.json");
    const state = baseState();
    writeRunState(file, state);

    const result = loadRunState(file);
    assert.equal(result.status, "loaded");
    if (result.status !== "loaded") return;
    assert.equal(result.path, file);
    assert.equal(result.state.planId, "PLAN-RS");
    assert.equal(result.state.planVersion, 3);
    assert.equal(result.state.activeStepId, 2);
    assert.equal(result.state.attemptId, "attempt-1");
    assert.deepEqual(result.state.workspaceIdentity, state.workspaceIdentity);
    assert.equal(result.state.evidenceReferences.length, 1);
    assert.equal(result.state.evidenceReferences[0].stepId, 1);
    assert.deepEqual(result.state.completedSteps[0].completionCriteria, ["build exits 0", "tests pass"]);
    assert.deepEqual(result.state.completedSteps[0], state.completedSteps[0]);
    assert.equal(result.state.updatedAt, "2026-01-01T00:00:01.000Z");

    // The completion record is authoritative and independent of summarized memory.
    const memoryFile = join(tmp, "roundtrip", "memory.json");
    writeFileSync(memoryFile, '{"summarized":true}');
    rmSync(memoryFile);
    const afterMemoryLoss = loadRunState(file);
    assert.equal(afterMemoryLoss.status, "loaded");
    if (afterMemoryLoss.status === "loaded") {
        assert.deepEqual(afterMemoryLoss.state.completedSteps, state.completedSteps);
    }
    console.log("  ok: write/load round-trips plan, step ids, criteria, identity, and evidence");
}

async function testWriteIsAtomic(): Promise<void> {
    const dir = join(tmp, "atomic");
    const file = join(dir, "run-state.json");
    writeRunState(file, baseState());
    writeRunState(file, baseState({ activeStepId: 3, attemptId: "attempt-2" }));

    const entries = readdirSync(dir);
    assert.deepEqual(entries, ["run-state.json"], "atomic writes leave no temporary files behind");

    const envelope = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(envelope.kind, RUN_STATE_KIND);
    assert.equal(envelope.schemaVersion, RUN_STATE_SCHEMA_VERSION);
    assert.match(envelope.digest, /^[0-9a-f]{64}$/);

    const loaded = loadRunState(file);
    assert.equal(loaded.status, "loaded");
    if (loaded.status === "loaded") {
        assert.equal(loaded.state.activeStepId, 3);
        assert.equal(loaded.state.attemptId, "attempt-2");
    }
    console.log("  ok: writes are atomic (temp file + rename) with a sealed envelope");
}

async function testLoadDistinguishesAbsent(): Promise<void> {
    const missing = join(tmp, "missing", "run-state.json");
    const result = loadRunState(missing);
    assert.equal(result.status, "absent");
    assert.equal(result.path, missing);
    console.log("  ok: a missing run-state file is reported as absent, not as empty state");
}

async function testRejectsIncompatibleAndUntrustedArtifacts(): Promise<void> {
    const file = join(tmp, "reject", "run-state.json");
    writeRunState(file, baseState());

    const writeEnvelope = (envelope: unknown) => {
        writeFileSync(file, JSON.stringify(envelope, null, 2) + "\n");
    };

    const original = JSON.parse(readFileSync(file, "utf8"));

    // Wrong kind.
    writeEnvelope({ ...original, kind: "other-kind" });
    assert.equal(loadRunState(file).status, "invalid");

    // Incompatible schema version.
    writeEnvelope({ ...original, schemaVersion: RUN_STATE_SCHEMA_VERSION + 1 });
    assert.equal(loadRunState(file).status, "invalid");

    // Malformed digest.
    writeEnvelope({ ...original, digest: "not-a-digest" });
    assert.equal(loadRunState(file).status, "invalid");

    // Digest mismatch (tampered state, digest not recomputed).
    writeEnvelope({ ...original, state: { ...original.state, planId: "TAMPERED" } });
    assert.equal(loadRunState(file).status, "invalid");

    // Unknown envelope field.
    writeEnvelope({ ...original, injected: true });
    assert.equal(loadRunState(file).status, "invalid");

    // A correct digest over a state that fails structural validation.
    const invalidState = { ...rawState(), activeStepId: 0 };
    writeFileSync(file, envelopeWithState(invalidState));
    assert.equal(loadRunState(file).status, "invalid");

    // Invalid JSON.
    writeFileSync(file, "{ not json");
    assert.equal(loadRunState(file).status, "invalid");

    // Oversized file.
    const oversized = join(tmp, "reject", "oversized.json");
    writeFileSync(oversized, "x".repeat(1_048_577));
    assert.equal(loadRunState(oversized).status, "invalid");
    console.log("  ok: incompatible and untrusted artifacts are rejected");
}

async function testWriteRejectsInvalidState(): Promise<void> {
    const file = join(tmp, "invalid-write", "run-state.json");
    assert.throws(
        () => writeRunState(file, baseState({ completedSteps: [{ stepId: 1, outcome: "pending", completionCriteria: ["x"] }] as unknown })),
        /must be a terminal step outcome/,
    );
    assert.equal(existsSync(file), false, "an invalid state must never be written");
    console.log("  ok: writeRunState rejects invalid state before any file is created");
}

async function testDigestIsOrderIndependent(): Promise<void> {
    const a = normalizeRunState(JSON.parse('{"schemaVersion":1,"planId":"P","planVersion":1,"activeStepId":null,"attemptId":null,"workspaceIdentity":{"workspacePath":"/w","branch":null,"worktreePath":null},"evidenceReferences":[],"completedSteps":[],"updatedAt":"2026-01-01T00:00:00.000Z"}'));
    const b = normalizeRunState(JSON.parse('{"updatedAt":"2026-01-01T00:00:00.000Z","completedSteps":[],"evidenceReferences":[],"workspaceIdentity":{"worktreePath":null,"branch":null,"workspacePath":"/w"},"attemptId":null,"activeStepId":null,"planVersion":1,"planId":"P","schemaVersion":1}'));
    assert.equal(runStateDigest(a), runStateDigest(b), "digest must be independent of key insertion order");
    assert.ok(serializeRunState(a).length > 0);
    console.log("  ok: canonical serialization makes the digest key-order independent");
}

async function testHelpers(): Promise<void> {
    const state = baseState();
    assert.deepEqual(completedStepIds(state), [1]);
    assert.equal(isStepCompleted(state, 1), true);
    assert.equal(isStepCompleted(state, 2), false);

    const validated = validateRunState(state);
    assert.deepEqual(validated, state);
    console.log("  ok: completedStepIds/isStepCompleted/validateRunState helpers work");
}

async function testInvalidFilePathThrows(): Promise<void> {
    assert.throws(() => writeRunState("", baseState()), /must be a non-empty string/);
    assert.throws(() => writeRunState("bad\u0000path", baseState()), /must not contain NUL bytes/);
    assert.throws(() => loadRunState("bad\u0000path"), /must not contain NUL bytes/);
    console.log("  ok: empty and NUL-containing file paths are rejected");
}

async function main(): Promise<void> {
    await testCreateAndNormalize();
    await testSchemaRejectsInvalidFields();
    await testCompletionRecordValidation();
    await testEvidenceReferenceValidation();
    await testWriteAndLoadRoundTrip();
    await testWriteIsAtomic();
    await testLoadDistinguishesAbsent();
    await testRejectsIncompatibleAndUntrustedArtifacts();
    await testWriteRejectsInvalidState();
    await testDigestIsOrderIndependent();
    await testHelpers();
    await testInvalidFilePathThrows();
    console.log("Run-state tests passed");
}

main()
    .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        rmSync(tmp, { recursive: true, force: true });
    });
