/**
 * Deterministic lexical retrieval and deduplication (MI-08).
 *
 * Retrieval selects applicable explicit constraints and open-work references
 * first, ranks ordinary facts/narrative separately with a documented lexical
 * baseline, deduplicates by stable record ID and normalized fact identity, and
 * returns structured selections rather than one pre-truncated string. Final
 * prompt formatting and complete-request budget enforcement remain MI-09.
 */

import {
  type MemoryScopeV2,
} from "./contracts-v2.js";
import {
  type StructuredProjection,
  type StructuredRecordV2,
} from "./structured-records.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_CANDIDATES = 200;

export interface RelevantRetrievalRequest {
  /** Exact scope the retrieval is confined to. */
  readonly scope: MemoryScopeV2;
  /** Optional turn query text. */
  readonly queryText?: string;
  /** Optional current task/plan reference. */
  readonly currentTask?: string;
  /** Optional referenced files/symbols for exact matching. */
  readonly referencedFiles?: readonly string[];
  /** Optional output item limit (clamped). */
  readonly limit?: number;
  /** True to include superseded/retracted history; default false. */
  readonly includeHistory?: boolean;
}

export interface RetrievedItemV2 {
  readonly record: StructuredRecordV2;
  readonly score: number;
  readonly reasons: readonly string[];
}

export type RetrievalResultV2 =
  | { readonly status: "ok"; readonly items: readonly RetrievedItemV2[] }
  | { readonly status: "degraded"; readonly reason: string };

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9._/-]+/).filter((part) => part.length > 0);
}

function sameScope(a: MemoryScopeV2, b: MemoryScopeV2): boolean {
  return a.workspaceId === b.workspaceId && a.principalId === b.principalId && a.sessionId === b.sessionId;
}

/** Deduplicate and rank structured records for a retrieval request. */
export function retrieveRelevantRecords(
  scope: MemoryScopeV2,
  records: readonly StructuredRecordV2[],
  request: RelevantRetrievalRequest,
): RetrievalResultV2 {
  try {
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    const queryTerms = new Set([
      ...tokenize(request.queryText ?? ""),
      ...tokenize(request.currentTask ?? ""),
      ...(request.referencedFiles ?? []).flatMap((file) => tokenize(file)),
    ]);
    const queryTermsArray = [...queryTerms];
    const maxUpdated = records.reduce((max, record) => Math.max(max, record.updatedAtSequence), 0) || 1;

    const candidates: RetrievedItemV2[] = [];
    const seen = new Set<string>();
    for (const record of records.slice(0, MAX_CANDIDATES)) {
      if (!sameScope(scope, record.scope)) continue;
      if (!request.includeHistory && record.status !== "current") continue;

      const dedupeKeys = [record.id, `${record.kind}:${record.subject.toLowerCase()}`];
      if (dedupeKeys.some((key) => seen.has(key))) continue;

      const reasons: string[] = [];
      let score = 0;
      if (record.kind === "constraint" && record.authoritative) {
        score += 100;
        reasons.push("explicit user constraint");
      }
      if (record.kind === "open-task") {
        score += 90;
        reasons.push("open work");
      }

      const subjectTokens = new Set(tokenize(record.subject));
      const tagText = record.tags.join(" ");
      const tagTokens = new Set(tokenize(tagText));
      const exactFileMatch = (request.referencedFiles ?? []).some((file) => {
        const normalized = file.toLowerCase();
        return record.subject.toLowerCase() === normalized || tagText.toLowerCase().includes(normalized);
      });
      if (exactFileMatch) {
        score += 12;
        reasons.push("exact file/task match");
      } else {
        const matchedTerms = queryTermsArray.filter((term) => subjectTokens.has(term) || tagTokens.has(term));
        if (matchedTerms.length > 0) {
          score += Math.min(6, matchedTerms.length * 2);
          reasons.push(`matched terms: ${matchedTerms.slice(0, 3).join(", ")}`);
        }
      }

      if (record.evidence === "verified") {
        score += 5;
        reasons.push("verified evidence");
      } else if (record.evidence === "unverified") {
        score += 1;
        reasons.push("unverified evidence");
      }
      score += (record.updatedAtSequence / maxUpdated) * 5;

      candidates.push({ record, score, reasons });
      for (const key of dedupeKeys) seen.add(key);
    }

    const ordered = candidates
      .slice(0, MAX_CANDIDATES)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.record.updatedAtSequence !== a.record.updatedAtSequence) {
          return b.record.updatedAtSequence - a.record.updatedAtSequence;
        }
        return a.record.subject.localeCompare(b.record.subject);
      })
      .slice(0, limit);
    return { status: "ok", items: ordered };
  } catch (error) {
    return { status: "degraded", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Retrieve from an already-built structured projection. */
export function retrieveRelevant(
  projection: StructuredProjection,
  request: RelevantRetrievalRequest,
): RetrievalResultV2 {
  return retrieveRelevantRecords(request.scope, projection.records, request);
}
