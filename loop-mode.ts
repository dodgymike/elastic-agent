/**
 * Loop-mode classification rules.
 *
 * Loop mode (`--loop`) lets the runtime keep running while an Agent Bus feed is
 * watched between execution steps. Every bus message received at a step
 * boundary must be classified before the next step starts:
 *
 *   - A message is RELEVANT when it changes the work order in flight. It either
 *     references the current task/plan ID (so it is about this specific plan) or
 *     carries a plan-change directive (a keyword/phrase that instructs the agent
 *     to re-plan, pivot, stop, or re-prioritize the work).
 *   - Any other message is QUEUED: it is persisted for a later step (typically
 *     drained on restart) and does not interrupt the current execution.
 *
 * Classification is intentionally conservative and deterministic so it can be
 * unit-tested without a network. It is not a substitute for an LLM reading the
 * message; it is the guardrail that decides whether a message warrants
 * interrupting plan execution to re-enter the planning phase.
 *
 * This module owns only the classification rule. Queue persistence and the
 * between-step poll loop are separate concerns (loop-queue / main.ts).
 */

export type AgentBusMessageClass = "relevant" | "queued";

export interface AgentBusMessageClassification {
  /** Whether the message should interrupt execution (relevant) or be queued. */
  readonly kind: AgentBusMessageClass;
  /** Human-readable reason for the classification, for status output. */
  readonly reason: string;
}

/**
 * Fields read out of an Agent Bus message. The bus message schema varies by
 * deployment; normalization accepts either a plain string, an object with a
 * `text`/`content`/`body` field, or an object with a `body` sub-object. All
 * text is concatenated so an ID reference can live in any field.
 */
export interface AgentBusMessageLike {
  /** Raw string form of the message, if supplied directly. */
  text?: string;
  /** Structured message fields (topic, content, body, payload, ...). */
  [field: string]: unknown;
}

/**
 * The classification context: the identity of the plan/task currently in
 * flight. A message that references this ID is about our current work and is
 * therefore relevant (it may be a status update about the very plan we are
 * running, so we should surface it rather than silently queue it).
 */
export interface AgentBusClassificationContext {
  /** Current task/plan ID to watch for references (may be undefined). */
  readonly planId?: string;
  /**
   * Optional no-filter / respond-to-everything mode. When true, every message
   * is classified as RELEVANT (interrupts the agent / triggers a re-plan)
   * regardless of whether it references the current plan or carries a
   * plan-change directive. This disables the conservative relevant/queued
   * filtering so the agent responds to every bus message. Defaults to false,
   * preserving the normal filtering behavior.
   */
  readonly respondAll?: boolean;
}

/**
 * Phrases that indicate the sender is directing the agent to change its plan,
 * re-plan, stop, or re-prioritize. These are intentionally broad, case- and
 * punctuation-insensitive keyword/phrase matches. When present, the message is
 * treated as relevant even if it does not name the current plan ID.
 */
export const PLAN_CHANGE_DIRECTIVES: readonly string[] = [
  "replan",
  "re-plan",
  "plan change",
  "change the plan",
  "change of plan",
  "new plan",
  "new direction",
  "pivot",
  "redirect",
  "reprioritize",
  "re-prioritize",
  "change priority",
  "priority change",
  "cancel the plan",
  "cancel plan",
  "stop the plan",
  "abort the plan",
  "abort plan",
  "halt",
  "do not continue",
];

/**
 * Flatten an Agent Bus message into a single searchable string. Handles
 * strings, shallow objects with a text/content/body field, and a nested `body`
 * object. Non-string values (arrays, numbers) are stringified defensively.
 */
export function messageToSearchableText(message: AgentBusMessageLike): string {
  if (typeof message === "string") {
    return message;
  }
  const parts: string[] = [];
  if (typeof message.text === "string") parts.push(message.text);
  if (typeof message.content === "string") parts.push(message.content);
  if (typeof message.topic === "string") parts.push(message.topic);
  if (typeof message.status === "string") parts.push(message.status);
  if (message.body && typeof message.body === "object" && !Array.isArray(message.body)) {
    for (const value of Object.values(message.body as Record<string, unknown>)) {
      if (typeof value === "string") parts.push(value);
    }
  }
  if (parts.length === 0) {
    for (const value of Object.values(message)) {
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join(" ").trim();
}

/**
 * Normalize text for keyword matching: lower-case and collapse repeated
 * whitespace so directive phrases match regardless of case or line wrapping.
 */
export function normalizeForClassification(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Classify a bus message as relevant (interrupt execution) or queued
 * (defer). A message is relevant when:
 *   1. the no-filter / respond-to-everything mode (`context.respondAll`) is
 *      enabled — then *every* message is relevant so the agent responds to all
 *      of them instead of filtering; or
 *   2. it references the current task/plan ID, or
 *   3. it contains a plan-change directive keyword/phrase.
 * Otherwise it is queued for later processing.
 */
export function classifyAgentBusMessage(
  message: AgentBusMessageLike,
  context: AgentBusClassificationContext = {},
): AgentBusMessageClassification {
  const rawText = messageToSearchableText(message);
  const haystack = normalizeForClassification(rawText);

  // No-filter / respond-to-everything mode: every message, even a blank one,
  // is treated as relevant so nothing is ever dropped or deferred.
  if (context.respondAll === true) {
    return {
      kind: "relevant",
      reason: "no-filter mode is enabled: responding to every bus message",
    };
  }

  if (!haystack) {
    return { kind: "queued", reason: "message has no searchable text; queueing it" };
  }

  if (context.planId) {
    const normalizedPlanId = normalizeForClassification(context.planId);
    if (normalizedPlanId && haystack.includes(normalizedPlanId)) {
      return {
        kind: "relevant",
        reason: `message references the current plan/task ID '${context.planId}'`,
      };
    }
  }

  for (const directive of PLAN_CHANGE_DIRECTIVES) {
    const needle = normalizeForClassification(directive);
    if (needle && haystack.includes(needle)) {
      return {
        kind: "relevant",
        reason: `message contains a plan-change directive: "${directive}"`,
      };
    }
  }

  return {
    kind: "queued",
    reason: "message neither references the current plan/task ID nor carries a plan-change directive",
  };
}
