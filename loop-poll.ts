/**
 * loop-poll.ts — loop-mode Agent Bus polling between execution steps.
 *
 * Loop mode (`--loop`, see cli-task-mode.ts) keeps the runtime alive while an
 * Agent Bus feed is watched at step boundaries. This module owns the *poll*
 * half of that supervision loop:
 *
 *   - `normalizeAgentBusMessages` turns an opaque Agent Bus GET response body
 *     into a flat list of message objects regardless of the deployment's
 *     payload shape (a bare array, `{ messages: [...] }`, `{ data: [...] }`,
 *     or a single `{ message }`/`{ data }` object).
 *   - `routeAgentBusMessages` classifies each message with loop-mode.ts and
 *     either keeps it as relevant (a reason to interrupt execution and re-plan)
 *     or enqueues it durably with loop-queue.ts so an unrelated message never
 *     disturbs the plan in flight.
 *   - `pollLoopBusOnce` orchestrates a single poll: read the feed (through an
 *     injectable `readMessages` dependency so it is unit-testable without a
 *     network), normalize, route, persist queued messages, and return the
 *     relevant messages so the caller (main.ts) can decide whether to abort the
 *     current phase and re-enter planning.
 *
 * Poll timing is configurable via the `LOOP_POLL_INTERVAL_MS` environment
 * variable and defaults to `DEFAULT_LOOP_POLL_INTERVAL_MS`. Each poll is
 * bounded by `requestTimeoutMs` so a hung bus never blocks the step loop
 * indefinitely. Missing/malformed queue files and an unreachable bus are
 * soft failures (see loop-queue.ts and tools/AgentBus.ts) so loop mode fails
 * open to normal execution rather than crashing a step boundary.
 *
 * This module is intentionally independent of any specific Agent Bus
 * deployment; callers provide the read function (main.ts wires the real
 * AgentBus client) so the classification/queuing routing is deterministic and
 * testable.
 */

import { enqueueBusMessage, readBusQueue } from "./loop-queue.js";
import { classifyAgentBusMessage, type AgentBusClassificationContext } from "./loop-mode.js";

/** Default interval between between-step bus polls when none is configured. */
export const DEFAULT_LOOP_POLL_INTERVAL_MS = 5_000;

/** Smallest allowed poll interval, to avoid an accidental hot-loop. */
export const MIN_LOOP_POLL_INTERVAL_MS = 100;

/** Default per-poll request timeout (how long one bus read may take). */
export const DEFAULT_LOOP_POLL_REQUEST_TIMEOUT_MS = 2_000;

/** One millisecond used for `setTimeout` resolves in poll-loop timing. */
const TICK_MS = 1;

/**
 * Default cap on how many consecutive idle polls a single loop-mode run may
 * perform before giving up. `0` means "wait indefinitely" (the loop keeps
 * polling until a relevant message arrives or the run is aborted). Bounding
 * it to a small positive number is mainly for tests so an idle wait cannot
 * hang the test run forever.
 */
export const DEFAULT_LOOP_MAX_IDLE_POLLS = 0;

/** Smallest allowed positive idle-poll cap, to avoid an accidental empty wait. */
export const MIN_LOOP_IDLE_POLLS = 1;

/**
 * Environment variable that overrides the loop-mode idle-poll cap. `0` or
 * unset means wait indefinitely; a positive value bounds how many idle polls
 * a run performs before stopping.
 */
export const LOOP_MAX_IDLE_POLLS_ENV = "LOOP_MAX_IDLE_POLLS";

/**
 * Resolve the idle-poll cap from an explicit value or the
 * `LOOP_MAX_IDLE_POLLS` environment variable. `0` means "wait indefinitely"
 * (the default); any positive integer is honored as a bound. Non-numeric or
 * negative values fall back to the default rather than throwing, so a
 * misconfigured environment never blocks loop mode.
 */
export function resolveLoopMaxIdlePolls(
  explicit?: number,
  env: string | undefined = process.env[LOOP_MAX_IDLE_POLLS_ENV],
): number {
  const source = explicit !== undefined ? explicit : Number(env);
  if (Number.isInteger(source) && source >= 0) {
    return source;
  }
  return DEFAULT_LOOP_MAX_IDLE_POLLS;
}

