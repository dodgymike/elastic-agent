// Integration tests for loop mode (`--loop`): the end-to-end behavior that
// combines the loop-mode classification rule (loop-mode.ts), the durable bus
// queue (loop-queue.ts), and the re-planning decision (loop-replan.ts).
//
// Unlike the module-scoped unit tests (loop-mode / loop-queue / loop-replan
// already cover each in isolation), this file exercises the loop-mode contract
// as a whole: a bus message is classified as RELEVANT or QUEUED, irrelevant
// messages are persisted to and replayed from the queue file (including
// draining on restart), and a relevant message triggers a re-plan prompt via
// the replan pipeline.
//
// The Agent Bus is MOCKED: the poll's `read` dependency is injected (as
// pollLoopBusOnce already allows) and classification/queue/replan functions
// are called directly, so no network is ever touched. Compiled and executed
// standalone by the `test:loop-mode` npm script.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_QUEUE_FILENAME, enqueueBusMessage, readBusQueue, drainBusQueue } from "../loop-queue.js";
import { classifyAgentBusMessage, type AgentBusMessageLike } from "../loop-mode.js";
import { pollLoopBusOnce, type AgentBusRead } from "../loop-poll.js";
import { extractReplanPrompt, decideSafeReplan, type ReplanSafetyChecks } from "../loop-replan.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

/** Read the raw queued message payloads currently on disk, oldest first. */
function readQueuedPayloads(filePath: string): unknown[] {
  try {
    return readBusQueue(filePath).messages.map((m) => m.message);
  } catch {
    return [];
  }
}

