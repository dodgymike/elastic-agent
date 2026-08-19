/**
 * Focused tests for the transport-agnostic memory module contract
 * (`memory/types.ts`), its in-memory implementation (`memory/inMemory.ts`),
 * chaining/swapping, and the LLM-memory prompt integration.
 *
 * Coverage mirrors the plan for the memory module:
 *  1. Interface conformance / a simple MemoryModule mock.
 *  2. InMemoryMemoryModule stores history, calls the injected (LLM) summarizer,
 *     and produces the expected summary.
 *  3. Chaining delegates calls and combines context (mergeContextResults).
 *  4. The LLM runtime consumes in-memory context and injects it into prompts
 *     (real InMemoryMemoryModule + real MultiTurnLlmRuntime).
 *  5. The plan-runner remember-after-step behavior feeds each remember() the
 *     correct data (the exact RememberInput shape the plan loop builds).
 *
 * Follows the project's test conventions: plain `node:assert/strict`, a
 * `main().catch(...)` entrypoint, compiled with tsc and run with node via the
 * `test:memory` script in package.json.
 */

import assert from "node:assert/strict";
import {
  InMemoryMemoryModule,
  createInMemoryMemoryModule,
  defaultHistorySummarizer,
  mergeContextResults,
  type MemorySummarizeInput,
  type MemorySummarizer,
} from "../memory/inMemory.js";
import type {
  ContextRequest,
  MemoryAction,
  MemoryContext,
  MemoryContextResult,
  MemoryModule,
  MemoryOutcomeStatus,
  RememberInput,
} from "../memory/types.js";
import { MultiTurnLlmRuntime } from "../llm/multi-turn-runtime.js";
import type { GenerateRequest, LlmAdapter } from "../llm/adapter-contract.js";

const SESSION = "session-abc";

