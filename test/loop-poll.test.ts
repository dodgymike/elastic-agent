// Focused unit tests for loop-poll.ts: the between-steps Agent Bus poll that
// reads a feed, classifies each message (loop-mode.ts), durably enqueues the
// irrelevant ones (loop-queue.ts), and surfaces any relevant messages so
// main.ts can interrupt a step loop and re-plan. The bus read is injected, so
// these tests run with no network.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_QUEUE_FILENAME } from "../loop-queue.js";
import {
  DEFAULT_LOOP_MAX_IDLE_POLLS,
  DEFAULT_LOOP_POLL_INTERVAL_MS,
  DEFAULT_LOOP_POLL_REQUEST_TIMEOUT_MS,
  MIN_LOOP_POLL_INTERVAL_MS,
  normalizeAgentBusMessages,
  pollLoopBusOnce,
  pollLoopBusUntilMessage,
  resolveLoopMaxIdlePolls,
  resolveLoopPollTiming,
  routeAgentBusMessages,
  sleepFor,
  type AgentBusRead,
} from "../loop-poll.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

function readQueued(filePath: string): unknown[] {
  return JSON.parse(readFileSync(filePath, "utf-8")).messages?.map((m: any) => m.message) ?? [];
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-poll-"));
  const queuePath = join(dir, BUS_QUEUE_FILENAME);
  try {
    // ------------------------------------------------------------------
    // 1. normalizeAgentBusMessages reduces the common payload shapes.
    // ------------------------------------------------------------------
    check("bare array passes through",
      normalizeAgentBusMessages([{ text: "a" }, "b"]).length === 2);
    check("{ messages: [...] } unwraps",
      (normalizeAgentBusMessages({ messages: [{ text: "x" }] }) as unknown[]).length === 1);
    check("{ data: [...] } unwraps",
      (normalizeAgentBusMessages({ data: [{ text: "y" }] }) as unknown[]).length === 1);
    check("{ message: {...} } wraps in an array",
      normalizeAgentBusMessages({ message: { text: "z" } }).length === 1);
    check("{ data: {...} } wraps in an array",
      normalizeAgentBusMessages({ data: { text: "w" } }).length === 1);
    check("null/undefined/scalar yield an empty list",
      normalizeAgentBusMessages(null).length === 0 &&
      normalizeAgentBusMessages("scalar").length === 0 &&
      normalizeAgentBusMessages(123).length === 0);
    check("null/undefined entries are dropped from arrays",
      normalizeAgentBusMessages([{ text: "keep" }, null, undefined]).length === 1);

    // ------------------------------------------------------------------
    // 2. resolveLoopPollTiming picks env/explicit values and clamps.
    // ------------------------------------------------------------------
    {
      const previous = process.env.LOOP_POLL_INTERVAL_MS;
      try {
        process.env.LOOP_POLL_INTERVAL_MS = "250";
        process.env.LOOP_POLL_REQUEST_TIMEOUT_MS = "800";
        const resolved = resolveLoopPollTiming();
        check("env poll interval is honored", resolved.pollIntervalMs === 250);
        check("env request timeout is honored", resolved.requestTimeoutMs === 800);
      } finally {
        if (previous === undefined) delete process.env.LOOP_POLL_INTERVAL_MS;
        else process.env.LOOP_POLL_INTERVAL_MS = previous;
        delete process.env.LOOP_POLL_REQUEST_TIMEOUT_MS;
      }
      const fallback = resolveLoopPollTiming();
      check("defaults used when nothing configured",
        fallback.pollIntervalMs === DEFAULT_LOOP_POLL_INTERVAL_MS &&
        fallback.requestTimeoutMs === DEFAULT_LOOP_POLL_REQUEST_TIMEOUT_MS);
      const explicit = resolveLoopPollTiming({ pollIntervalMs: 50, requestTimeoutMs: 1 });
      check("explicit values below the minimum are clamped",
        explicit.pollIntervalMs >= MIN_LOOP_POLL_INTERVAL_MS &&
        explicit.requestTimeoutMs >= MIN_LOOP_POLL_INTERVAL_MS);
      const nonNumeric = resolveLoopPollTiming({ pollIntervalMs: Number.NaN });
      check("non-numeric explicit values fall back to defaults",
        nonNumeric.pollIntervalMs === DEFAULT_LOOP_POLL_INTERVAL_MS);
    }

    // ------------------------------------------------------------------
    // 3. sleepFor resolves after roughly its wait (not before).
    // ------------------------------------------------------------------
    {
      const started = Date.now();
      await sleepFor(20);
      check("sleepFor waited at least its duration", Date.now() - started >= 15);
    }

    // ------------------------------------------------------------------
    // 4. routeAgentBusMessages classifies and persists irrelevant messages.
    // ------------------------------------------------------------------
    {
      const routed = routeAgentBusMessages(
        [
          { text: "please replan the current work" }, // relevant directive
          { text: "update your status feed" },         // irrelevant -> queued
          "another non-planning note",                  // irrelevant -> queued
        ],
        { queueFilePath: queuePath, context: {} },
      );
      check("plan-change directive is relevant", routed.relevantMessages.length === 1);
      check("two irrelevant messages were queued", routed.queuedCount === 2);
      check("queued messages were persisted",
        readQueued(queuePath).length === 2);
    }

    // ------------------------------------------------------------------
    // 5. routeAgentBusMessages survives malformed/null messages.
    // ------------------------------------------------------------------
    {
      const routed = routeAgentBusMessages(
        [null, undefined, { text: "re-plan the approach" }, 42, { text: "no" }],
        { queueFilePath: queuePath, context: {} },
      );
      check("null entries are dropped (reported, not thrown)",
        routed.relevantMessages.length === 1 && routed.queuedCount === 2);
    }

    // ------------------------------------------------------------------
    // 6. pollLoopBusOnce routes a successful bus read end-to-end.
    // ------------------------------------------------------------------
    {
      const read: AgentBusRead = async () => ({
        body: { messages: [{ text: "please re-plan TASK-1" }, { text: "status note" }] },
        status: 200,
      });
      const result = await pollLoopBusOnce({
        read,
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        context: { planId: "TASK-1" },
      });
      check("plan-id reference is relevant once", result.relevantMessages.length === 1);
      check("irrelevant message was queued", result.queuedCount === 1);
      check("read did not fail", result.readFailed === false);
      check("summary mentions the relevant count", /1 relevant message/.test(result.summary));
    }

    // ------------------------------------------------------------------
    // 7. pollLoopBusOnce treats a failed bus read as a soft no-op.
    // ------------------------------------------------------------------
    {
      const read: AgentBusRead = async () => ({
        body: null,
        status: 0,
        error: "Agent Bus needs options.baseUrl or AGENT_BUS_BASE_URL",
      });
      const result = await pollLoopBusOnce({
        read,
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        context: {},
      });
      check("failed read reported as soft failure", result.readFailed === true);
      check("failed read yields no relevant messages", result.relevantMessages.length === 0);
      check("failed read queues nothing", result.queuedCount === 0);
      check("failed read summary says continuing", /continuing normal execution/.test(result.summary));
    }

    // ------------------------------------------------------------------
    // 8. resolveLoopMaxIdlePolls resolves the idle-wait cap.
    // ------------------------------------------------------------------
    {
      const previous = process.env.LOOP_MAX_IDLE_POLLS;
      try {
        process.env.LOOP_MAX_IDLE_POLLS = "7";
        check("env idle-poll cap is honored", resolveLoopMaxIdlePolls() === 7);
        check("explicit exceeding env wins", resolveLoopMaxIdlePolls(3) === 3);
        check("explicit zero means unlimited", resolveLoopMaxIdlePolls(0) === 0);
      } finally {
        if (previous === undefined) delete process.env.LOOP_MAX_IDLE_POLLS;
        else process.env.LOOP_MAX_IDLE_POLLS = previous;
      }
      check("default idle-poll cap is unlimited (0)", resolveLoopMaxIdlePolls() === DEFAULT_LOOP_MAX_IDLE_POLLS);
      check("non-numeric idle-poll cap falls back to default", resolveLoopMaxIdlePolls(Number.NaN, "nope") === DEFAULT_LOOP_MAX_IDLE_POLLS);
      check("negative idle-poll cap falls back to default", resolveLoopMaxIdlePolls(-1) === DEFAULT_LOOP_MAX_IDLE_POLLS);
      check("fractional idle-poll cap falls back to default", resolveLoopMaxIdlePolls(2.5) === DEFAULT_LOOP_MAX_IDLE_POLLS);
    }

    // ------------------------------------------------------------------
    // 9. pollLoopBusUntilMessage waits for a relevant message (idle loop).
    // ------------------------------------------------------------------
    {
      // The read returns an empty feed first, then a relevant directive on the
      // second call — the idle loop must keep polling until it arrives.
      const bodies = [
        { messages: [{ text: "just a status note" }] },
        { messages: [{ text: "please replan the approach" }] },
      ];
      let calls = 0;
      let queueDuringIdle = 0;
      const result = await pollLoopBusUntilMessage({
        read: async () => ({ body: bodies[calls++], status: 200 }),
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        pollIntervalMs: 1,
        context: {},
        onPoll: (poll) => {
          queueDuringIdle += poll.queuedCount;
        },
      });
      check("idle loop found a relevant message", result.found === true);
      check("idle loop reported the relevant message", result.relevantMessages.length === 1);
      check("idle loop polled more than once", result.polls >= 2);
      // The irrelevant note arriving during the first idle poll was persisted.
      check("irrelevant message arriving while idle was queued", queueDuringIdle === 1 && readQueued(queuePath).length >= 1);
    }

    // ------------------------------------------------------------------
    // 10. pollLoopBusUntilMessage respects the maxIdlePolls bound.
    // ------------------------------------------------------------------
    {
      const result = await pollLoopBusUntilMessage({
        read: async () => ({ body: { messages: [{ text: "no directive at all" }] }, status: 200 }),
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        pollIntervalMs: 1,
        maxIdlePolls: 2,
        context: {},
      });
      check("idle loop stopped at the max idle-poll cap", result.maxIdlePollsReached === true);
      check("idle loop found nothing before the cap", result.found === false);
      check("idle loop performed the capped number of polls", result.polls === 2);
    }

    // ------------------------------------------------------------------
    // 11. pollLoopBusUntilMessage stops on an aborted signal.
    // ------------------------------------------------------------------
    {
      const controller = new AbortController();
      controller.abort();
      const result = await pollLoopBusUntilMessage({
        read: async () => ({ body: { messages: [] }, status: 200 }),
        path: "/api/v1/messages",
        queueFilePath: queuePath,
        pollIntervalMs: 1,
        signal: controller.signal,
        context: {},
      });
      check("idle loop stopped because the signal fired", result.aborted === true);
      check("aborted idle loop found nothing", result.found === false && result.relevantMessages.length === 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`loop-poll test failed with ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("All loop-poll tests passed.");
}

main();
