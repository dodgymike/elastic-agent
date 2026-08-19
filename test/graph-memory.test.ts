/**
 * Focused tests for the graph-based memory module (`memory/graph-memory.ts`)
 * and its in-memory adjacency store (`memory/graph-store.ts`).
 *
 * Coverage mirrors the graph-memory module plan:
 *  1. remember() creates a plan entity node and a step claim node with the
 *     correct properties (step key, outcome, actions, reasoning).
 *  2. Repeated remember() for the same session/step updates the node instead
 *     of duplicating it (idempotent upsert).
 *  3. Consecutive steps are linked with depends_on / derived_from edges,
 *     forming a chain within the session.
 *  4. getContext() returns recent graph-derived context (summary text,
 *     provenance, hasMemory) and honors maxChars.
 *  5. Chaining: a delegate MemoryModule receives forwarded calls and its
 *     context is merged in via mergeContextResults.
 *  6. Edge cases: empty input does not throw, fail-safe behavior when the
 *     summarizer or delegate throws, and factory swapping.
 *
 * Follows the project's test conventions: plain `node:assert/strict`, a
 * `main().catch(...)` entrypoint, compiled with tsc and run with node via the
 * `test:graph-memory` script in package.json.
 */

import assert from "node:assert/strict";
import {
  GraphMemoryModule,
  createGraphMemoryModule,
  defaultChainRenderer,
  stepNodeId,
} from "../memory/graph-memory.js";
import {
  InMemoryGraphStore,
  type GraphEdge,
  type GraphNode,
} from "../memory/graph-store.js";
import type { MemorySummarizeInput, MemorySummarizer } from "../memory/inMemory.js";
import type {
  ContextRequest,
  MemoryAction,
  MemoryContext,
  MemoryContextResult,
  MemoryModule,
  MemoryOutcomeStatus,
  RememberInput,
} from "../memory/types.js";

