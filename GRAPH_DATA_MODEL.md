# Durable Memory Graph Data Model

**Scope:** execution-plan step 2, *Define the graph data model*. This is a
logical model only. It deliberately does not choose a directory layout,
serialization, database, retrieval algorithm, consolidation procedure, or
write-time policy; those are later plan steps.

## Purpose and boundary

The durable-memory graph represents small, attributable statements that may be
useful in a later run. It is separate from operational run state (response IDs,
tool-call payloads, prompt history, plan checkpoints, and similar transient
execution data). The inventory established that the current `memory` value is
untyped and not read at startup; this model defines the contract a future
memory implementation must validate before it is accepted.

The graph must preserve enough context to answer:

- **What is known?** A claim or an entity/property value.
- **Why is it believed?** One or more provenance records.
- **How strongly and for how long?** Confidence, status, and temporal bounds.
- **What contradicts or supersedes it?** Explicit relationships rather than
  destructive overwrites.

It must not contain credentials, access tokens, passwords, raw private prompts,
or full raw tool responses. A later write-time policy will define detection,
redaction, and admission rules; this model makes provenance references rather
than requiring raw evidence to be embedded.

## Graph envelope

A graph is a versioned collection of four logical record kinds:

| Record kind | Role |
| --- | --- |
| `entity` node | A durable referent: project, repository, component, file, service, person/role, task, external system, or named concept. |
| `claim` node | An atomic, reviewable assertion. A claim is a node so it can carry its own provenance, confidence, status, and relationships. |
| `provenance` record | A bounded description of where a claim or entity attribute came from and when it was observed. It is referenced by IDs; it is not an unbounded transcript store. |
| `edge` | A typed, directed relationship between two nodes, including a claim-to-entity assertion or a relationship between claims. |

The envelope has a `schema_version`, a stable `graph_id`, `created_at`, and
`updated_at`. It contains collections of nodes, edges, and provenance records.
Its physical representation is intentionally unspecified.

All IDs are opaque, globally unique, and immutable. They are not derived from
display names or paths, which can change. Timestamps use UTC RFC 3339 strings.
An implementation may maintain indexes or caches, but those are derived data
and are not part of the logical graph.

## Common node fields

Every node has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Immutable opaque node identifier. |
| `kind` | `entity` or `claim`. |
| `type` | A controlled type within its kind (defined below). |
| `label` | Short human-readable display label, bounded in length. |
| `summary` | Optional concise, sanitized description; never a raw transcript. |
| `status` | `active`, `superseded`, `retracted`, or `archived`. |
| `created_at`, `updated_at` | Record lifecycle timestamps. |
| `provenance_ids` | One or more provenance records supporting the node, except explicitly imported seed entities that are marked as such. |
| `attributes` | Small typed scalar metadata whose keys are namespaced or from the controlled type definition. No arbitrary nested blobs. |

A status change retains the record and adds provenance for the change. Records
are immutable in identity, but their lifecycle metadata may be updated in a
traceable revision. Implementations must not silently delete a contradictory
claim merely because a newer one exists.

### Entity node types

Initial entity types are:

- `project`, `repository`, `component`, `file`, `service`, `environment`
- `person`, `role`, `agent`, `team`
- `task`, `goal`, `decision`, `procedure`
- `external_system`, `document`, `concept`

The type vocabulary is extensible only by adding a documented controlled type;
unknown types fail validation rather than becoming unqueryable free text.
Entity identity attributes (for example, a normalized repository remote or a
project-local task key) are optional and must be non-secret. They can be used
for deduplication but never replace the opaque `id`.

### Claim node types

A claim encodes one atomic proposition. Initial types are:

- `fact` — an observed or documented state
- `preference` — a stated working preference or convention
- `decision` — a choice and its rationale
- `constraint` — a requirement, prohibition, or invariant
- `obligation` — open work, follow-up, or commitment
- `assessment` — an inference or evaluation that remains distinguishable from
  direct observation

Each claim has a required `confidence` in the closed interval `[0, 1]`, a
required `asserted_at`, and optional `valid_from` / `valid_until` timestamps.
`asserted_at` says when the statement entered the graph; validity says when the
statement is believed to apply. A claim also has an `epistemic_basis` of
`observed`, `reported`, `inferred`, or `imported` so retrieval can distinguish
first-hand evidence from inference.

## Edges and assertion shape

An edge has immutable `id`, `type`, `from_id`, `to_id`, lifecycle timestamps,
`status`, optional `provenance_ids`, and optional bounded scalar `attributes`.
Both endpoints must exist. Self-edges are invalid unless a specific edge type
documents a need for them.

The core assertion is deliberately reified:

```text
(claim) -[about]-> (subject entity)
(claim) -[predicate { name: controlled predicate }]-> (object entity or claim)
```

For a scalar object, the `predicate` edge carries one typed `value` attribute
(string, finite number, boolean, or UTC timestamp) instead of a `to_id`.
Exactly one of `to_id` or `attributes.value` is present on `predicate`.
A `claim` must have exactly one active `about` edge and exactly one active
`predicate` edge. This form permits a fact to be independently sourced,
qualified, contradicted, or superseded without treating an edge as an opaque
unreviewable fact.

