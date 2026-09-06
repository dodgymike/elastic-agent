/**
 * Privacy and trust data-handling boundary for memory (MI-02).
 *
 * This is the single normalization/redaction surface used before persistence,
 * summarization requests, retrieval rendering, and log/error output. It:
 *
 *  - allowlists a JSON-safe, bounded shape (no bigint/cycles/functions);
 *  - redacts sensitive field names and synthetic secret patterns in strings;
 *  - rejects oversized/unserializable input with a structured diagnostic;
 *  - attaches a trust category so external/model-derived text can never become
 *    an authoritative constraint; and
 *  - verifies that new memory state paths are not symlinks and, when the leaf
 *    already exists, that it is owned by the current user.
 *
 * Regex redaction is a defense-in-depth heuristic, not a guarantee that every
 * secret is detected. Callers must still avoid writing credentials into memory
 * payloads in the first place.
 */

import { lstatSync, statSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import type { MemoryAction, MemoryContext, MemoryJsonObject, MemoryJsonValue } from "./types.js";

/** Policy revision stamped into stored memory documents. */
export const MEMORY_PRIVACY_POLICY_VERSION = 1 as const;

const DEFAULT_MAX_VALUE_CHARS = 4000;
const DEFAULT_MAX_DEPTH = 12;

/** Controlled trust categories for a remembered record. */
export type MemoryTrustCategory =
  | "user-constraint"
  | "tool-evidence"
  | "model-claim"
  | "legacy-import"
  | "external-content";

/** Provenance/trust metadata attached to a remembered record. */
export interface MemoryRecordTrust {
  /** Where the content came from. */
  readonly category: MemoryTrustCategory;
  /** Optional provenance reference (e.g. a session or event id). */
  readonly source?: string;
}

/** Options for the data-handling boundary. */
export interface MemoryPrivacyOptions {
  /** Maximum length of a retained string before it is truncated. */
  readonly maxValueChars?: number;
  /** Maximum nesting depth before the value is truncated. */
  readonly maxDepth?: number;
}

/** Structured result of applying the data-handling boundary. */
export interface MemoryPrivacyResult {
  /** True when the value was accepted (possibly redacted/truncated). */
  readonly ok: boolean;
  /** The cleaned value, or undefined when rejected. */
  readonly value: MemoryJsonValue | undefined;
  /** Number of sensitive fields/strings redacted (approximate). */
  readonly redactionCount: number;
  /** True when the value was truncated for size/depth. */
  readonly truncated: boolean;
  /** Structured reason when `ok` is false. */
  readonly reason?: string;
}

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|credential|authorization|private[-_]?key|api[-_]?key|apikey|access[-_]?key|client[-_]?secret|refresh[-_]?token)/i;

/**
 * Synthetic secret patterns used for defense-in-depth redaction. Keep these
 * narrow enough to avoid false positives on ordinary code references.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /\b(?:password|passwd|client[_-]?secret)\s*[:=]\s*[^\s"',;}]+/gi,
];

/** Error raised for unsafe memory state paths (symlink or wrong owner). */
export class UnsafeMemoryStatePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeMemoryStatePathError";
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Redact synthetic secret patterns from an arbitrary string. */
export function redactMemoryText(text: string): string {
  if (typeof text !== "string") return text;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

/**
 * Apply the full data-handling boundary to an unknown value. Returns a
 * structured result so callers can distinguish accepted, truncated, and
 * rejected values without stringifying a diagnostic into the payload.
 */
export function applyMemoryPrivacy(
  value: unknown,
  options: MemoryPrivacyOptions = {},
): MemoryPrivacyResult {
  const maxValueChars = options.maxValueChars ?? DEFAULT_MAX_VALUE_CHARS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const stats = { redactionCount: 0, truncated: false };
  const seen = new WeakSet<object>();
  let failureReason: string | undefined;

  const clean = (entry: unknown, depth: number): MemoryJsonValue | undefined => {
    if (failureReason) return undefined;
    if (depth > maxDepth) {
      stats.truncated = true;
      return undefined;
    }
    if (entry === null) return null;
    const type = typeof entry;
    if (type === "boolean" || type === "number") return entry as boolean | number;
    if (type === "string") {
      const cleaned = redactMemoryText(entry as string);
      if (cleaned !== entry) stats.redactionCount += 1;
      if (cleaned.length > maxValueChars) {
        stats.truncated = true;
        return `${cleaned.slice(0, maxValueChars)}…[truncated]`;
      }
      return cleaned;
    }
    if (type === "undefined") return undefined;
    if (type === "object") {
      if (seen.has(entry as object)) {
        failureReason = "circular value is not JSON-safe";
        return undefined;
      }
      seen.add(entry as object);
      if (Array.isArray(entry)) {
        const output: MemoryJsonValue[] = [];
        for (const item of entry) {
          const cleaned = clean(item, depth + 1);
          if (failureReason) return undefined;
          output.push(cleaned === undefined ? null : cleaned);
        }
        seen.delete(entry as object);
        return output;
      }
      const output: Record<string, MemoryJsonValue> = {};
      for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
        if (isSensitiveKey(key)) {
          output[key] = "[REDACTED]";
          stats.redactionCount += 1;
          continue;
        }
        const cleaned = clean(item, depth + 1);
        if (failureReason) return undefined;
        if (cleaned !== undefined) output[key] = cleaned;
      }
      seen.delete(entry as object);
      return output;
    }
    // bigint, symbol, function
    failureReason = `unsupported value type '${type}' is not JSON-safe`;
    return undefined;
  };

  const cleaned = clean(value, 0);
  if (failureReason) {
    return {
      ok: false,
      value: undefined,
      redactionCount: stats.redactionCount,
      truncated: stats.truncated,
      reason: failureReason,
    };
  }
  return {
    ok: true,
    value: cleaned,
    redactionCount: stats.redactionCount,
    truncated: stats.truncated,
  };
}