/** A fake Agent Bus read that returns the supplied body once. */
function fakeRead(body: unknown, error?: string): AgentBusRead {
  return async () => ({ body, status: error ? 0 : 200, error });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-mode-"));
  const queuePath = join(dir, BUS_QUEUE_FILENAME);
  try {
    // =================================================================
    // A. Classification: relevant vs. queued (loop-mode.ts).
    // =================================================================
    {
      const relevant = classifyAgentBusMessage({ text: "please replan and pivot the scope" }, { planId: "TASK-1" });
      check("plan-change directive classifies as relevant", relevant.kind === "relevant");

      const idRef = classifyAgentBusMessage("Update me on TASK-1 status" as unknown as AgentBusMessageLike, { planId: "TASK-1" });
      check("message referencing the current plan ID is relevant", idRef.kind === "relevant");

      const queued = classifyAgentBusMessage({ text: "just a status note; observe and log it" }, { planId: "TASK-1" });
      check("message with no plan reference/directive is queued", queued.kind === "queued");
    }
    {
      // =================================================================
      // No-filter / respond-to-everything mode (respondAll): EVERY message is
      // classified as relevant, so nothing is ever deferred or dropped.
      // =================================================================
      const noIdBlank = classifyAgentBusMessage(
        "a casual remark with no plan reference and no directive" as unknown as AgentBusMessageLike,
        { planId: "TASK-1", respondAll: true },
      );
      check("no-filter: message with no plan reference is relevant", noIdBlank.kind === "relevant");

      const blank = classifyAgentBusMessage({ text: "" }, { planId: "TASK-1", respondAll: true });
      check("no-filter: an otherwise-blank message is still relevant", blank.kind === "relevant");

      const structured = classifyAgentBusMessage(
        { topic: "general chatter", body: { note: "nothing actionable" } },
        { planId: "TASK-1", respondAll: true },
      );
      check("no-filter: structured non-directive message is relevant", structured.kind === "relevant");

      // Default mode must remain unchanged: the same message without respondAll
      // is queued, preserving the prior filtering behavior.
      const defaultNoId = classifyAgentBusMessage(
        "a casual remark with no plan reference and no directive" as unknown as AgentBusMessageLike,
        { planId: "TASK-1" },
      );
      check("default (no respondAll): same message is queued, not relevant", defaultNoId.kind === "queued");
    }

    // =================================================================
    // B. Queue save/load + enqueue (loop-queue.ts) with mocked bus.
    // =================================================================
    {
      // Through the poll, an irrelevant message should be persisted to disk.
      const result = await pollLoopBusOnce({
        read: fakeRead({ messages: [{ text: "hello there, no directive" }] }),
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        context: { planId: "TASK-2" },
      });
      check("irrelevant message via the poll is queued", result.queuedCount === 1);
      check("relevant list is empty", result.relevantMessages.length === 0);
      check("poll reported no read failure", result.readFailed === false);
      check("queued message was persisted", readQueuedPayloads(queuePath).length === 1);
    }
    {
      // Direct queue round-trip: write then read yields the same payload.
      const direct = enqueueBusMessage(queuePath, { text: "saved directly" });
      check("direct enqueue persists a second message", direct.messages.length === 2);
      const loaded = readBusQueue(queuePath).messages.map((m) => m.message);
      check("read back preserves enqueued payload", loaded.some((m) => (m as AgentBusMessageLike)?.text === "saved directly"));
    }
    {
      // =================================================================
      // No-filter routing through the poll: with respondAll, every message is
      // returned as relevant and NONE are dropped, so the durable queue stays
      // empty (nothing to queue) — the respond-to-everything contract.
      // =================================================================
      // Drain the leftover queued message(s) so the queue file is empty before
      // asserting the no-filter poll leaves it that way.
      await drainBusQueue(queuePath, { handler: () => {} });
      const noFilterResult = await pollLoopBusOnce({
        read: fakeRead({ data: [
          { text: "first, totally irrelevant chatter" },
          { content: "second, also not actionable" },
          { body: "third" },
        ] }),
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        context: { planId: "TASK-2", respondAll: true },
      });
      check("no-filter: all three messages are surfaced as relevant", noFilterResult.relevantMessages.length === 3);
      check("no-filter: zero messages are queued", noFilterResult.queuedCount === 0);
      check("no-filter: no message was dropped", noFilterResult.readFailed === false);
      check("no-filter: the durable queue stores nothing (none dropped)", readQueuedPayloads(queuePath).length === 0);

      // Restore the two-message queued state that the original section B left
      // behind, so the downstream draining section (C) still observes its
      // documented precondition (two queued messages) unchanged.
      await enqueueBusMessage(queuePath, { text: "the text, restored #1" });
      await enqueueBusMessage(queuePath, { text: "the text, restored #2" });
    }

    // =================================================================
    // C. Draining on restart (loop-queue.ts).
    // =================================================================
    {
      const queuedBefore = readBusQueue(queuePath).messages.length;
      const seen: string[] = [];
      const drained = await drainBusQueue(queuePath, {
        handler: (m) => {
          seen.push((m.message as AgentBusMessageLike)?.text as string);
        },
      });
      check("drain replayed every queued message", seen.length === 2);
      check("drain reports only what it replayed", drained.drainedCount === queuedBefore);
      check("drain cleared the queue file", readBusQueue(queuePath).messages.length === 0);
    }
    {
      // A handler that rejects keeps the undrained tail on disk (no loss on
      // restart) — the fail-safe part of draining.
      await enqueueBusMessage(queuePath, { text: "ok message" });
      await enqueueBusMessage(queuePath, { text: "boom message" });
      const partialFail = await drainBusQueue(queuePath, {
        handler: (m) => {
          if ((m.message as AgentBusMessageLike)?.text === "boom message") throw new Error("injected failure");
        },
      });
      check("a rejecting handler stops draining", partialFail.drainedCount === 1);
      check("the undrained tail survives on disk", readQueuedPayloads(queuePath).length === 1);
      // Clean up so later sections start from an empty queue.
      await drainBusQueue(queuePath, { handler: () => {} });
    }

    // =================================================================
    // D. Replan invocation on a relevant message (loop-replan.ts).
    // =================================================================
    {
      // In no-filter mode a received (otherwise-irrelevant) message becomes the
      // agent's next prompt via extractReplanPrompt — exactly the path main.ts
      // uses to re-enter planning with the received message instead of the
      // original command-line prompt.
      const noFilterResult = await pollLoopBusOnce({
        read: fakeRead({ data: [
          { text: "an ordinary status ping with no plan directive" },
          { content: "please also check the tests" },
        ] }),
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        context: { planId: "TASK-3", respondAll: true },
      });
      check("no-filter: each received message is surfaced as relevant", noFilterResult.relevantMessages.length === 2);
      const noFilterPrompt = extractReplanPrompt(noFilterResult.relevantMessages as { text?: string }[]);
      check(
        "no-filter: the received message becomes the new prompt (not the retained command-line prompt)",
        /ordinary status ping/.test(noFilterPrompt) && /check the tests/.test(noFilterPrompt),
      );
      check("no-filter: nothing was queued behind the prompt", noFilterResult.queuedCount === 0);
    }
    {
      // A relevant message (from the mocked poll) becomes the new prompt.
      const result = await pollLoopBusOnce({
        read: fakeRead({ data: [{ text: "please re-plan and add a verification step" }] }),
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        context: { planId: "TASK-3" },
      });
      check("plan-change message is surfaced as relevant", result.relevantMessages.length === 1);

      const prompt = extractReplanPrompt(result.relevantMessages);
      check("relevant message becomes the replan prompt", /re-plan and add a verification step/.test(prompt));
    }
    {
      // The fail-safe guard allows re-planning when the main checkout is clean.
      const clean: ReplanSafetyChecks = { mainCheckoutIsDirty: () => false, worktreeExists: () => true, worktreeHasWork: () => true };
      const safe = decideSafeReplan(clean);
      check("clean main + preserved worktree allows replanning", safe.safe === true);
      check("safety decision carries a reason", safe.reason.length > 0);

      const dirty: ReplanSafetyChecks = { mainCheckoutIsDirty: () => true };
      const blocked = decideSafeReplan(dirty);
      check("dirty main checkout blocks replanning", blocked.safe === false);
    }
    {
      // Multiple relevant messages are all folded into the new prompt, so no
      // directive in a batch is lost.
      const batch = extractReplanPrompt([
        { text: "re-plan the approach" },
        { content: "and prioritize the backend" },
      ]);
      check("batch replan prompt folds in every relevant message", /re-plan the approach/.test(batch) && /prioritize the backend/.test(batch));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`loop-mode test failed with ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("All loop-mode tests passed.");
}

main();
