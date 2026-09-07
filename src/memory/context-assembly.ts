/**
 * Bounded memory context assembly (MI-09).
 *
 * Assembles a complete prompt from immutable instructions, the current user
 * request, tool definitions, conversation messages, and selected memory
 * records under a configured model capacity and output reserve. It preserves
 * the stable instruction prefix, appends the memory section after dynamic
 * request content, drops whole lower-priority records (never slicing a
 * sentence or JSON object mid-field), and reports omitted counts. Mandatory
 * material that cannot fit returns an actionable budget error before any
 * provider call.
 */

import type { RetrievedItemV2 } from "./retrieval.js";

export interface ContextAssemblyInput {
  readonly stablePrefix: string;
  readonly currentRequest: string;
  readonly toolsText: string;
  readonly conversationText: string;
  readonly memoryItems: readonly RetrievedItemV2[];
  readonly includeMemory?: boolean;
}

export interface AssembledMemoryContext {
  readonly status: "ok" | "budget-error";
  readonly text: string;
  readonly memorySection: string;
  readonly omittedCount: number;
  readonly estimatedTokens: number;
  readonly reason?: string;
}

export interface MemoryContextAssemblerOptions {
  readonly capacityTokens: number;
  readonly outputReserveTokens: number;
  readonly estimator?: (text: string) => number;
}

/** Conservative fallback: 4 characters per token. */
export function estimateTokensConservative(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function renderRecord(item: RetrievedItemV2): string {
  const record = item.record;
  const trust = record.authoritative ? "user-constraint" : record.evidence;
  return `[${record.kind}/${trust}] ${record.subject} (source ${record.sourceEventIds.join(",")}; score ${item.score.toFixed(1)})`;
}

/** Assembles memory context under an explicit token budget. */
export class MemoryContextAssembler {
  private readonly capacityTokens: number;
  private readonly outputReserveTokens: number;
  private readonly estimator: (text: string) => number;

  constructor(options: MemoryContextAssemblerOptions) {
    this.capacityTokens = options.capacityTokens;
    this.outputReserveTokens = options.outputReserveTokens;
    this.estimator = options.estimator ?? estimateTokensConservative;
  }

  assemble(input: ContextAssemblyInput): AssembledMemoryContext {
    const includeMemory = input.includeMemory !== false;
    const mandatory = `${input.stablePrefix}\n\n${input.currentRequest}\n\n${input.toolsText}\n\n${input.conversationText}`;
    const mandatoryTokens = this.estimator(mandatory);
    const available = this.capacityTokens - this.outputReserveTokens;
    if (mandatoryTokens > available) {
      return {
        status: "budget-error",
        text: mandatory,
        memorySection: "",
        omittedCount: 0,
        estimatedTokens: mandatoryTokens,
        reason: `mandatory content needs ${mandatoryTokens} tokens but only ${available} tokens remain after output reserve`,
      };
    }

    let memoryBudget = Math.max(0, available - mandatoryTokens);
    const selected: string[] = [];
    let omittedCount = 0;
    if (includeMemory) {
      // Reserve the trailing memory-section header before selecting records.
      memoryBudget = Math.max(0, memoryBudget - this.estimator("\n\n[SESSION MEMORY — scoped retrieved context]\n"));
    }
    if (includeMemory) {
      for (const item of input.memoryItems) {
        const rendered = renderRecord(item);
        const cost = this.estimator(rendered + "\n");
        if (cost <= memoryBudget) {
          selected.push(rendered);
          memoryBudget -= cost;
        } else {
          omittedCount += 1;
        }
      }
    }
    const memorySection = selected.length > 0
      ? `\n\n[SESSION MEMORY — scoped retrieved context]\n${selected.join("\n")}`
      : "";
    const text = `${mandatory}${memorySection}`;
    return {
      status: "ok",
      text,
      memorySection,
      omittedCount,
      estimatedTokens: this.estimator(text),
    };
  }
}

/** Snapshot memory/revision once per initial conversation for continuations. */
export function snapshotMemoryContext(
  result: AssembledMemoryContext,
): { readonly memorySection: string; readonly revision: string } {
  // A deterministic revision from the memory section keeps continuations stable.
  const revision = result.memorySection.length === 0 ? "empty" : `mem-${result.memorySection.length}`;
  return { memorySection: result.memorySection, revision };
}
