/**
 * loop-queue.ts — Agent Bus queue persistence and restart draining.
 *
 * Loop mode (`--loop`) classifies every bus message received at a step
 * boundary (see loop-mode.ts): a *relevant* message interrupts execution and
 * triggers a re-plan, while any other message is *queued* so it does not
 * disturb the plan in flight. This module owns the durable side of that queue:
 *
 *   - an on-disk file (default `bus-queue.json` in the project root) that
 *     persists queued messages across restarts;
 *   - atomic read/write utilities (write to a temp file then rename) so a
 *     crash mid-write never leaves a half-written queue that loses messages;
 *   - graceful handling of a missing or malformed queue file so a corrupted
 *     file never crashes startup;
 *   - a `drainBusQueue` routine that replays all pending (queued) messages in
 *     order at the start of normal execution after a restart.
 *
 * This module is intentionally independent of any Agent Bus network code: it
 * stores and replays opaque message payloads through a caller-supplied
 * handler, so it can be unit-tested without a network and wired into main.ts's
 * loop-mode startup with no I/O side effects of its own beyond the queue file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Default queue file name, resolved against the project root by default. */
export const BUS_QUEUE_FILENAME = "bus-queue.json";

/**
 * A single persisted queued bus message. The raw bus payload is stored
 * verbatim (opaque to this module) so draining can re-classify or re-route it
 * with full fidelity.
 */
export interface QueuedBusMessage {
  /** Stable id for the queued message (UUID). */
  readonly id: string;
  /** ISO-8601 timestamp of when the message was queued. */
  readonly queuedAt: string;
  /** The raw Agent Bus message payload that was queued. */
  readonly message: unknown;
}

/** Immutable snapshot of the queue read from (or pending write to) a file. */
export interface BusQueueSnapshot {
  /** Absolute or relative path the snapshot was read from / targets. */
  readonly filePath: string;
  /** Queued messages, oldest first. */
  readonly messages: readonly QueuedBusMessage[];
}

export interface ReadBusQueueResult {
  readonly filePath: string;
  /** Queued messages, oldest first. Empty when the file is missing/malformed. */
  readonly messages: readonly QueuedBusMessage[];
  /** Non-fatal diagnostics (e.g. a malformed file that was ignored). */
  readonly warnings: readonly string[];
}

/**
 * Build the default queue file path: `bus-queue.json` in the project root.
 * A designated project-root data file keeps the queue with the repo it
 * coordinates while remaining easy to relocate via a custom path.
 */
export function defaultBusQueueFilePath(projectRoot: string): string {
  return join(projectRoot, BUS_QUEUE_FILENAME);
}

/**
 * Validate a parsed-on-disk queue object. Returns the messages array when the
 * shape is usable, otherwise an error describing what is wrong. A malformed
 * file is a soft failure: startup must not crash because a coordinate queue
 * is corrupt.
 */
function validateQueuePayload(payload: unknown): { messages: readonly QueuedBusMessage[]; error?: string } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { messages: [], error: "queue payload is not an object" };
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (messages === undefined) {
    return { messages: [], error: "queue payload has no 'messages' array" };
  }
  if (!Array.isArray(messages)) {
    return { messages: [], error: "queue 'messages' field is not an array" };
  }
  // Keep only well-formed entries; tolerate (and report) individual bad rows
  // rather than discarding the whole queue because one row is corrupt.
  const valid: QueuedBusMessage[] = [];
  let dropped = 0;
  for (const entry of messages) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.queuedAt !== "string" || !("message" in e)) {
      dropped += 1;
      continue;
    }
    valid.push({ id: e.id, queuedAt: e.queuedAt, message: e.message });
  }
  return {
    messages: valid,
    error:
      messages.length === 0
        ? undefined
        : dropped > 0
          ? `skipped ${dropped} malformed queue row(s)`
          : undefined,
  };
}

