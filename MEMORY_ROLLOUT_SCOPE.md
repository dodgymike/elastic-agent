# Durable Memory Rollout Scope Decision

**Scope:** execution-plan step 9, *Decide rollout scope*.

## Decision

There is **no authorized durable-memory rollout**. The rollout scope is
restricted to the existing **local-only development and evaluation prototype**
in `durable-memory/`. It is not a pilot and must not be treated as a runtime
feature.

This decision preserves the release gate in
[`MEMORY_ADOPTION_AND_MIGRATION.md`](MEMORY_ADOPTION_AND_MIGRATION.md). It does
not authorize migration, storage provisioning, legacy-memory inspection, or
changes to runtime behavior.

## Explicit scope boundaries

| Area | Decision |
| --- | --- |
| Local prototype development and deterministic fixtures | Allowed, subject to the graph model, file-layout, retrieval, and write-policy contracts. |
| Representative evaluation using isolated in-memory or fixture graphs | Allowed. It must remain non-production and use no runtime memory or legacy state. |
| `main2.js` runtime integration | Not authorized. Do not load, query, write, or inject durable-memory graph content in the runtime. |
| Production deployment | Not authorized for any project, environment, user, or agent. |
| Pilot, canary, shadow use, or operator trial | Not authorized. None may be framed as “read-only,” because retrieval output can influence decisions. |
| Existing runtime persistence described in `MEMORY_WORKFLOW.md` | Unchanged and separate. It is not a durable-memory rollout target or source. |
| Migration or import | Not authorized. In particular, do not read, parse, or import `data.json`. |
| Graph storage root, production actors, observability, and rollback operation | Not selected or provisioned, because no rollout is authorized. |

## Rationale

The representative-workflow evaluation found four correctness gaps that make
any exposure beyond local development unsafe:

1. `review` retrieval omits superseded claims before intent-aware history can be
   considered.
2. A budgeted diagnosis can omit the contradictory companion of a selected
   claim.
3. Consolidation can incorrectly propose supersession for claims with disjoint
   scope or validity.
4. Consolidation does not preserve explicit contradictions as bounded review
   findings.

These defects can hide relevant history, conceal conflicts, or create invalid
mutation proposals. Restricting the prototype to local development avoids
representing it as a source for runtime decisions while the contract is
incomplete.

## Conditions for a future scope decision

A later, separately authorized rollout decision may consider a narrowly defined
non-production scope only after the four blocking behaviors are corrected and
passed in deterministic representative fixtures, including lifecycle history,
complete conflict cards under tight budgets, normalized scope/validity-aware
consolidation, and explicit contradiction review findings. It must additionally
satisfy all adoption-gate prerequisites: fail-closed graph and write-policy
invariants, storage/replay and access controls, sensitive-data and retention
handling, locking/recovery/audit behavior, and an approved offline,
idempotent, dry-run, rollback-safe migration design if migration is proposed.

Any such decision must be recorded through project governance and name its
exact project boundary, authorized actors, private storage root, sanitized
observability, success measures, immediate disable mechanism, and recovery
procedure. Passing local fixtures alone neither authorizes a pilot nor selects
production scope.

## Coordination and handoff

Spec Keeper remains unavailable at the documented canonical routes: `/goals`,
`/task-queue`, `/tasks`, `/dependencies`, `/decisions`, `/plans`, and
`/procedures` returned `404 Not Found`. Agent Bus was also unavailable because
`AGENT_BUS_BASE_URL` was not configured. Once the correct coordination origin
or routes are restored, synchronize this decision, the local-only scope, the
four blockers, verification, final task status, and a completion handoff there.
This file is a repository handoff aid, not authoritative task state.

## Verification

This decision was checked against:

- [`MEMORY_WORKFLOW_EVALUATION.md`](MEMORY_WORKFLOW_EVALUATION.md), which
  records the representative pass/fail results;
- [`MEMORY_ADOPTION_AND_MIGRATION.md`](MEMORY_ADOPTION_AND_MIGRATION.md), which
  defines the adoption and migration release gate; and
- [`MEMORY_WORKFLOW.md`](MEMORY_WORKFLOW.md), which distinguishes the existing
  persistence primitive from durable-memory runtime behavior.