export interface ResolvedLoopPollTiming {
  readonly pollIntervalMs: number;
  readonly requestTimeoutMs: number;
}

/**
 * Resolve the poll interval and per-poll timeout from an optional explicit
 * value and the `LOOP_POLL_INTERVAL_MS`/`LOOP_POLL_REQUEST_TIMEOUT_MS`
 * environment variables. Non-numeric or out-of-range values fall back to the
 * defaults rather than throwing, so a misconfigured environment never blocks
 * loop mode.
 */
export function resolveLoopPollTiming(
  explicit?: { pollIntervalMs?: number; requestTimeoutMs?: number },
): ResolvedLoopPollTiming {
  const clamp = (value: number, min: number, fallback: number): number =>
    Number.isFinite(value) && value >= min ? Math.round(value) : fallback;

  const envInterval = Number(process.env.LOOP_POLL_INTERVAL_MS);
  const envTimeout = Number(process.env.LOOP_POLL_REQUEST_TIMEOUT_MS);

  const pollIntervalMs = explicit?.pollIntervalMs !== undefined
    ? clamp(explicit.pollIntervalMs, MIN_LOOP_POLL_INTERVAL_MS, DEFAULT_LOOP_POLL_INTERVAL_MS)
    : clamp(envInterval, MIN_LOOP_POLL_INTERVAL_MS, DEFAULT_LOOP_POLL_INTERVAL_MS);

  const requestTimeoutMs = explicit?.requestTimeoutMs !== undefined
    ? clamp(explicit.requestTimeoutMs, MIN_LOOP_POLL_INTERVAL_MS, DEFAULT_LOOP_POLL_REQUEST_TIMEOUT_MS)
    : clamp(envTimeout, MIN_LOOP_POLL_INTERVAL_MS, DEFAULT_LOOP_POLL_REQUEST_TIMEOUT_MS);

  return { pollIntervalMs, requestTimeoutMs };
}

/**
 * Sleep helper used by the polling loop between polls. Never blocks forever;
 * it resolves after the given number of milliseconds.
 */
export function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Read a single Agent Bus GET response body and reduce it to a flat array of
 * message objects. Accepts the common deployment payload shapes so the router
 * does not care whether the bus returns a bare array, a paginated wrapper, or
 * a single message object.
 *
 *   - array                   -> as-is
 *   - { messages: [...] }     -> .messages
 *   - { data: [...] }         -> .data
 *   - { message: {...} }      -> [.message]
 *   - { data: {...} }         -> [.data]
 *   - anything else           -> [] (nothing actionable, and does not throw)
 *
 * Non-array elements are dropped. The returned objects are exactly the shapes
 * handed to classifyAgentBusMessage (see loop-mode.ts), which accepts strings
 * and structured objects.
 */
export function normalizeAgentBusMessages(body: unknown): unknown[] {
  if (body === null || body === undefined) return [];
  if (Array.isArray(body)) {
    return body.filter((entry) => entry !== null && entry !== undefined);
  }
  if (typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.messages)) {
    return record.messages.filter((entry) => entry !== null && entry !== undefined);
  }
  if (Array.isArray(record.data)) {
    return record.data.filter((entry) => entry !== null && entry !== undefined);
  }
  if (record.message !== undefined && record.message !== null) return [record.message];
  if (record.data !== undefined && record.data !== null) return [record.data];
  return [];
}

export interface AgentBusMessageReadResult {
  /** Raw response body read from the bus (already normalized when available). */
  readonly body: unknown;
  /** HTTP status from the bus (0 when none was reported). */
  readonly status: number;
  /** Human-readable transport error, if the read failed (not fatal). */
  readonly error?: string;
}

/**
 * The read dependency injected into `pollLoopBusOnce`. Returning a result with
 * `error` set signals a soft transport failure: the caller should treat that
 * poll as empty (no relevant, no queued) and continue normal execution rather
 * than crashing the step boundary.
 */
export type AgentBusRead = (opts: { path: string; timeoutMs: number }) => Promise<AgentBusMessageReadResult>;

