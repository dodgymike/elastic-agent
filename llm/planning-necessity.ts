import { readFileSync } from "node:fs";
import { MultiTurnLlmRuntime, type CompatibleResponse } from "./multi-turn-runtime.js";
import { RunAbortError, throwIfAborted } from "./run-abort.js";

/**
 * Classification boundary for the no-plan fast path. Before the legacy
 * plan-then-execute flow is entered, the CLI asks the LLM whether the user
 * request genuinely needs a formal plan. This module owns that single prompt,
 * its JSON parsing, and the safe fallback back to planning.
 */

/** Prompt file loaded from the repository root, matching main.ts prompt loading. */
const PLANNING_NECESSITY_PROMPT_PATH = process.env.PLANNING_NECESSITY_PROMPT_PATH ?? "prompts/planning-necessity.prompt";

/**
 * Mirrors the existing review retry limit (3 attempts total: one initial
 * request plus two retries with the parse error appended).
 */
const MAX_PLANNING_NECESSITY_ATTEMPTS = 3;

export interface PlanningNecessityResult {
  readonly requiresPlanning: boolean;
  readonly reason: string;
}

/** The execution path selected by the planning-necessity classifier. */
export type ExecutionMode = "plan-then-execute" | "single-step";

/**
 * Map a classification result to the execution path used by main.ts. This is
 * the single routing decision point so tests can assert which flow runs for
 * each classifier outcome without booting the CLI's side-effecting main().
 */
export function selectExecutionMode(result: PlanningNecessityResult): ExecutionMode {
  return result.requiresPlanning ? "plan-then-execute" : "single-step";
}

type ParsedPlanningNecessity = { readonly valid: true; readonly result: PlanningNecessityResult } | { readonly valid: false; readonly reason: string };

/** Extract the assistant text from the legacy-compatible response shape. */
function responseText(response: CompatibleResponse): string {
  return (response.output ?? [])
    .filter((output) => output.type === "message")
    .flatMap((output) => output.content ?? [])
    .filter((item) => item.type === "output_text" || item.type === "text")
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function validatePlanningNecessity(value: unknown): ParsedPlanningNecessity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "Planning necessity response must be a JSON object." };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.requiresPlanning !== "boolean") {
    return { valid: false, reason: "requiresPlanning must be a boolean." };
  }
  if (typeof record.reason !== "string" || !record.reason.trim()) {
    return { valid: false, reason: "reason must be a non-empty string." };
  }
  return { valid: true, result: { requiresPlanning: record.requiresPlanning, reason: record.reason.trim() } };
}

/**
 * Extract a JSON object candidate from a model reply that may include prose or
 * markdown fences. Mirrors the lenient parsing used by parseReviewResult in
 * main.ts so providers that wrap JSON are still accepted.
 */
function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function parsePlanningNecessity(text: string): ParsedPlanningNecessity {
  if (!text) return { valid: false, reason: "Planning necessity response was empty." };
  const candidate = extractJsonCandidate(text);
  if (!candidate) return { valid: false, reason: "Planning necessity response did not contain a JSON object." };
  try {
    return validatePlanningNecessity(JSON.parse(candidate));
  } catch (error) {
    return { valid: false, reason: `Planning necessity JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Decide whether `userPrompt` requires the formal plan-then-execute flow.
 *
 * Reads prompts/planning-necessity.prompt, appends the user request, and asks
 * the existing multi-turn runtime once. Invalid or missing JSON is logged and
 * retried with the parse error appended (up to the existing 3-attempt limit).
 * Any failure falls back to `requiresPlanning: true` so the safer original
 * flow always runs when classification cannot be trusted.
 */
export async function determinePlanningNecessity(
  userPrompt: string,
  runtime: MultiTurnLlmRuntime,
  signal?: AbortSignal,
): Promise<PlanningNecessityResult> {
  let promptTemplate: string;
  try {
    promptTemplate = readFileSync(PLANNING_NECESSITY_PROMPT_PATH, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[PLANNING NECESSITY] Could not read ${PLANNING_NECESSITY_PROMPT_PATH}: ${reason}; falling back to planning.`);
    return { requiresPlanning: true, reason: `Planning necessity prompt file could not be read: ${reason}` };
  }

  const basePrompt = `${promptTemplate}${userPrompt}`;
  let lastFailure: string | null = null;
  const effectiveSignal = signal ?? runtime.signal;

  for (let attempt = 1; attempt <= MAX_PLANNING_NECESSITY_ATTEMPTS; attempt += 1) {
    throwIfAborted(effectiveSignal, "planning-necessity");
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nThe previous response was not valid JSON. Here's the error: ${lastFailure}. Please return valid JSON following this exact structure.`;

    let response: CompatibleResponse;
    try {
      response = await runtime.create({ input: prompt, signal: effectiveSignal, abortPhase: "planning-necessity" });
    } catch (error) {
      throwIfAborted(effectiveSignal, "planning-necessity");
      if (error instanceof RunAbortError) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      console.error(`[PLANNING NECESSITY] LLM classification request failed: ${lastFailure}; falling back to planning.`);
      break;
    }

    const text = responseText(response);
    const parsed = parsePlanningNecessity(text);
    if (parsed.valid) return parsed.result;

    lastFailure = parsed.reason;
    console.error(`[PLANNING NECESSITY] Response was not valid JSON on attempt ${attempt}/${MAX_PLANNING_NECESSITY_ATTEMPTS}: ${lastFailure}`);
  }

  return {
    requiresPlanning: true,
    reason: `Planning necessity classification fell back to planning: ${lastFailure ?? "no valid response was produced."}`,
  };
}
