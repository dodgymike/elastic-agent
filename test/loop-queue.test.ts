// Unit tests for loop-queue.ts: Agent Bus queue persistence and restart
// draining. Compiled and executed standalone by the `test:loop-queue` npm
// script. Uses only the local filesystem (a temp dir) — no network — so queue
// persistence, malformed-file handling, and restart draining are exercised
// deterministically.
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUS_QUEUE_FILENAME,
  defaultBusQueueFilePath,
  readBusQueue,
  writeBusQueue,
  enqueueBusMessage,
  drainBusQueue,
  type QueuedBusMessage,
} from "../loop-queue.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

function message(id: string, text: unknown): QueuedBusMessage {
  return { id, queuedAt: new Date().toISOString(), message: text };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loop-queue-"));
  const queuePath = join(dir, BUS_QUEUE_FILENAME);
  try {
    // ------------------------------------------------------------------
    // 1. defaultBusQueueFilePath names bus-queue.json under a project root.
    // ------------------------------------------------------------------
    check("default path joins the root with bus-queue.json", defaultBusQueueFilePath("/proj") === join("/proj", "bus-queue.json"));
    check("default path uses the exported filename", defaultBusQueueFilePath("/proj").endsWith(BUS_QUEUE_FILENAME));

    // ------------------------------------------------------------------
    // 2. A missing queue file reads as an empty queue with no warnings.
    // ------------------------------------------------------------------
    {
      const read = readBusQueue(join(dir, "does-not-exist.json"));
      check("missing file yields empty messages", read.messages.length === 0);
      check("missing file yields no warnings", read.warnings.length === 0);
    }

    // ------------------------------------------------------------------
    // 3. Round-trip: write then read returns the same messages, in order.
    // ------------------------------------------------------------------
    {
      const msgs = [message("a", "hello"), message("b", { topic: "world" })];
      writeBusQueue(queuePath, msgs);
      const read = readBusQueue(queuePath);
      check("written messages round-trip in order", read.messages.length === 2);
      check("first message preserved", read.messages[0]?.id === "a" && read.messages[0]?.message === "hello");
      check(
        "second (object) message preserved",
        read.messages[1]?.id === "b" &&
          (read.messages[1]?.message as { topic?: string })?.topic === "world",
      );
      check("round-trip has no warnings", read.warnings.length === 0);
    }

    // ------------------------------------------------------------------
    // 4. Malformed JSON is handled gracefully: empty queue + a warning.
    // ------------------------------------------------------------------
    {
      const badPath = join(dir, "bad.json");
      writeFileSync(badPath, "{ not valid json !!!", "utf-8");
      const read = readBusQueue(badPath);
      check("malformed JSON yields empty queue", read.messages.length === 0);
      check("malformed JSON yields a warning", read.warnings.length > 0 && /not valid JSON/i.test(read.warnings[0]));
    }

    // ------------------------------------------------------------------
    // 5. A queue with the wrong shape is handled gracefully with a warning.
    // ------------------------------------------------------------------
    {
      const shapePath = join(dir, "bad-shape.json");
      writeFileSync(shapePath, JSON.stringify({ bogus: 123 }), "utf-8");
      const read = readBusQueue(shapePath);
      check("wrong-shape file yields empty queue", read.messages.length === 0);
      check("wrong-shape file yields a warning", /no 'messages' array/i.test(read.warnings[0] ?? ""));
    }

    // ------------------------------------------------------------------
    // 6. Individual malformed rows are dropped while valid rows survive.
    // ------------------------------------------------------------------
    {
      const rowPath = join(dir, "bad-row.json");
      const payload = {
        messages: [
          message("good1", "keep me"),
          { id: 42, queuedAt: "nope" }, // malformed row (id not a string)
          "just a string", // malformed row
          message("good2", "keep me too"),
        ],
      };
      writeFileSync(rowPath, JSON.stringify(payload), "utf-8");
      const read = readBusQueue(rowPath);
      check("valid rows survive malformed rows", read.messages.length === 2);
      check("valid row order preserved", read.messages[0]?.id === "good1" && read.messages[1]?.id === "good2");
      check("malformed rows reported as dropped", /skipped 2 malformed queue row/.test(read.warnings[0] ?? ""));
    }

    // ------------------------------------------------------------------
    // 7. enqueueBusMessage appends and persists without clobbering prior.
    // ------------------------------------------------------------------
    {
      const enqPath = join(dir, "enq.json");
      writeBusQueue(enqPath, [message("first", "one")]);
      const snap = enqueueBusMessage(enqPath, { text: "two" });
      check("enqueue appends and persists", snap.messages.length === 2);
      check("existing message preserved", snap.messages[0]?.message === "one");
      check("new message stored verbatim", (snap.messages[1]?.message as { text?: string })?.text === "two");
      check("read-back matches enqueue", readBusQueue(enqPath).messages.length === 2);
    }

    // ------------------------------------------------------------------
    // 8. drainBusQueue replays every message oldest-first, then clears it.
    // ------------------------------------------------------------------
    {
      const drainPath = join(dir, "drain.json");
      writeBusQueue(drainPath, [message("m1", "first"), message("m2", "second")]);
      const seen: string[] = [];
      const result = await drainBusQueue(drainPath, { handler: (m) => { seen.push(m.id); } });
      check("drain replayed both messages", result.drainedCount === 2);
      check("drain replayed oldest-first", seen.join(",") === "m1,m2");
      check("drain cleared remaining", result.remaining.length === 0);
      check("queue file is empty after a full drain", readBusQueue(drainPath).messages.length === 0);
      check("drain produced no warnings", result.warnings.length === 0);
    }

    // ------------------------------------------------------------------
    // 9. A handler that rejects keeps the undrained tail, does not lose work.
    // ------------------------------------------------------------------
    {
      const failPath = join(dir, "fail.json");
      writeBusQueue(failPath, [message("x1", "ok"), message("x2", "boom"), message("x3", "later")]);
      const result = await drainBusQueue(failPath, {
        handler: (m) => { if (m.id === "x2") throw new Error("handler failed"); },
      });
      check("drain stopped after the error", result.drainedCount === 1);
      check("remaining holds the failing message and later ones", result.remaining.map((m) => m.id).join(",") === "x2,x3");
      check("persisted tail matches remaining", readBusQueue(failPath).messages.map((m) => m.id).join(",") === "x2,x3");
      check("drain reported the handler failure", result.warnings.some((w) => /drain stopped at message index 1: handler failed/.test(w)));
    }

    // ------------------------------------------------------------------
    // 10. drainBusQueue on a missing/malformed queue is a benign no-op.
    // ------------------------------------------------------------------
    {
      const missingResult = await drainBusQueue(join(dir, "missing-drain.json"), { handler: () => {} });
      check("draining a missing queue yields zero drained", missingResult.drainedCount === 0);
      check("draining a missing queue yields no warnings", missingResult.warnings.length === 0);

      const malformedPath = join(dir, "malformed-drain.json");
      writeFileSync(malformedPath, "!!! not json", "utf-8");
      const malformedResult = await drainBusQueue(malformedPath, { handler: () => {} });
      check("draining a malformed queue yields zero drained", malformedResult.drainedCount === 0);
      check("draining a malformed queue yields a warning", malformedResult.warnings.length > 0);
    }

    // ------------------------------------------------------------------
    // 11. Atomic write leaves the file readable and the temp file cleaned up.
    // ------------------------------------------------------------------
    {
      writeBusQueue(queuePath, [message("atomic", "data")]);
      check("after atomic write no temp file lingers", !existsSync(`${queuePath}.tmp`));
      check("atomic-written file is valid JSON", JSON.parse(readFileSync(queuePath, "utf-8")).messages.length === 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`loop-queue test failed with ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("All loop-queue tests passed.");
}

main();
