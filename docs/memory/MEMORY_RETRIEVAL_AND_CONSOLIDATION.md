# Durable Memory Retrieval and Consolidation Design

**Scope:** execution-plan step 4, *Design retrieval and consolidation*. This
document defines how a validated graph stored in the layout selected in
[`MEMORY_FILE_LAYOUT.md`](MEMORY_FILE_LAYOUT.md) is selected for a task and how
existing graph records are reconciled. It implements the logical invariants in
[`GRAPH_DATA_MODEL.md`](GRAPH_DATA_MODEL.md); it does not define admission,
secret detection, retention periods, mutation authorization, or storage-tool
commands.

## Goals and non-goals

Retrieval must return a small, attributable, task-relevant view rather than a
raw graph dump or an unbounded prompt transcript. It must prefer active,
well-supported, applicable information, expose material uncertainty and
conflicts, and give the caller stable reasons for each selected item.

Consolidation must make duplicate and stale information reviewable without
silently erasing contrary evidence. It is deterministic for a fixed graph,
request, and policy version, and it produces normal graph mutations that are
validated and journaled under the selected file-layout rules.

This design does not authorize any particular input to become memory. The
write-time policy (step 5) decides which proposed records can enter the graph,
how sensitive content is rejected or redacted, exact size limits, who may make
changes, and when audit data expires. The prototype (step 6) defines command
and API surfaces.

## Controlled predicate vocabulary

The initial predicate registry below is the vocabulary used by retrieval keys,
normalization, and duplicate detection. A predicate has one declared object
form: `entity_or_claim` requires a predicate edge `to_id`; `scalar` requires
its typed `attributes.value`. The **assertion subject types** describe the type
of entity at the required `about` endpoint; a claim is never itself an `about`
subject under the graph model. Predicates not in this registry fail validation.

| Predicate | Object form | Assertion subject types | Meaning |
| --- | --- | --- | --- |
| `has_status` | scalar | all entity types | Current declared status or state. |
| `has_version` | scalar | all entity types | Version identifier. |
| `located_at` | scalar | repository, component, file, service, document | Stable repository-relative or system location. |
| `uses_backend` | entity_or_claim | component, service, project | Technology or service in use. |
| `requires` | entity_or_claim | all entity types | Required dependency, constraint, or precondition. |
| `owned_by` | entity_or_claim | all entity types | Responsible person, role, team, or agent. |
| `configured_by` | entity_or_claim | component, service, environment, project | Configuration source or mechanism. |
| `implements` | entity_or_claim | component, service, procedure, task | Requirement, decision, procedure, or component implemented. |
| `governed_by` | entity_or_claim | all entity types | Applicable decision, procedure, or constraint. |
| `depends_on` | entity_or_claim | all entity types | Dependency needed by the subject. |
| `does_not` | scalar | all entity types | Explicit negative fact or prohibition. |
| `has_capability` | scalar | component, service, agent, role | Bounded capability name. |
| `has_risk` | scalar | all entity types | Bounded risk classification or description. |

The edge vocabulary remains that of the graph model. `implements` and
`depends_on` can therefore occur both as an asserted predicate and as a direct
relationship edge: the former carries a claim's confidence and provenance; the
latter expresses an independently maintained structural relationship. A future
predicate requires a documented object form, permitted subject types,
normalization rule, and retrieval aliases before it is accepted.

## Retrieval contract

A caller submits a `MemoryQuery` containing:

- `intent`: `planning`, `execution`, `review`, `diagnosis`, or `lookup`;
- a concise sanitized `task_text` and optional controlled `predicate_names`;
- zero or more known entity IDs or non-secret identity selectors;
- optional `scope_entity_ids` (project, repository, component, environment,
  task, goal, or similar entities);
- `as_of` timestamp, defaulting to retrieval time; and
- a bounded result budget: maximum claim count, maximum rendered characters,
  and maximum graph-expansion depth. The implementation defaults are set by
  write-time/runtime policy, not by this design.

A successful result is a `MemoryContext` with a `query_id`, graph identity and
replayed sequence, policy version, `as_of`, selected claim cards, supporting
entity cards, and `omissions`/`warnings`. Each card includes record IDs,
label, concise sanitized assertion, confidence, epistemic basis, status,
validity, relevant scopes, provenance locators/digests, score, and bounded
selection reasons. A claim card never embeds raw source material. The caller
can cite graph IDs when a decision needs more evidence.

Retrieval is read-only. It loads one coherent, fully validated manifest,
snapshot, and journal generation. Any corruption, unsupported version, replay
failure, or invalid graph causes a fail-closed result with no memory context;
it must not fall back to scanning unreferenced files or a legacy memory sink.
The runtime may continue without memory only if its higher-level failure policy
allows that, and must surface a bounded warning that retrieval was unavailable.

## Candidate selection

### 1. Resolve task anchors