export interface RouteAgentBusMessagesOptions {
  /** Queue file path used to durably persist queued (irrelevant) messages. */
  readonly queueFilePath: string;
  /** Classification context (the current plan/task id). */
  readonly context?: AgentBusClassificationContext;
  /** Optional reporter for non-fatal diagnostics; defaults to console. */
  readonly report?: (message: string, kind?: "warn" | "info") => void;
}

export interface RouteAgentBusMessagesResult {
  /** Messages classified as relevant — candidates for interrupting the run. */
  readonly relevantMessages: readonly unknown[];
  /** How many messages were enqueued (persisted) as irrelevant this pass. */
  readonly queuedCount: number;
  /** Non-fatal diagnostics produced while routing. */
  readonly warnings: readonly string[];
}

/**
 * Classify a batch of bus messages against the current plan context and
 * persist the irrelevant ones to the durable queue. Relevant messages are
 * returned untouched (the caller decides whether to interrupt and re-plan).
 *
 * Fail-soft contract: each message is independent — a message that fails to
 * classify or persist is reported as a warning, not thrown, so one bad message
 * cannot block the step boundary.
 */
export function routeAgentBusMessages(
  messages: readonly unknown[],
  options: RouteAgentBusMessagesOptions,
): RouteAgentBusMessagesResult {
  const warnings: string[] = [];
  const relevantMessages: unknown[] = [];
  let queuedCount = 0;

  // Tolerate a malformed/missing queue at enqueue time by reading once up
  // front so a corrupt file surfaces as a warning (and enqueue re-reads it).
  {
    const existing = readBusQueue(options.queueFilePath);
    for (const w of existing.warnings) warnings.push(w);
  }

  for (const message of messages) {
    if (message === null || message === undefined) {
      warnings.push("dropped a null/undefined bus message during routing");
      continue;
    }
    try {
      const classification = classifyAgentBusMessage(message as never, options.context);
      if (classification.kind === "relevant") {
        relevantMessages.push(message);
      } else {
        try {
          enqueueBusMessage(options.queueFilePath, message);
          queuedCount += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          warnings.push(`could not persist a queued bus message: ${reason}; continuing`);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`could not classify a bus message (${reason}); treating it as queued but not persisted`);
    }
  }

  for (const w of warnings) {
    (options.report ?? ((message) => console.warn(message)))?.(w, "warn");
  }

  return { relevantMessages, queuedCount, warnings };
}

export interface PollLoopBusOnceOptions extends RouteAgentBusMessagesOptions {
  /** Agent Bus read dependency (see AgentBusRead). */
  readonly read: AgentBusRead;
  /** Deployment path to read messages from (e.g. /api/v1/messages). */
  readonly path: string;
  /** Per-poll request timeout (ms). */
  readonly requestTimeoutMs?: number;
}

export interface PollLoopBusOnceResult {
  /** Relevant messages that warrant interrupting the current phase. */
  readonly relevantMessages: readonly unknown[];
  /** How many irrelevant messages were enqueued/persisted. */
  readonly queuedCount: number;
  /** Whether the bus read itself failed (transport/unconfigured) — soft. */
  readonly readFailed: boolean;
  /** Human-readable message describing this poll's outcome for status output. */
  readonly summary: string;
  /** Non-fatal warnings from the poll (reads, classification, persistence). */
  readonly warnings: readonly string[];
}

/**
 * Perform a single between-steps poll: read the feed, normalize the payload,
 * classify every message, persist the queued ones, and report which messages
 * are relevant. This is the unit testable heart of the loop-mode poll — the
 * `read` dependency is injected so no network is required.
 */
export async function pollLoopBusOnce(options: PollLoopBusOnceOptions): Promise<PollLoopBusOnceResult> {
  const { read, path, requestTimeoutMs = DEFAULT_LOOP_POLL_REQUEST_TIMEOUT_MS } = options;
  const readResult = await read({ path, timeoutMs: requestTimeoutMs });

  const warnings: string[] = [...(readResult.error ? [`bus read failed: ${readResult.error}`] : [])];
  if (readResult.error) {
    const summary = `poll skipped (${readResult.error}); continuing normal execution`;
    return {
      relevantMessages: [],
      queuedCount: 0,
      readFailed: true,
      summary,
      warnings,
    };
  }

  const messages = normalizeAgentBusMessages(readResult.body);
  const routed = routeAgentBusMessages(messages, {
    queueFilePath: options.queueFilePath,
    context: options.context,
    report: options.report,
  });
  warnings.push(...routed.warnings);

  const summary =
    routed.relevantMessages.length > 0
      ? `poll: ${routed.relevantMessages.length} relevant message(s) warrant re-planning; ${routed.queuedCount} queued`
      : `poll: no relevant messages; ${routed.queuedCount} queued`;

  return {
    relevantMessages: routed.relevantMessages,
    queuedCount: routed.queuedCount,
    readFailed: false,
    summary,
    warnings,
  };
}

export interface PollLoopUntilMessageOptions extends PollLoopBusOnceOptions {
  /** How long to wait between idle polls (defaults to the poll interval). */
  readonly pollIntervalMs?: number;
  /**
   * Cap on consecutive idle polls. `0` (the default) means wait indefinitely
   * until a relevant message arrives or `signal` is aborted; a positive value
   * bounds the wait so tests cannot hang forever.
   */
  readonly maxIdlePolls?: number;
  /** When aborted, the idle wait stops and returns `aborted: true`. */
  readonly signal?: AbortSignal;
  /**
   * Optional callback invoked after each poll with its result, so the caller
   * can surface per-poll diagnostics (for example soft bus-read failures or
   * messages queued while idle). The callback must not throw.
   */
  readonly onPoll?: (result: PollLoopBusOnceResult, pollNumber: number) => void;
}

export interface PollLoopUntilMessageResult {
  /** True when a relevant message arrived during the idle wait. */
  readonly found: boolean;
  /** The relevant messages, when any arrived (empty otherwise). */
  readonly relevantMessages: readonly unknown[];
  /** How many polls the idle wait performed before finishing. */
  readonly polls: number;
  /** True when the wait stopped because the positive idle-poll cap was hit. */
  readonly maxIdlePollsReached: boolean;
  /** True when the wait stopped because the abort signal fired. */
  readonly aborted: boolean;
}

/**
 * Loop on the Agent Bus feed, waiting for a *relevant* message to arrive.
 *
 * This is the "keep the agent alive and keep listening" half of loop mode: it
 * repeatedly performs a single `pollLoopBusOnce` (which classifies every
 * message and durably enqueues the irrelevant ones) and sleeps `pollIntervalMs`
 * between polls. It returns as soon as one or more relevant messages arrive —
 * the caller decides whether to interrupt execution and re-plan with them.
 * Irrelevant messages arriving meanwhile are never dropped: each poll persists
 * them to the durable queue via `pollLoopBusOnce`.
 *
 * The wait is bounded by `maxIdlePolls` (`0` = unlimited) and by the optional
 * abort `signal`, so a busy run can be interrupted and a test can avoid an
 * infinite hang. Transport/unconfiguration failures are soft (each poll treats
 * them as a no-op and keeps waiting), so a temporarily unreachable bus does not
 * kill loop mode — it just keeps polling.
 */
export async function pollLoopBusUntilMessage(
  options: PollLoopUntilMessageOptions,
): Promise<PollLoopUntilMessageResult> {
  const maxIdlePolls = options.maxIdlePolls ?? DEFAULT_LOOP_MAX_IDLE_POLLS;
  const pollIntervalMs = options.pollIntervalMs ?? options.requestTimeoutMs ?? DEFAULT_LOOP_POLL_INTERVAL_MS;
  let polls = 0;

  while (true) {
    if (options.signal?.aborted) {
      return { found: false, relevantMessages: [], polls, maxIdlePollsReached: false, aborted: true };
    }
    const result = await pollLoopBusOnce(options);
    polls += 1;
    try {
      options.onPoll?.(result, polls);
    } catch {
      // A reporter must never break the idle loop.
    }
    if (result.relevantMessages.length > 0) {
      return { found: true, relevantMessages: result.relevantMessages, polls, maxIdlePollsReached: false, aborted: false };
    }
    if (maxIdlePolls > 0 && polls >= maxIdlePolls) {
      return { found: false, relevantMessages: [], polls, maxIdlePollsReached: true, aborted: false };
    }
    await sleepFor(pollIntervalMs);
  }
}