const SESSION = "session-abc";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A recording MemoryModule used to assert chaining and delegation. */
class RecordingMemory implements MemoryModule {
  readonly remembered: RememberInput[] = [];
  readonly contextRequests: ContextRequest[] = [];
  result: MemoryContextResult;
  throwOnRemember = false;
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

/** A summarizer that records its inputs and returns a deterministic string. */
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

/** Build a realistic RememberInput for step `index` (0-based). */
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

/** All edges outgoing from a node across the store. */
function outgoingEdges(store: InMemoryGraphStore, node: GraphNode): GraphEdge[] {
  return store.edgesFrom(node.id);
}

async function main(): Promise<void> {
  /* ------------------------------------------------------------------ *
   * 1. remember() creates a plan entity node + a step claim node with the
   *    expected properties.
   * ------------------------------------------------------------------ */
  {
    const store = new InMemoryGraphStore();
    const mem = new GraphMemoryModule({ store });
    await mem.remember(planStepInput(0, "inspect repo", "completed", {
      outcomeDetail: { findings: ["tidy"] },
    }));

    assert.equal(mem.countForSession(SESSION), 1);

    // Plan entity node exists for the session.
    const plan = store.planForSession(SESSION);
    assert.ok(plan, "a plan entity node should exist");
    assert.equal(plan?.kind, "entity");
    assert.equal(plan?.type, "plan");
    assert.equal(plan?.sessionId, SESSION);
    assert.equal(plan?.status, "active");

    // Step claim node keyed by session + step index.
    const step = store.getNode(stepNodeId(SESSION, 1));
    assert.ok(step, "a step claim node should exist for step 1");
    assert.equal(step?.kind, "claim");
    assert.equal(step?.type, "fact");
    assert.equal(step?.sessionId, SESSION);
    assert.equal(step?.attributes?.stepIndex, 1);
    assert.equal(step?.attributes?.outcome, "completed");
    assert.deepEqual(step?.attributes?.actions, ["plan-step-1"]);
    assert.ok(String(step?.attributes?.outcomeDetail ?? "").includes("tidy"));
    assert.equal(step?.attributes?.reasoning, "Reasoning for step 1");
    assert.equal(step?.createdAt, "2024-01-01T00:00:00.000Z");

    // The step depends_on the plan (typed edge to the plan node).
    const stepOut = outgoingEdges(store, step as GraphNode);
    assert.ok(
      stepOut.some((e) => e.type === "depends_on" && e.toId === plan?.id),
      "step should depend_on the plan node",
    );
  }

  /* ------------------------------------------------------------------ *
   * 2. Repeated remember() for the same session/step updates the node
   *    instead of duplicating it (idempotent upsert).
   * ------------------------------------------------------------------ */
  {
    const store = new InMemoryGraphStore();
    const mem = new GraphMemoryModule({ store });
    await mem.remember(planStepInput(0, "step first pass", "completed"));
    await mem.remember(planStepInput(0, "step first pass", "failed", {
      outcomeDetail: "retry needed",
    }));

    // Still only one node for this session/step (no duplicate).
    assert.equal(mem.countForSession(SESSION), 1);
    const steps = store.stepsForSession(SESSION);
    assert.equal(steps.length, 1);

    // The node was updated in place with the new outcome and a bumped timestamp.
    const step = store.getNode(stepNodeId(SESSION, 1));
    assert.equal(step?.attributes?.outcome, "failed");
    assert.equal(step?.attributes?.outcomeDetail, "retry needed");
    assert.equal(step?.updatedAt, "2024-01-01T00:00:00.000Z");
    // createdAt is preserved across the upsert (idempotent identity).
    assert.equal(step?.createdAt, "2024-01-01T00:00:00.000Z");
  }

  /* ------------------------------------------------------------------ *
   * 3. Edges link consecutive steps / actions within a session (chain).
   * ------------------------------------------------------------------ */
  {
    const store = new InMemoryGraphStore();
    const mem = new GraphMemoryModule({ store });

    await mem.remember(planStepInput(0, "read CLAUDE.md", "completed"));
    await mem.remember(planStepInput(1, "edit config", "completed"));
    await mem.remember(planStepInput(2, "run build", "failed"));

    assert.equal(mem.countForSession(SESSION), 3);
    const steps = store.stepsForSession(SESSION);
    assert.equal(steps.length, 3);
    const [s1, s2, s3] = steps;
    const plan = store.planForSession(SESSION);
    assert.ok(plan, "plan node exists after remembering steps");
    assert.deepEqual(s1.attributes?.actions, ["plan-step-1"]);
    assert.deepEqual(s2.attributes?.actions, ["plan-step-2"]);
    assert.deepEqual(s3.attributes?.actions, ["plan-step-3"]);

    // Each step depends_on the plan.
    for (const s of steps) {
      assert.ok(
        outgoingEdges(store, s).some((e) => e.type === "depends_on" && e.toId === plan?.id),
        `step should depend_on the plan`,
      );
    }

    // Consecutive steps are linked with depends_on + derived_from edges
    // pointing at the immediately prior step.
    const linksS2 = outgoingEdges(store, s2 as GraphNode);
    assert.ok(linksS2.some((e) => e.type === "depends_on" && e.toId === s1?.id), "s2 depends_on s1");
    assert.ok(linksS2.some((e) => e.type === "derived_from" && e.toId === s1?.id), "s2 derived_from s1");

    const linksS3 = outgoingEdges(store, s3 as GraphNode);
    assert.ok(linksS3.some((e) => e.type === "depends_on" && e.toId === s2?.id), "s3 depends_on s2");
    assert.ok(linksS3.some((e) => e.type === "derived_from" && e.toId === s2?.id), "s3 derived_from s2");
  }

  /* ------------------------------------------------------------------ *
   * 4. getContext() returns recent graph-derived context.
   * ------------------------------------------------------------------ */
  {
    const store = new InMemoryGraphStore();
    const mem = new GraphMemoryModule({ store });
    await mem.remember(planStepInput(0, "inspect repo", "completed"));
    await mem.remember(planStepInput(1, "edit config", "completed"));

    const ctx = await mem.getContext({ session_id: SESSION });
    assert.equal(ctx.hasMemory, true);
    // Provenance lists the step contexts that built the summary.
    assert.equal(ctx.matchedContexts.length, 2);
    assert.ok(ctx.matchedContexts.every((c) => c.session_id === SESSION));

    // With no summarizer, the default chain renderer falls back to a readable
    // chain of steps, newest-first, and includes step labels/outcomes.
    assert.ok(ctx.text.includes("Session session-abc steps:"), "default renderer header");
    assert.ok(ctx.text.includes("[2] completed"), "renders the recent step outcome");
    assert.ok(ctx.text.includes("[1] completed"), "renders the earlier step");
  }

  // getContext() honors the maxChars budget and returns empty context for an
  // unknown session.
  {
    const store = new InMemoryGraphStore();
    const mem = new GraphMemoryModule({ store, maxChars: 20 });
    const long = "x".repeat(200);
    await mem.remember(planStepInput(0, "long step", "completed", { reasoning: long }));

    const ctx = await mem.getContext({ session_id: SESSION });
    assert.ok(ctx.hasMemory, "memory exists for the session");
    assert.ok(ctx.text.length <= 21, "respects the maxChars budget (plus ellipsis)");

    const other = await mem.getContext({ session_id: "session-other" });
    assert.equal(other.text, "");
    assert.equal(other.hasMemory, false);
    assert.deepEqual(other.matchedContexts, []);
  }

  // defaultChainRenderer standalone: empty chain renders to "" and renders
  // each node's outcome/detail/actions.
  {
    assert.equal(defaultChainRenderer([]), "", "empty chain renders empty string");
    const nodes: GraphNode[] = [
      {
        id: "n1",
        kind: "claim",
        type: "fact",
        label: "step 1: plan-step-1",
        sessionId: SESSION,
        status: "active",
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
        attributes: { stepIndex: 1, outcome: "completed", outcomeDetail: "ok", actions: ["plan-step-1"] },
      },
    ];
    const rendered = defaultChainRenderer(nodes);
    assert.ok(rendered.includes("[1] completed: ok"));
    assert.ok(rendered.includes("plan-step-1"));
  }

  /* ------------------------------------------------------------------ *
   * 5. Chaining: a delegate receives forwarded calls and its context is
   *    merged into getContext().
   * ------------------------------------------------------------------ */
  {
    const delegate = new RecordingMemory({
      text: "delegate summary",
      matchedContexts: [{ session_id: "sess-d", plan: "delegatePlan" }],
      hasMemory: true,
    });
    const store = new InMemoryGraphStore();
    const mem = new GraphMemoryModule({ store, delegate });

    await mem.remember(planStepInput(0, "step a", "completed"));

    // The graph module records locally AND forwards to the delegate.
    assert.equal(mem.countForSession(SESSION), 1);
    assert.equal(delegate.remembered.length, 1);
    assert.deepEqual(delegate.remembered[0].actions, [{ name: "plan-step-1", description: "step a" }]);

    // getContext() merges the graph-derived summary with the delegate's.
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.equal(delegate.contextRequests.length, 1);
    assert.ok(ctx.text.includes("delegate summary"), "should include the delegate summary");
    assert.ok(ctx.text.includes("Session session-abc steps:"), "should include the graph context");
    assert.ok(ctx.matchedContexts.some((c) => c.session_id === SESSION), "local provenance present");
    assert.ok(ctx.matchedContexts.some((c) => c.session_id === "sess-d"), "delegate provenance present");
  }

  // A throwing delegate is fail-safe: remember()/getContext() do not reject,
  // local graph data is preserved, and the failure is recorded on lastFailure.
  {
    const badDelegate = new RecordingMemory();
    badDelegate.throwOnRemember = true;
    badDelegate.throwOnGetContext = true;
    const store = new InMemoryGraphStore();
    const mem = new GraphMemoryModule({ store, delegate: badDelegate });

    await mem.remember(planStepInput(0, "step x", "failed"));
    assert.equal(mem.countForSession(SESSION), 1, "local remember must still succeed");
    assert.ok(mem.lastFailure?.delegateFailed, "delegate failure should be recorded");

    const ctx = await mem.getContext({ session_id: SESSION });
    assert.ok(ctx.hasMemory, "context must still reflect local graph memory");
  }

  /* ------------------------------------------------------------------ *
   * 6. Empty / fail-safe input handling.
   * ------------------------------------------------------------------ */
  {
    const mem = new GraphMemoryModule(); // no store/summarizer options, defaults
    // A minimal, empty-ish RememberInput must not throw.
    await mem.remember({
      context: { session_id: SESSION },
      actions: [],
      outcome: "unknown",
    });
    // At least one step node was created and getContext reflects it.
    assert.equal(mem.countForSession(SESSION), 1);
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.equal(ctx.hasMemory, true);
  }

  // A throwing summarizer is fail-safe: remember() still records the node and
  // surfaces the error on lastFailure, and getContext() falls back to the raw
  // chain renderer rather than rejecting.
  {
    const store = new InMemoryGraphStore();
    const badSummarizer: MemorySummarizer = async () => {
      throw new Error("summarizer boom");
    };
    const mem = new GraphMemoryModule({ store, summarizer: badSummarizer });
    await mem.remember(planStepInput(0, "step y", "completed"));
    assert.equal(mem.countForSession(SESSION), 1, "node stored despite summarizer failure");
    assert.ok(mem.lastFailure?.summarizerFailed, "summarizer failure recorded");
    const ctx = await mem.getContext({ session_id: SESSION });
    assert.ok(ctx.hasMemory, "context still returned");
  }

  /* ------------------------------------------------------------------ *
   * 7. The factory creates a conforming module with a delegate; the
   *    injected summarizer is invoked and drives the per-session summary.
   * ------------------------------------------------------------------ */
  {
    const delegate = new RecordingMemory({ text: "factory delegate", matchedContexts: [], hasMemory: true });
    const cap = new CapturingSummarizer((input) =>
      `Summary(${input.sessionId}, n=${input.entries.length})`);
    const module = createGraphMemoryModule({ delegate, summarizer: cap.fn }) as GraphMemoryModule;

    await module.remember(planStepInput(0, "factory step", "completed"));
    assert.equal(module.countForSession(SESSION), 1);
    assert.equal(delegate.remembered.length, 1, "factory-created module should delegate");
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].sessionId, SESSION);
    assert.equal(cap.calls[0].entries.length, 1);
    assert.equal(module.summaryForSession(SESSION), "Summary(session-abc, n=1)");

    // getContext() uses the summarizer-produced summary as its text when one
    // exists, plus the delegate's merged context.
    const ctx = await module.getContext({ session_id: SESSION });
    assert.ok(ctx.text.includes("Summary(session-abc, n=1)"));
    assert.ok(ctx.text.includes("factory delegate"));
  }

  // extractStepIndex semantics: when context.step is absent the module falls
  // back to step 1; a valid numeric step is respected.
  {
    const store = new InMemoryGraphStore();
    const mem = new GraphMemoryModule({ store });
    await mem.remember({
      context: { session_id: SESSION },
      actions: [{ name: "tool-a" }],
      outcome: "completed",
      timestamp: "2024-02-01T00:00:00.000Z",
    });
    const step = store.getNode(stepNodeId(SESSION, 1));
    assert.equal(step?.attributes?.stepIndex, 1, "missing step context falls back to 1");
    assert.deepEqual(step?.attributes?.actions, ["tool-a"]);
  }

  console.log("Graph memory module tests passed (nodes, upsert, chain edges, getContext, chaining, fail-safe)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