Normalize `task_text` for matching by Unicode normalization, case folding,
whitespace collapse, and tokenization; preserve the original text for display.
Extract only controlled predicate names and registered entity-type terms.
Resolve supplied entity IDs directly. Resolve identity selectors only against
an entity's documented non-secret identity attributes; zero or multiple matches
remain unresolved rather than guessing. Exact normalized matches of entity
labels and aliases in declared attributes may add anchors. The result records
unresolved selectors as warnings.

No model-generated keyword expansion or external lookup occurs in this stage.
An implementation may add a deterministic local token index, but it is derived
from canonical records and may only produce candidates, never authority.

### 2. Apply applicability filters

Start with active claims that have a valid assertion shape and at least one
provenance record. Exclude `retracted` and `archived` claims by default.
Exclude `superseded` claims unless `intent` is `review` or the claim is needed
to explain a selected conflict or supersession. A claim is temporally applicable
when `valid_from` is absent or at/before `as_of`, and `valid_until` is absent or
after `as_of`.

A claim with no `scoped_to` edge is globally applicable. A scoped claim is
applicable when it is scoped to an anchor, a requested scope, or a scope entity
reachable from an anchor through active `scoped_to`, `depends_on`, or
`implements` edges within the requested depth. A claim scoped only to a known
disjoint environment or project is excluded. If scope cannot be resolved, keep
the claim only for `review` and label it `scope_uncertain`.

### 3. Generate and expand candidates

Seed candidates with applicable claims whose `about` subject, predicate object,
or scope is an anchor; then add applicable claims with exact normalized label,
predicate, or scalar-token matches. Expand from every seed through active
`depends_on`, `implements`, `governed_by` assertions, and direct
`derived_from`/`supports` edges, stopping at the requested depth. Never expand
through `related_to` alone; it is too weak to justify prompt inclusion.

For every candidate, retrieve only the entities and provenance records needed
to render its assertion and selection rationale. Directly contradictory claims
with overlapping scope and validity are added as conflict companions even if
they would otherwise rank below the cutoff.

### 4. Rank deterministically

For each candidate, calculate a score from bounded, documented components:

```text
score = 0.35 relevance + 0.20 confidence + 0.15 provenance_quality
      + 0.15 recency + 0.10 scope_fit + 0.05 graph_proximity - penalties
```

Each positive component is normalized to `[0, 1]`. `relevance` is an exact
match score in the order: direct entity/scope anchor, controlled predicate,
exact normalized label/identity match, then token overlap. `confidence` is the
claim field. `provenance_quality` ranks observed/repository/Spec Keeper
sources above reported, imported, and inferred sources, while retaining the
basis for display. `recency` decays monotonically from the most recent
`observed_at` or `asserted_at`, but does not override an explicit validity
range. `scope_fit` favors a direct scope match over inherited scope;
`graph_proximity` decreases with each expansion hop.

Penalties apply for stale-but-not-expired information, inferred-only support,
scope uncertainty, and a selected contradictory companion. Status filtering is
not a penalty: excluded statuses are not candidates. The implementation records
component values and policy/version in the result so ranking is reproducible.
Equal scores sort by: direct-anchor status, higher confidence, newer supporting
observation, then opaque claim ID lexicographically.

### 5. Enforce diversity and budget

Select cards in rank order while honoring all budgets. At most one primary
claim per normalized assertion key is selected, except that conflicting or
historical claims required for the requested intent are displayed in a single
conflict card. Limit repeated claims about one subject/predicate so one noisy
component cannot consume all context. Add direct dependency, governing
constraint, and conflict cards before lower-ranked general facts.

If character budget would be exceeded, keep the highest-ranked complete cards;
never truncate an ID, scalar, provenance locator, or warning mid-value. Record
omitted count and reason. The rendered context has a fixed heading, then:

1. applicable constraints/decisions and unresolved conflicts;
2. task-relevant facts, preferences, and assessments;
3. dependencies and governing procedures; and
4. warnings and omissions.

This order is semantic, not evidence of higher confidence. A renderer must
state that memory is attributable context to verify, not an instruction that
overrides current user requirements or validated project policy.

## Consolidation

Consolidation is an explicit transaction over a validated graph plus a bounded
set of already-admitted proposed mutations. It runs after a batch is admitted,
on an explicit maintenance request, or before a checkpoint when there are
pending admitted mutations. It does not scrape raw operational history or
create evidence from retrieval output.

### Normalize and group

For each proposed or existing active claim, construct an assertion key:

```text
(normalized about-subject identity, predicate name, normalized object/value,
 normalized scope set, validity interval)
```

Scalar normalization is predicate-specific: strings use Unicode/case/whitespace
normalization; booleans and timestamps preserve type; finite numbers use exact
canonical JSON numeric representation. Entity objects use their opaque ID, or
a resolved stable identity only during entity-resolution review. Free-text
summaries and labels do not determine equality. Scope sets are sorted opaque
IDs; an absent scope differs from an explicit scope. Intervals overlap only
when their temporal ranges intersect.