Initial relationship edge types are:

| Edge type | Allowed direction | Meaning |
| --- | --- | --- |
| `about` | claim → entity | Identifies the assertion subject. |
| `predicate` | claim → entity/claim or scalar value | States a controlled relation/property. |
| `depends_on` | entity/claim → entity/claim | The source relies on the target. |
| `implements` | entity → entity/claim | The source implements the target. |
| `related_to` | node → node | Symmetric association, stored in a canonical ID order to avoid duplicates. |
| `derived_from` | claim/entity → claim/entity | The source was distilled or inferred from the target. |
| `supports` | claim/provenance → claim | Supporting evidence. |
| `contradicts` | claim → claim | Both claims cannot simultaneously hold for the same scope and validity interval. |
| `supersedes` | claim/entity → claim/entity | The source replaces the target for an overlapping scope. |
| `scoped_to` | claim/entity → entity | Limits applicability (for example, project or environment). |

Predicates are controlled names such as `has_status`, `uses_backend`,
`requires`, `owned_by`, `located_at`, and `has_version`. Their complete
vocabulary is intentionally deferred to the retrieval/consolidation design;
new predicates must be registered and documented, not created dynamically from
prompt wording.

## Provenance records

A provenance record has `id`, `source_kind`, `observed_at`, `recorded_at`, a
sanitized `locator`, an optional bounded `excerpt_or_digest`, and optional
`source_revision`. Its source kinds are `user_statement`, `repository`,
`tool_result`, `spec_keeper`, `agent_bus`, `external_document`, and `manual`.

`locator` is a stable non-secret pointer where practical (for example a
repository-relative filename plus revision, a Spec Keeper record ID, or an
external document URL without credentials). `excerpt_or_digest` is optional,
short, and sanitized; it is evidence context, not a copy of an entire source.
Raw evidence stays in its governed source system or operational store.

A node or edge can cite multiple provenance records. Provenance is append-only
except for security remediation that removes prohibited material; removal must
leave a non-sensitive audit indication that evidence was withdrawn.

## Integrity, conflict, and lifecycle rules

1. Referenced IDs must resolve in the same graph, except a provenance locator
   may reference an external system.
2. An active claim needs at least one provenance record and its required
   assertion edges. An active edge needs provenance unless it is a structural
   `about`/`predicate` edge whose claim already cites the same evidence.
3. Only controlled node types, edge types, claim bases, statuses, and typed
   attribute values are valid. Unknown fields are rejected except declared
   extension namespaces.
4. `contradicts` never automatically retracts either endpoint. Consolidation
   can lower confidence, narrow validity, or mark one claim `superseded` only
   when it records the supporting basis.
5. `supersedes` does not imply physical deletion. The target remains available
   for provenance and historical queries, but default retrieval should prefer
   active, in-scope, non-superseded claims.
6. A claim may be scoped to multiple entities. If scopes or validity periods do
   not overlap, apparently incompatible claims can coexist.
7. Values and summaries have implementation-defined size limits that must be
   enforced at admission. The later write-time policy owns exact budgets;
   unbounded payloads are invalid now by design.
8. Secrets and sensitive personal data are prohibited from labels, summaries,
   scalar values, locators, excerpts, and attributes. The future admission
   policy must reject or redact them before graph mutation.

## Illustrative logical records

The following is conceptual notation, not a selected on-disk format:

```text
entity E-repo: { type: repository, label: "elastic-agent", status: active }
entity E-runtime: { type: component, label: "main2.js", status: active }
claim C-memory-read: {
  type: fact,
  label: "Memory file is not loaded at startup",
  confidence: 1.0,
  epistemic_basis: observed,
  status: active
}
edge C-memory-read -[about]-> E-runtime
edge C-memory-read -[predicate { name: "does_not", value: "load durable memory at startup" }]-> scalar
provenance P-inventory: {
  source_kind: repository,
  locator: "MEMORY_INVENTORY.md",
  observed_at: "<inventory timestamp>"
}
C-memory-read.provenance_ids = [P-inventory]
```

This example is not a request to populate a graph from current operational
history, and it does not prescribe a serializer.

## Deferred decisions

The following belong to later steps and are intentionally not settled here:

- Step 3: physical file layout, canonical serialization, migration/versioning
  mechanics, and indexes.
- Step 4: retrieval ranking, query language, consolidation algorithms, and the
  full predicate vocabulary.
- Step 5: admission thresholds, exact length/size budgets, secret detection,
  redaction, retention, and mutation authorization.
- Step 6: storage adapters, schema validators, and tooling interfaces.

## Acceptance criteria for this step

- The model distinguishes stable entities from assertions about them.
- Assertions, relationships, provenance, confidence, temporal applicability,
  status, contradiction, and supersession have explicit representations.
- Integrity rules support validation before persistence.
- The model excludes operational state and raw sensitive evidence.
- No physical storage format or retrieval/write policy has been selected.
