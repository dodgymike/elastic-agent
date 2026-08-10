# Durable Memory Adoption and Migration Gate

**Scope:** execution-plan step 8, *Document adoption and migration*. This
records the adoption decision after the representative-workflow evaluation in
[`MEMORY_WORKFLOW_EVALUATION.md`](MEMORY_WORKFLOW_EVALUATION.md). It is a
release gate and a future migration outline, **not** an implementation plan or
authorization to connect the local prototype to the runtime.

## Current decision: no adoption or migration

The durable-memory prototype is **local-only**. Do not wire it into
`main2.js`, configure it as a runtime memory provider, load it on startup,
write production graph data with it, import the existing memory value, or
promote its output into prompts or operational decisions.

The evaluation found material contract failures in the prototype's retrieval
and consolidation behavior. Consequently, there is no approved production
rollout, pilot, automatic conversion, or manual migration path at this time.
The existing persistence behavior described in
[`MEMORY_WORKFLOW.md`](MEMORY_WORKFLOW.md) remains separate from the proposed
durable-memory layout; it is neither an input nor a target of this step.

## Blocking gaps

Adoption and migration are blocked until all of the following are corrected
and verified with representative executable fixtures:

1. **Lifecycle-aware historical retrieval:** `review` must be able to retrieve
   a superseded claim and its successor where relevant. The current prototype
   filters to active claims before considering intent.
2. **Conflict-complete retrieval under budget:** a selected conflict endpoint
   must bring its contradictory companion within the result budget, or both
   must appear in one complete conflict card. Listing an omitted companion ID
   is insufficient.
3. **Scope- and validity-aware consolidation:** assertion grouping must include
   normalized scope sets and validity intervals. Claims that apply to disjoint
   environments or periods must coexist and must not receive an incorrect
   supersession proposal.
4. **Conflict detection and review output:** incompatible overlapping active
   claims and explicit `contradicts` edges must be retained and produce a
   bounded review finding. Consolidation must not silently choose an endpoint.

These are correctness requirements from
[`MEMORY_RETRIEVAL_AND_CONSOLIDATION.md`](MEMORY_RETRIEVAL_AND_CONSOLIDATION.md),
not optional hardening. The evaluation documents the observed failures and
passes in detail.

## Preconditions before reconsidering adoption

A later, separately authorized implementation effort may reconsider adoption
only after it has:

- corrected the four blocking behaviors above without weakening graph,
  provenance, write-policy, or fail-closed invariants;
- added and passed deterministic fixtures for lifecycle history, conflict cards
  under tight budgets, disjoint and overlapping scopes/validity, explicit
  contradiction review findings, authoritative replacement, provenance
  preservation, dependency/constraint ordering, and rejected-candidate
  no-mutation behavior;
- verified that storage/replay, authorization, sensitive-data gates, retention,
  locking, checkpoint recovery, and audit handling meet the selected model,
  layout, and policy contracts;
- defined and tested an operator-owned migration tool that is offline,
  explicit, idempotent, dry-run capable, rollback-safe, and produces only
  sanitized audit records; and
- obtained explicit project-governance approval for any runtime integration,
  project scope, operators, and monitoring/rollback criteria.

Passing only local prototype fixtures does not satisfy these prerequisites.

## Future migration constraints (not authorized now)

If a future approved effort creates a migration tool, it must treat all legacy
memory and runtime state as untrusted candidate evidence, not as graph records
or instructions. It must not read, parse, or import `data.json`. It must also
not infer durable claims from response IDs, tool payloads, prompt history,
plan checkpoints, or other operational state.

Any candidate conversion must follow the write-time policy:

1. Take an operator-selected, access-controlled source snapshot and record a
   non-sensitive source identity/digest outside the graph content.
2. Sanitize and reject prohibited content before graph parsing, audit detail,
   or quarantine retention. Never copy secrets, raw prompts, raw tool output,
   credentials, or unsafe locators.
3. Convert only bounded, atomic, project-scoped candidates with admissible
   provenance, controlled predicates, appropriate scope/validity, and an
   identified actor/approval path.
4. Present a deterministic dry-run report containing counts, bounded reason
   codes, affected opaque IDs, and review-required candidates—never raw
   rejected content.
5. Require explicit operator approval of the exact safe proposal digest;
   commit atomically to a new graph generation, validate/replay it, and retain
   a sanitized audit outcome.
6. Leave the source untouched. On failure, keep the active graph generation
   unchanged and do not fall back to partial conversion.

This section defines safety constraints for future work only. It does not
create a migration command, select a legacy source, or authorize any import.

## Adoption evidence and rollback expectations

Before a future rollout decision, the owner must establish success measures for
retrieval relevance, conflict visibility, false-supersession prevention,
write-policy rejections, storage failures, and operator review volume. The
rollout proposal must name a private per-project storage root, authorized
actors, observability that excludes sensitive content, an immediate disable
mechanism, and a recovery procedure that returns to the previously validated
manifest generation without deleting evidence.

Until those prerequisites and the blocking gaps are resolved, the only valid
status is: **prototype retained for local development and evaluation; no
runtime adoption and no migration.**

## Coordination note

Spec Keeper synchronization remains blocked: the documented root-relative
routes (`/goals`, `/tasks`, and `/handoffs`) returned `404 Not Found` during
this step, and Agent Bus was unavailable because no `AGENT_BUS_BASE_URL` was
configured. Once the correct coordination service origin/routes are restored,
record this gate, the four blockers, task status, and a completion handoff in
Spec Keeper. This repository document is a handoff aid, not a substitute for
that authoritative state.