Before grouping claims, resolve candidate entity duplicates using documented,
non-secret identity attributes for the entity type. Exact identity equality
creates a merge candidate; conflicting identities, ambiguous matches, or
entities without stable identity are left separate and linked only when a
reviewer supplies an appropriate relationship. Entity merges retain the
surviving opaque ID, redirect valid references in one transaction, attach all
provenance, and journal an audited merge rationale. They never merge people or
roles based only on a display label.

### Same-assertion consolidation

Claims sharing an assertion key are not automatically deleted. Choose a
survivor only when the claims have compatible claim type, epistemic basis does
not imply a material semantic difference, and all sources support the same
assertion. Prefer the record with the strongest provenance set; break ties by
higher confidence, earlier immutable ID, then earliest asserted time. Attach
deduplicated provenance and supported scope/validity metadata to the survivor.

Mark every replaced claim `superseded` and add a `supersedes` edge from the
survivor with provenance describing the consolidation basis. Preserve the old
claim and its original provenance. If type, basis, scope, or validity differs
materially, retain separate claims even if their wording is similar; optionally
link them with `derived_from` only when that relationship is evidenced.

### Conflict and change handling

Potential conflicts are claims about the same normalized subject and predicate
with overlapping scope and validity but incompatible object/value, or explicit
`contradicts` relationships. Consolidation must distinguish these cases:

- **Newer authoritative replacement:** if provenance establishes a later
  decision or direct observation that replaces an older applicable claim, add a
  `supersedes` edge, narrow or close the older claim's validity when supported,
  and mark it `superseded`. Do not infer authority solely from a timestamp or
  confidence score.
- **Coexisting scoped/temporal statements:** retain both when scopes or
  validity do not overlap; ensure their boundaries are represented correctly.
- **Unresolved contradiction:** retain both active claims, create or retain a
  `contradicts` edge with supporting provenance, lower neither confidence
  automatically, and create a bounded review finding. Retrieval surfaces this
  conflict whenever either endpoint is selected.
- **Retraction:** only an admitted, attributable retraction can mark a claim
  `retracted`; add provenance and retain its history. A contradiction is not a
  retraction.

Derived assessments must link via `derived_from` to their supporting claims;
when all support is superseded or retracted, retain the assessment but mark it
for review rather than silently deleting it.

### Transaction and review output

A consolidation transaction validates the complete proposed result before any
journal operation is committed. It emits deterministic operations for entity
updates/merges, provenance attachment, edge creation, status/validity updates,
and review findings. Operation ordering is: create needed records, attach
provenance, create relationships, then update lifecycle fields. Any validation
failure aborts the whole transaction.

Its result contains counts of examined, merged, superseded, conflicted,
review-required, and unchanged records; affected opaque IDs; the policy and
normalization versions; and bounded reasons. Review findings are not themselves
claims or durable instructions until accepted through the later write policy.

## Safety and operational behavior

- Retrieval and consolidation accept only a graph that passes schema, layout,
  digest, replay, and controlled-vocabulary validation.
- Both operate on sanitized graph fields only and must not emit raw prompts,
  tool payloads, credentials, or unbounded provenance excerpts.
- A failed retrieval returns no partial context. A failed consolidation changes
  no graph state. Both outcomes are auditable using the separate audit journal
  where permitted.
- Readers operate from one manifest generation. Consolidation takes the
  project-scoped writer lock and retries from a fresh generation if it loses a
  compare-and-swap race before commit.
- Scores are advisory selection aids, not truth values. Provenance, status,
  scope, validity, and conflict information always accompany selected claims.

## Verification scenarios for the prototype

The step-6 prototype must demonstrate at least these fixtures:

1. A direct task/entity query retrieves an active, scoped, well-provenanced
   fact ahead of a weak lexical match and reports stable score reasons.
2. A decision and its required dependency render before a lower-priority fact
   within a deliberately small result budget, with omissions reported.
3. A claim scoped to another environment is excluded; a historical `review`
   query can retrieve a superseded claim with its successor.
4. Two incompatible, overlapping active claims are returned together as an
   unresolved conflict rather than one being silently chosen.
5. Equivalent claims with compatible evidence consolidate to one active
   survivor, preserve every provenance record, and leave a traceable
   `supersedes` relationship.
6. A later authoritative replacement supersedes an earlier claim, while an
   ambiguous conflict remains active and creates a review finding.
7. Corrupt/replay-invalid storage and an invalid consolidation proposal fail
   closed without partial context or mutation.

## Deferred decisions

Step 5 sets admission criteria, privilege checks, exact budgets, sensitive-data
detection/redaction, retention, and when automatic consolidation is allowed.
Step 6 selects interfaces, operation schemas, indexes, lock implementation,
and executable tests. Step 7 evaluates retrieval quality and consolidation
outcomes against representative agent workflows. Step 8 addresses legacy-data
migration and adoption; no current operational memory value is imported by this
design.