/**
 * Read and parse the queue file without throwing on a missing or corrupt file.
 * A missing file is treated as an empty queue; a malformed file is treated as
 * an empty queue with a warning capturing the original error so the caller can
 * surface it and (optionally) allow manual recovery before a later write
 * replaces the corrupt content.
 */
export function readBusQueue(filePath: string): ReadBusQueueResult {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // No queue yet — an empty queue is the normal first-run case.
      return { filePath, messages: [], warnings };
    }
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`could not read bus queue '${filePath}': ${reason}; starting with an empty queue`);
    return { filePath, messages: [], warnings };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`bus queue '${filePath}' is not valid JSON (${reason}); starting with an empty queue`);
    return { filePath, messages: [], warnings };
  }

  const validated = validateQueuePayload(payload);
  if (validated.error) {
    warnings.push(`bus queue '${filePath}' ${validated.error}`);
  }
  return { filePath, messages: validated.messages, warnings };
}

/**
 * Atomically replace the queue file with the given messages. The write goes to
 * a sibling temp file on the same filesystem and is then renamed over the
 * target, so a crash between write and rename leaves either the old complete
 * file or the new complete file — never a truncated one. The parent directory
 * is created if needed.
 */
export function writeBusQueue(filePath: string, messages: readonly QueuedBusMessage[]): void {
  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify({ messages }, null, 2);
  const parent = dirname(filePath);
  if (parent && parent !== ".") {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Append a bus message to the queue and persist it. Returns the updated,
 * written snapshot. The raw message is stored verbatim alongside a fresh id
 * and timestamp so draining preserves full fidelity of the original payload.
 */
export function enqueueBusMessage(filePath: string, message: unknown): BusQueueSnapshot {
  const current = readBusQueue(filePath);
  const entry: QueuedBusMessage = {
    id: randomUUID(),
    queuedAt: new Date().toISOString(),
    message,
  };
  const messages = [...current.messages, entry];
  writeBusQueue(filePath, messages);
  return { filePath, messages };
}

export interface DrainBusQueueOptions {
  /**
   * Called once per queued message, oldest first. May be async. When a message
   * is successfully processed (the handler resolves), it is considered
   * drained; if the handler rejects, draining stops and that message (plus any
   * later ones) is kept in the queue rather than dropped.
   */
  readonly handler: (message: QueuedBusMessage, index: number) => void | Promise<void>;
}

export interface DrainBusQueueResult {
  /** Number of messages successfully replayed and removed from the queue. */
  readonly drainedCount: number;
  /** Messages not drained because the handler rejected or the queue was corrupt. */
  readonly remaining: readonly QueuedBusMessage[];
  /** Non-fatal diagnostics from reading the queue. */
  readonly warnings: readonly string[];
}

/**
 * Replay all queued messages in order at startup and clear them once handled.
 *
 * Fail-soft contract: a missing or malformed queue never crashes startup (it
 * yields zero drained messages and a warning), and a handler that rejects on a
 * message does not drop the remaining work — the offending message and the
 * ones after it are re-persisted so nothing is lost across the next restart.
 */
export async function drainBusQueue(
  filePath: string,
  options: DrainBusQueueOptions,
): Promise<DrainBusQueueResult> {
  const read = readBusQueue(filePath);
  const messages = read.messages;

  let drained = 0;
  for (let i = 0; i < messages.length; i += 1) {
    try {
      await options.handler(messages[i], i);
      drained += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const remaining = messages.slice(i);
      if (remaining.length > 0) {
        // Preserve the un-drained tail so a later restart can retry it.
        writeBusQueue(filePath, remaining);
      } else {
        writeBusQueue(filePath, []);
      }
      return {
        drainedCount: drained,
        remaining,
        warnings: [
          ...read.warnings,
          `drain stopped at message index ${i}: ${reason}; kept ${remaining.length} undrained message(s)`,
        ],
      };
    }
  }

  // All messages handled (or the queue was empty): clear the persisted queue.
  writeBusQueue(filePath, []);
  return { drainedCount: drained, remaining: [], warnings: [...read.warnings] };
}