/**
 * Convenience wrapper returning only the cleaned value, or undefined when the
 * value was rejected. Callers that need structured diagnostics should use
 * `applyMemoryPrivacy` directly.
 */
export function sanitizeMemoryJson(
  value: unknown,
  options: MemoryPrivacyOptions = {},
): MemoryJsonValue | undefined {
  const result = applyMemoryPrivacy(value, options);
  return result.ok ? result.value : undefined;
}

const TRUST_CATEGORIES: ReadonlySet<string> = new Set<MemoryTrustCategory>([
  "user-constraint",
  "tool-evidence",
  "model-claim",
  "legacy-import",
  "external-content",
]);

/** True only for the single authoritative category: user-authorized constraints. */
export function isAuthoritativeTrust(trust?: MemoryRecordTrust): boolean {
  return trust?.category === "user-constraint";
}

/** Validate an unknown trust-category string. */
export function validateTrustCategory(value: unknown): MemoryTrustCategory {
  if (typeof value !== "string" || !TRUST_CATEGORIES.has(value)) {
    throw new Error(`trust category must be one of: ${[...TRUST_CATEGORIES].join(", ")}`);
  }
  return value as MemoryTrustCategory;
}

/**
 * Derive trust/provenance for a remembered record. Only an explicit
 * `context.context.trustCategory` of `user-constraint` is authoritative; model
 * and external text can never grant permissions, turn failures into verified
 * success, or redefine the current user request.
 */
export function deriveMemoryTrust(input: {
  readonly context?: MemoryContext;
  readonly actions?: readonly MemoryAction[];
  readonly reasoning?: string;
  readonly outcomeDetail?: MemoryJsonValue;
}): MemoryRecordTrust {
  const explicit = input.context?.context;
  if (explicit !== undefined && typeof explicit === "object" && !Array.isArray(explicit)) {
    const category = (explicit as Record<string, unknown>).trustCategory;
    if (typeof category === "string" && TRUST_CATEGORIES.has(category)) {
      return { category: category as MemoryTrustCategory, source: input.context?.session_id };
    }
  }
  const hasActions = (input.actions?.length ?? 0) > 0;
  const hasOutcome = input.outcomeDetail !== undefined;
  if (!hasActions && !hasOutcome && input.reasoning !== undefined) {
    return { category: "model-claim", source: input.context?.session_id };
  }
  if (hasActions || hasOutcome) {
    return { category: "tool-evidence", source: input.context?.session_id };
  }
  return { category: "legacy-import", source: input.context?.session_id };
}

/** Policy metadata stamped into stored memory documents. */
export function memoryPrivacyPolicyMetadata(): {
  readonly policyVersion: typeof MEMORY_PRIVACY_POLICY_VERSION;
  readonly policy: string;
} {
  return {
    policyVersion: MEMORY_PRIVACY_POLICY_VERSION,
    policy:
      "redact-before-store-summarize-render-log; only user-constraint is authoritative; tool-evidence/model-claim/legacy-import/external-content are non-authoritative",
  };
}

/**
 * Verify that a memory state path is safe to use: no existing path component
 * may be a symlink, and an existing leaf file/directory must be owned by the
 * current user. Returns the resolved absolute path.
 */
export function assertSafeMemoryStatePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new UnsafeMemoryStatePathError("memory state path must be a non-empty string");
  }
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const relative = absolute.slice(root.length);
  let cursor = root;
  for (const component of relative.split(sep).filter((part) => part.length > 0)) {
    cursor = join(cursor, component);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      continue; // missing component; deeper components cannot exist yet
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeMemoryStatePathError(`refusing symlinked memory state path component: ${cursor}`);
    }
  }
  const leaf = statSync(absolute, { throwIfNoEntry: false });
  if (leaf && typeof process.getuid === "function" && leaf.uid !== process.getuid()) {
    throw new UnsafeMemoryStatePathError(`refusing memory state path not owned by the current user: ${absolute}`);
  }
  return absolute;
}
