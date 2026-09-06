/**
 * Optional live-model memory quality evaluation (MI-15).
 *
 * This script is separately opted in and is never part of the default offline
 * test run. It requires explicit provider configuration (`LLM_PROVIDER` plus
 * the selected provider's documented environment variables, for example
 * `OPENAI_API_KEY`) and a finite request budget. It uses the same synthetic
 * scenario shape as the deterministic regression suite: a scoped, structured
 * projection with an authoritative constraint and an open task.
 *
 * Reported categories:
 *  - deterministic correctness  : not judged here (see the offline suite);
 *  - measured efficiency        : token/cache observations from the adapter;
 *  - model-dependent quality    : task success, unsupported-claim mentions,
 *                                 and repeated-run variance;
 *  - skipped / failed           : reported honestly, never silently a pass.
 *
 * A live provider failure exits nonzero so it can never be counted as a pass.
 *
 * Run explicitly with: npm run memory:evaluate-live
 */

import {
  createRuntimeLlmAdapter,
  resolveRuntimeLlmModel,
} from "../llm/application.js";
import type { GenerateResponse, TokenUsage } from "../llm/adapter-contract.js";
import {
  buildEventEnvelope,
  type MemoryEventAppendV2,
  type MemoryIdentityV2,
  type MemoryScopeV2,
} from "../memory/contracts-v2.js";
import { buildStructuredProjection } from "../memory/structured-records.js";
import { retrieveRelevantRecords } from "../memory/retrieval.js";

interface LiveScenario {
  readonly name: string;
  readonly prompt: string;
  /** The open task the model must name for `taskSuccess` to be true. */
  readonly requiredSubject: string;
  /** Subjects not present in the scenario; naming them counts as unsupported. */
  readonly forbiddenSubjects: readonly string[];
}

interface LiveRunRecord {
  readonly run: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly taskSuccess: boolean;
  readonly unsupportedClaimMentions: number;
  readonly responseText: string;
}

function buildScenarios(): LiveScenario[] {
  const scope: MemoryScopeV2 = {
    workspaceId: "ws-live-model-quality",
    principalId: "principal-live-model-quality",
    sessionId: "session-live-model-quality",
  };
  const identity: MemoryIdentityV2 = { ...scope, runId: "run-live-model-quality" };
  const append = (eventId: string, overrides: Partial<MemoryEventAppendV2> = {}): MemoryEventAppendV2 => ({
    eventId,
    identity,
    runRef: "run-live-model-quality",
    kind: "observation",
    payload: { eventId },
    timestamp: "2024-01-01T00:00:00.000Z",
    ...overrides,
  });

  const events = [
    buildEventEnvelope(append("evt-c1", {
      kind: "constraint",
      outcome: { asserted: "completed", verification: "verified" },
      payload: { structured: { recordKind: "constraint", subject: "do not share user data", authoritative: true } },
    }), 1, "2024-01-01T00:00:00.000Z"),
    buildEventEnvelope(append("evt-o1", {
      kind: "observation",
      payload: { openTasks: ["finish memory rollout"] },
    }), 2, "2024-01-01T00:00:00.000Z"),
    buildEventEnvelope(append("evt-f1", {
      kind: "fact",
      outcome: { asserted: "completed", verification: "verified" },
      payload: { structured: { recordKind: "fact", subject: "retrieval baseline v1", tags: ["retrieval"] } },
    }), 3, "2024-01-01T00:00:00.000Z"),
  ];

  const projection = buildStructuredProjection(scope, events);
  const retrieval = retrieveRelevantRecords(scope, projection.records, {
    scope,
    queryText: "what remains open",
    limit: 5,
  });
  const contextText =
    retrieval.status === "ok"
      ? retrieval.items
          .map((item) => `[${item.record.kind}] ${item.record.subject} (${item.record.evidence})`)
          .join("\n")
      : "";

  return [
    {
      name: "open-work-recall",
      prompt:
        "Given the following scoped memory context, list the open tasks and the authoritative constraints. " +
        "Answer with the exact subjects, one per line.\n\n" +
        `Memory context:\n${contextText}`,
      requiredSubject: "finish memory rollout",
      forbiddenSubjects: ["delete all user data"],
    },
  ];
}

function countMentions(text: string, subjects: readonly string[]): number {
  const normalized = text.toLowerCase();
  let count = 0;
  for (const subject of subjects) {
    if (normalized.includes(subject.toLowerCase())) count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  const provider = process.env.LLM_PROVIDER?.trim();
  if (!provider) {
    console.log(
      JSON.stringify({
        status: "skipped",
        reason: "LLM_PROVIDER is not configured; the offline evaluation remains authoritative",
      }),
    );
    return;
  }

  const rawRuns = Number.parseInt(process.env.MEMORY_EVAL_RUNS ?? "2", 10);
  const runs = Math.max(1, Math.min(Number.isFinite(rawRuns) ? rawRuns : 2, 5));

  try {
    const model = resolveRuntimeLlmModel({ envFile: false });
    const adapter = await createRuntimeLlmAdapter({ envFile: false });
    const scenarios = buildScenarios();
    const records: LiveRunRecord[] = [];

    for (let run = 1; run <= runs; run += 1) {
      const scenario = scenarios[0];
      if (!scenario) continue;
      const response: GenerateResponse = await adapter.generate({
        model: model.model,
        messages: [
          { role: "system", content: [{ type: "text", text: "You answer memory-recall questions exactly." }] },
          { role: "user", content: [{ type: "text", text: scenario.prompt }] },
        ],
        maxOutputTokens: 256,
        temperature: 0,
      });
      const text = response.message.content.map((part) => part.text).join("\n");
      const usage: TokenUsage | undefined = response.usage;
      records.push({
        run,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
        cachedInputTokens: usage?.cachedInputTokens,
        taskSuccess: text.toLowerCase().includes(scenario.requiredSubject.toLowerCase()),
        unsupportedClaimMentions: countMentions(text, scenario.forbiddenSubjects),
        responseText: text,
      });
    }

    const texts = records.map((record) => record.responseText);
    const identicalText = new Set(texts).size === 1;
    console.log(
      JSON.stringify(
        {
          status: "completed",
          provider: model.provider,
          model: model.model,
          runs,
          records: records.map((record) => ({
            run: record.run,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            totalTokens: record.totalTokens,
            cachedInputTokens: record.cachedInputTokens,
            taskSuccess: record.taskSuccess,
            unsupportedClaimMentions: record.unsupportedClaimMentions,
          })),
          repeatedRunVariance: { identicalText, textLengths: texts.map((text) => text.length) },
          notes: [
            "unsupportedClaimMentions is a conservative keyword heuristic, not a human judge.",
            "cachedInputTokens is provider-reported; a missing value means the provider did not report it.",
          ],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
