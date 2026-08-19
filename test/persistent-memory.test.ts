/**
 * Focused tests for the persistent, end-of-plan memory module
 * (`memory/persistent.ts`).
 *
 * Coverage mirrors the module's responsibilities:
 *  1. PersistentMemoryModule implements the MemoryModule contract (remember/
 *     getContext) with per-session isolation and the default summarizer.
 *  2. remember() records each step, refreshes the running summary via the
 *     injected (LLM) summarizer, and forwards to a delegate (chaining).
 *  3. finalize(sessionId) gathers the remembered steps, builds an end-of-plan
 *     summary through the summarizer, and writes a durable per-session JSON
 *     document atomically (version, session, plan, stepCount, summary, steps).
 *  4. finalize() uses the injected summarizer (not just the running summary),
 *     falls back gracefully when the summarizer throws, and returns the path.
 *  5. Fail-safe: a throwing delegate or summarizer is recorded on lastFailure
 *     and never rejects remember()/getContext().
 *  6. Factory: createPersistentMemoryModule returns a conforming module and
 *     honors outputDir/filePath and delegate options.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersistentMemoryModule,
  createPersistentMemoryModule,
  type PersistentMemoryDocument,
} from "../memory/persistent.js";
import type {
  MemoryAction,
  MemoryContext,
  MemoryModule,
  MemoryOutcomeStatus,
  RememberInput,
} from "../memory/types.js";
import type { MemorySummarizeInput, MemorySummarizer } from "../memory/inMemory.js";

const SESSION = "session-persist-abc";

/** A recording MemoryModule used to assert chaining/delegation. */
class RecordingMemory implements MemoryModule {
  readonly remembered: RememberInput[] = [];
  throwOnRemember = false;
  async remember(input: RememberInput): Promise<void> {
    if (this.throwOnRemember) throw new Error("recording remember boom");
    this.remembered.push(input);
  }
  async getContext(): Promise<{ text: string; matchedContexts: MemoryContext[]; hasMemory: boolean }> {
    return { text: "delegate", matchedContexts: [], hasMemory: false };
  }
}

/** A summarizer that records what it saw and returns a deterministic string. */
class CapturingSummarizer {
  calls: MemorySummarizeInput[] = [];
  constructor(
    private readonly next: (input: MemorySummarizeInput) => string,
    private readonly throws = false,
  ) {}
  readonly fn: MemorySummarizer = async (input: MemorySummarizeInput) => {
    if (this.throws) throw new Error("summarizer boom");
    this.calls.push(input);
    return this.next(input);
  };
}

function planStepInput(index: number, step: string, outcome: MemoryOutcomeStatus): RememberInput {
  const context: MemoryContext = {
    session_id: SESSION,
    user_id: "user-p",
    plan: "Plan: persist the work.",
    planState: { completedSteps: index },
    context: { step: index + 1 },
  };
  const actions: MemoryAction[] = [{ name: `plan-step-${index + 1}`, description: step }];
  return {
    context,
    actions,
    outcome,
    reasoning: `Reasoning for step ${index + 1}`,
    timestamp: "2024-01-01T00:00:00.000Z",
  };
}

