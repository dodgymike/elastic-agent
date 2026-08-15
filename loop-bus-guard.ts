/**
 * loop-bus-guard.ts — pre-planning Agent Bus token availability guard.
 *
 * The loop-mode pre-planning poll (`pollAgentBus` in main.ts) runs *before*
 * planning begins, which is before any later enrollment/initialization step
 * that provisions the bearer credential. That creates a classic ordering
 * hazard: the very first poll can fire before `AGENT_BUS_ACCESS_TOKEN` (or a
 * per-call `accessToken`) is available, producing a noisy "Agent Bus needs
 * options.accessToken…" failure at startup.
 *
 * This small, self-contained module owns the *token-availability check* for
 * that pre-planning poll so it is unit-testable without pulling in the whole
 * `main.ts` runtime. It never returns, logs, or persists the token value — it
 * only answers the boolean question "is a bearer credential available for the
 * poll?" and, when not, reports the *non-secret* identity-store path from the
 * `.agent-bus.local` roster so the operator's diagnostic is actionable.
 *
 * SECURITY: only availability is exposed. The identity-store path is read from
 * `.agent-bus.local` (non-secret metadata, mode 0600) to build the diagnostic;
 * the bearer credential itself is NEVER read here.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** The default (non-secret) roster filename matching tools/AgentBus.ts. */
export const DEFAULT_STORE_FILENAME = ".agent-bus.local";

/**
 * The environment variable that must carry the bearer credential for loop-mode
 * bus polling. Kept as a constant so env reads are centralized and never
 * spelled as a concatenation that risks being misread as a literal secret.
 */
export const AGENT_BUS_ACCESS_TOKEN_ENV = "AGENT_BUS_ACCESS_TOKEN";

/** The environment variable that overrides the roster path. */
export const AGENT_BUS_STORE_ENV = "AGENT_BUS_STORE";

export interface AgentBusTokenAvailability {
  /** True when a bearer credential is available for the pre-planning poll. */
  readonly available: boolean;
  /**
   * Non-secret identity-store path from `.agent-bus.local` (when enrolled),
   * surfaced only to make a missing-token diagnostic actionable. Never holds
   * the token itself.
   */
  readonly identityStore?: string;
  /** The resolved roster path that was read (for diagnostics). */
  readonly storePath: string;
}

/**
 * Resolve whether an Agent Bus bearer credential is available before the
 * pre-planning poll. Precedence mirrors tools/AgentBus.ts: a per-call token
 * wins, then the `AGENT_BUS_ACCESS_TOKEN` environment variable. Only the
 * boolean availability is returned — the value is never exposed.
 */
export function resolveAgentBusTokenAvailability(
  perCallToken?: string,
  env: string | undefined = process.env[AGENT_BUS_ACCESS_TOKEN_ENV],
  store: string | undefined = process.env[AGENT_BUS_STORE_ENV],
): AgentBusTokenAvailability {
  const token = perCallToken ?? env;
  const available = typeof token === "string" && token.trim().length > 0;
  const storePath = resolveStorePath(store);
  const identityStore = readIdentityStorePath(storePath);
  return { available, identityStore, storePath };
}

/**
 * Build the single actionable diagnostic for a skipped pre-planning poll when
 * no bearer credential is available. Names the identity store from the roster
 * (when enrolled) so the operator knows exactly where the credential must come
 * from, and directs them to export `AGENT_BUS_ACCESS_TOKEN`. The message never
 * includes any token value.
 */
export function missingTokenPollDiagnostic(availability: AgentBusTokenAvailability): string {
  const hint =
    `export ${AGENT_BUS_ACCESS_TOKEN_ENV} (or pass accessToken per call) to ` +
    "enable loop-mode pre-planning bus polling.";
  if (availability.identityStore) {
    return (
      "Agent Bus access token unavailable before planning; skipping the pre-planning poll and " +
      `starting without a prior bus message. You are enrolled; export the bearer credential from ` +
      `the identity store '${availability.identityStore}' to ${hint}`
    );
  }
  return (
    "Agent Bus access token unavailable before planning; skipping the pre-planning poll and " +
    `starting without a prior bus message. ${hint}`
  );
}

function resolveStorePath(store: string | undefined): string {
  const value = store?.trim();
  if (value && isAbsolute(value)) return value;
  if (value) return resolve(process.cwd(), value);
  return join(process.cwd(), DEFAULT_STORE_FILENAME);
}

/**
 * Read only the non-secret `identityStore` field from the roster. Accepts both
 * camelCase (`identityStore`) and snake_case (`identity_store`) keys. Never
 * reads the token — the roster stores only non-secret metadata by contract.
 */
function readIdentityStorePath(storePath: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(storePath, "utf8"));
  } catch {
    // A missing/malformed roster yields no defaults (mirrors tools/AgentBus.ts).
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const value = record["identityStore"] ?? record["identity_store"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