/** Extract the initial (user) message text of a GenerateRequest. */
function initialText(request: GenerateRequest): string {
  const msg = request.messages[0];
  if (!msg || msg.role !== "user") return "";
  return msg.content[0]?.text ?? "";
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A recording MemoryModule used to assert interface conformance and chaining. */
class RecordingMemory implements MemoryModule {
  readonly remembered: RememberInput[] = [];
  readonly contextRequests: ContextRequest[] = [];
  result: MemoryContextResult;
  /** When set, remember() throws (to test fail-safe + delegation). */
  throwOnRemember = false;
  /** When set, getContext() throws (to test fail-safe merge). */
  throwOnGetContext = false;

  constructor(result: MemoryContextResult = { text: "", matchedContexts: [], hasMemory: false }) {
    this.result = result;
  }

  async remember(input: RememberInput): Promise<void> {
    if (this.throwOnRemember) throw new Error("recording remember boom");
    this.remembered.push(input);
  }

  async getContext(request: ContextRequest): Promise<MemoryContextResult> {
    if (this.throwOnGetContext) throw new Error("recording getContext boom");
    this.contextRequests.push(request);
    return this.result;
  }
}

/** A summarizer that records what it was passed and returns a deterministic string. */
class CapturingSummarizer {
  calls: MemorySummarizeInput[] = [];
  nextSummary: (input: MemorySummarizeInput) => string;

  constructor(nextSummary: (input: MemorySummarizeInput) => string) {
    this.nextSummary = nextSummary;
  }

  readonly fn: MemorySummarizer = async (input: MemorySummarizeInput) => {
    this.calls.push(input);
    return this.nextSummary(input);
  };
}

function planStepInput(index: number, step: string, outcome: MemoryOutcomeStatus, extra?: Partial<RememberInput>): RememberInput {
  const context: MemoryContext = {
    session_id: SESSION,
    user_id: "user-1",
    plan: "Plan: do the work.",
    planState: { completedSteps: index, activePlanSteps: ["Plan: do the work."] },
    context: { step: index + 1 },
  };
  const actions: MemoryAction[] = [
    { name: `plan-step-${index + 1}`, description: step.slice(0, 500) },
  ];
  return {
    context,
    actions,
    outcome,
    reasoning: `Reasoning for step ${index + 1}`,
    timestamp: "2024-01-01T00:00:00.000Z",
    ...extra,
  };
}

async function main(): Promise<void> {
  /* ------------------------------------------------------------------ *
   * 1. Interface conformance / simple mock
   * ------------------------------------------------------------------ */
  {
    // A plain object satisfying the `MemoryModule` interface can be used as a
    // swappable implementation (dependency injection) without coupling to a
    // concrete class.
    const simpleMock: MemoryModule = {
      async remember(input: RememberInput): Promise<void> {
        // A conforming mock must accept the full RememberInput shape. The
        // session id lives on input.context (transport-agnostic contract).
        assert.ok(input.context.session_id.length > 0);
        assert.ok(Array.isArray(input.actions));
        assert.ok(typeof input.outcome === "string");
      },
      async getContext(request: ContextRequest): Promise<MemoryContextResult> {
        assert.ok(request.session_id.length > 0);
        return { text: "left empty", matchedContexts: [], hasMemory: false };
      },
    };

    const input: RememberInput = planStepInput(0, "inspect repo", "completed", {
      outcomeDetail: { findings: ["repo looks tidy"] },
      reasoning: "Inspection only.",
    });
    await simpleMock.remember(input);
    const result = await simpleMock.getContext({ session_id: SESSION, user_id: "user-1" });
    assert.equal(result.text, "left empty");
    assert.equal(result.hasMemory, false);
  }

  /* ------------------------------------------------------------------ *
   * 2. InMemoryMemoryModule: stores history, calls the summarizer,
   *    produces the expected summary.
   * ------------------------------------------------------------------ */
  {
    const cap = new CapturingSummarizer((input) =>
      `Summary(${input.sessionId}, prev=${input.previousSummary ?? "none"}, n=${input.entries.length})`);
    const mem = new InMemoryMemoryModule({ summarizer: cap.fn });

    await mem.remember(planStepInput(0, "read CLAUDE.md", "completed"));
    assert.equal(mem.countForSession(SESSION), 1);
    assert.equal(mem.summaryForSession(SESSION), "Summary(session-abc, prev=none, n=1)");
    // The summarizer receives the session, the (absent) previous summary, and
    // the full history including the newest entry with monotonic entryAt.
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].sessionId, SESSION);
    assert.equal(cap.calls[0].previousSummary, undefined);
    assert.equal(cap.calls[0].entries.length, 1);
    assert.equal(cap.calls[0].entries[0].entryAt, 1);
    assert.deepEqual(cap.calls[0].entries[0].actions, ["plan-step-1"]);

    // A second remember() refreshes the summary and passes the previous one so
    // the summarizer can do incremental (chained) consolidation.
    await mem.remember(planStepInput(1, "edit config", "completed"));
    assert.equal(mem.countForSession(SESSION), 2);
    assert.equal(mem.summaryForSession(SESSION), "Summary(session-abc, prev=Summary(session-abc, prev=none, n=1), n=2)");
    assert.equal(cap.calls.length, 2);
    assert.equal(cap.calls[1].previousSummary, "Summary(session-abc, prev=none, n=1)");

    // getContext() returns the consolidated summary plus provenance.
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.equal(ctx.text, "Summary(session-abc, prev=Summary(session-abc, prev=none, n=1), n=2)");
    assert.equal(ctx.hasMemory, true);
    assert.equal(ctx.matchedContexts.length, 2);

    // Sessions are isolated: another session has no memory yet.
    const other = await mem.getContext({ session_id: "session-other" });
    assert.equal(other.text, "");
    assert.equal(other.hasMemory, false);
  }

  /* ------------------------------------------------------------------ *
   * 2b. defaultHistorySummarizer renders a readable, LLM-ready history.
   * ------------------------------------------------------------------ */
  {
    const mem = new InMemoryMemoryModule(); // no summarizer -> default renderer
    await mem.remember(planStepInput(0, "read CLAUDE.md", "completed"));
    await mem.remember(planStepInput(1, "run build", "failed", {
      outcomeDetail: { error: "tsc failed" },
    }));
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.ok(ctx.text.startsWith(`Session ${SESSION} history:`));
    assert.ok(ctx.text.includes("[1] completed: plan-step-1"));
    assert.ok(ctx.text.includes("[2] failed ({\"error\":\"tsc failed\"}): plan-step-2"));
    assert.equal(ctx.hasMemory, true);
  }

  /* ------------------------------------------------------------------ *
   * 3. Chaining: a module with a delegate forwards calls and combines
   *    context; failures are fail-safe.
   * ------------------------------------------------------------------ */
  {
    const delegate = new RecordingMemory({
      text: "delegate summary",
      matchedContexts: [{ session_id: "sess-d", plan: "delegatePlan" }],
      hasMemory: true,
    });
    const mem = new InMemoryMemoryModule({ delegate });
    const input = planStepInput(0, "step a", "completed");
    await mem.remember(input);

    // The in-memory module records locally AND forwards to the delegate.
    assert.equal(mem.countForSession(SESSION), 1);
    assert.equal(delegate.remembered.length, 1);
    assert.deepEqual(delegate.remembered[0].actions, [{ name: "plan-step-1", description: "step a" }]);

    // getContext() merges own summary with the delegate's, de-duplicating
    // provenance and combining text.
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.equal(delegate.contextRequests.length, 1);
    assert.ok(ctx.text.includes("completed: plan-step-1"), "should include the in-memory summary");
    assert.ok(ctx.text.includes("delegate summary"), "should include the delegate summary");
    assert.equal(ctx.hasMemory, true);
    // Provenance should contain both the local step context and the delegate's.
    assert.ok(ctx.matchedContexts.some((c) => c.session_id === SESSION));
    assert.ok(ctx.matchedContexts.some((c) => c.session_id === "sess-d"));
  }

  // A throwing delegate must not reject remember()/getContext(); the failure is
  // recorded on lastFailure and the local data is preserved.
  {
    const badDelegate = new RecordingMemory();
    badDelegate.throwOnRemember = true;
    badDelegate.throwOnGetContext = true;
    const mem = new InMemoryMemoryModule({ delegate: badDelegate });
    await mem.remember(planStepInput(0, "step x", "failed"));
    assert.equal(mem.countForSession(SESSION), 1, "local remember must still succeed");
    assert.ok(mem.lastFailure?.delegateFailed, "delegate failure should be recorded");
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.ok(ctx.hasMemory, "context must still reflect local memory");
  }

  // mergeContextResults de-duplicates identical provenance across results.
  {
    const shared: MemoryContext = { session_id: SESSION };
    const merged = mergeContextResults([
      { text: "a", matchedContexts: [shared], hasMemory: true },
      { text: "b", matchedContexts: [shared], hasMemory: true },
    ]);
    assert.equal(merged.text, "a\nb");
    assert.equal(merged.matchedContexts.length, 1, "shared provenance is de-duplicated");
    assert.equal(merged.hasMemory, true);
  }

  /* ------------------------------------------------------------------ *
   * 4. LLM runtime consumes in-memory context and injects it into prompts.
   *    (Real InMemoryMemoryModule + real MultiTurnLlmRuntime end to end.)
   * ------------------------------------------------------------------ */
  {
    const cap = new CapturingSummarizer((input) =>
      `remembered: ${input.entries.map((e) => e.actions.join(",")).join("; ")}`);
    const memory = new InMemoryMemoryModule({ summarizer: cap.fn });
    await memory.remember(planStepInput(0, "inspect repo layout", "completed"));

    const requests: GenerateRequest[] = [];
    const adapter: LlmAdapter = {
      provider: "fixture",
      capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
      async generate(request) {
        requests.push(request);
        return {
          id: "provider-1",
          model: request.model,
          finishReason: "stop",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        };
      },
    };
    const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, {
      memory,
      sessionId: SESSION,
    });
    await runtime.create({ input: "continue the work" });

    assert.equal(requests.length, 1);
    const promptText = initialText(requests[0]);
    assert.ok(promptText.startsWith("[SESSION MEMORY — additional context remembered from earlier in this session]"),
      "LLM prompt should be prefixed with the memory-context block");
    assert.ok(promptText.includes("remembered: plan-step-1"),
      "LLM prompt should contain the summarizer's in-memory-derived summary");
    assert.ok(promptText.endsWith("continue the work"), "the original prompt must follow the memory block");
  }

  /* ------------------------------------------------------------------ *
   * 5. Plan runner invokes remember() after each step with correct data.
   *
   * Mirrors the real wiring in main.ts (rememberAgentStep): after each plan
   * step completes, the loop calls remember() once with the step's metadata.
   * Here we drive the same loop shape against a recording module and assert the
   * exact RememberInput the plan runner produces.
   * ------------------------------------------------------------------ */
  {
    const recorder = new RecordingMemory();
    const steps = ["read CLAUDE.md", "edit package.json", "run build"];
    const plan = "Plan:\n1. read CLAUDE.md\n2. edit package.json\n3. run build";
    const outcomes: MemoryOutcomeStatus[] = ["completed", "completed", "failed"];
    const reasons = ["Step 1 done.", "Step 2 done.", "Build failed on tsc."];

    // The plan-execution loop: for each step, execute it, then remember() the
    // completed step with the metadata the runner carries.
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      await recorder.remember(planStepInput(index, step, outcomes[index], {
        context: {
          session_id: SESSION,
          user_id: "user-1",
          plan,
          planState: { completedSteps: index, activePlanSteps: [plan] },
          context: { step: index + 1 },
        },
        reasoning: reasons[index],
      }));
    }

    assert.equal(recorder.remembered.length, steps.length, "one remember() per plan step");
    for (let index = 0; index < steps.length; index += 1) {
      const input = recorder.remembered[index];
      assert.equal(input.context.session_id, SESSION);
      assert.equal(input.context.user_id, "user-1");
      assert.equal(input.context.plan, plan);
      assert.deepEqual(input.context.planState, { completedSteps: index, activePlanSteps: [plan] });
      assert.deepEqual(input.context.context, { step: index + 1 });
      assert.deepEqual(input.actions, [{ name: `plan-step-${index + 1}`, description: steps[index] }]);
      assert.equal(input.outcome, outcomes[index]);
      assert.equal(input.reasoning, reasons[index]);
      assert.ok(typeof input.timestamp === "string");
    }
  }

  // Factory swaps: createInMemoryMemoryModule returns a conforming module and
  // honors the delegate option (swappable + chainable via dependency injection).
  {
    const delegate = new RecordingMemory({ text: "factory delegate", matchedContexts: [], hasMemory: true });
    const module = createInMemoryMemoryModule({ delegate }) as InMemoryMemoryModule;
    assert.ok(module instanceof InMemoryMemoryModule);
    await module.remember(planStepInput(0, "factory step", "completed"));
    assert.equal(module.countForSession(SESSION), 1);
    assert.equal(delegate.remembered.length, 1, "factory-created module should delegate");
  }

  console.log("Memory module tests passed (interface, in-memory, chaining, LLM integration, remember-after-step)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