async function main(): Promise<void> {
  /* ------------------------------------------------------------------ *
   * 1. Contract + per-session isolation + default summarizer.
   * ------------------------------------------------------------------ */
  {
    const mem = new PersistentMemoryModule({ outputDir: "memory-output" });
    await mem.remember(planStepInput(0, "read CLAUDE.md", "completed"));
    await mem.remember(planStepInput(1, "run build", "failed"));
    assert.equal(mem.countForSession(SESSION), 2);
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.equal(ctx.hasMemory, true);
    assert.equal(ctx.matchedContexts.length, 2);
    // Sessions are isolated.
    const other = await mem.getContext({ session_id: "other" });
    assert.equal(other.text, "");
    assert.equal(other.hasMemory, false);
  }

  /* ------------------------------------------------------------------ *
   * 2. remember() calls the injected summarizer + forwards to a delegate.
   * ------------------------------------------------------------------ */
  {
    const delegate = new RecordingMemory();
    const cap = new CapturingSummarizer((input) => `S(${input.sessionId},n=${input.entries.length})`);
    const mem = new PersistentMemoryModule({ summarizer: cap.fn, delegate });
    await mem.remember(planStepInput(0, "step a", "completed"));
    assert.equal(mem.summaryForSession(SESSION), "S(session-persist-abc,n=1)");
    assert.equal(cap.calls.length, 1);
    assert.equal(delegate.remembered.length, 1, "should forward to the delegate");
    await mem.remember(planStepInput(1, "step b", "completed"));
    assert.equal(mem.summaryForSession(SESSION), "S(session-persist-abc,n=2)");
    // getContext merges own + delegate context.
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.ok(ctx.text.includes("S(session-persist-abc,n=2)"));
    assert.ok(ctx.text.includes("delegate"));
  }

  /* ------------------------------------------------------------------ *
   * 3. finalize() persists a durable end-of-plan document.
   * ------------------------------------------------------------------ */
  {
    const dir = await mkdtemp(join(tmpdir(), "elagent-mem-"));
    try {
      const mem = new PersistentMemoryModule({ outputDir: dir });
      await mem.remember(planStepInput(0, "read CLAUDE.md", "completed"));
      await mem.remember(planStepInput(1, "run build", "failed"));
      const ctx = await mem.getContext({ session_id: SESSION });
      assert.ok(ctx.hasMemory);

      const path = await mem.finalize(SESSION);
      const raw = await readFile(path, "utf-8");
      const doc = JSON.parse(raw) as PersistentMemoryDocument;
      assert.equal(doc.version, 1);
      assert.equal(doc.session_id, SESSION);
      assert.equal(doc.user_id, "user-p");
      assert.ok(String(doc.plan).includes("persist the work"));
      assert.equal(doc.stepCount, 2);
      assert.ok(doc.summary.length > 0, "summary should be non-empty");
      assert.equal(doc.steps.length, 2);
      assert.deepEqual(doc.steps[0].actions, ["plan-step-1"]);
      assert.equal(doc.steps[0].outcome, "completed");
      assert.equal(doc.steps[1].outcome, "failed");
      assert.ok(doc.persistedAt.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------------------ *
   * 4. finalize() uses the injected summarizer for the document summary
   *    and falls back gracefully when the summarizer throws.
   * ------------------------------------------------------------------ */
  {
    const dir = await mkdtemp(join(tmpdir(), "elagent-mem-"));
    try {
      const cap = new CapturingSummarizer((input) => `FINAL(${input.sessionId},n=${input.entries.length})`);
      const mem = new PersistentMemoryModule({ outputDir: dir, summarizer: cap.fn });
      await mem.remember(planStepInput(0, "step x", "completed"));
      const path = await mem.finalize(SESSION);
      const doc = JSON.parse(await readFile(path, "utf-8")) as PersistentMemoryDocument;
      assert.equal(doc.summary, "FINAL(session-persist-abc,n=1)");
      // The summarizer was called again at finalize with the remembered entries.
      assert.ok(cap.calls.length >= 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // A throwing summarizer at finalize does not throw; the running summary is
    // still persisted and the failure is recorded on lastFailure.
    const dir2 = await mkdtemp(join(tmpdir(), "elagent-mem-"));
    try {
      const mem = new PersistentMemoryModule({ outputDir: dir2, summarizer: new CapturingSummarizer(() => "", true).fn });
      await mem.remember(planStepInput(0, "step y", "completed"));
      await mem.remember(planStepInput(1, "step z", "completed"));
      const path = await mem.finalize(SESSION); // must not reject
      const doc = JSON.parse(await readFile(path, "utf-8")) as PersistentMemoryDocument;
      assert.equal(doc.stepCount, 2);
      assert.ok(mem.lastFailure?.summarizerFailed, "summarizer failure should be recorded");
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. Fail-safe: a throwing delegate is absorbed into lastFailure and
   *    never rejects remember().
   * ------------------------------------------------------------------ */
  {
    const bad = new RecordingMemory();
    bad.throwOnRemember = true;
    const mem = new PersistentMemoryModule({ delegate: bad });
    await mem.remember(planStepInput(0, "step q", "completed"));
    assert.equal(mem.countForSession(SESSION), 1, "local remember must still succeed");
    assert.ok(mem.lastFailure?.delegateFailed, "delegate failure should be recorded");
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.ok(ctx.hasMemory, "context must still reflect local memory");
  }

  /* ------------------------------------------------------------------ *
   * 6. Factory swaps and honors options.
   * ------------------------------------------------------------------ */
  {
    const delegate = new RecordingMemory();
    const dir = await mkdtemp(join(tmpdir(), "elagent-mem-"));
    try {
      const module = createPersistentMemoryModule({ outputDir: dir, delegate }) as PersistentMemoryModule;
      assert.ok(module instanceof PersistentMemoryModule);
      await module.remember(planStepInput(0, "factory step", "completed"));
      assert.equal(module.countForSession(SESSION), 1);
      assert.equal(delegate.remembered.length, 1, "factory-created module should delegate");
      const path = await module.finalize(SESSION);
      assert.ok(path.endsWith(".json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("Persistent memory module tests passed (contract, summarizer, persist, finalize, fail-safe, factory)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
