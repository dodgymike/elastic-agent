# Durable Memory Representative-Workflow Evaluation

**Scope:** execution-plan step 7, *Evaluate against representative workflows*.
This evaluation exercises the step-6 local prototype against the retrieval and
consolidation scenarios required by
[`MEMORY_RETRIEVAL_AND_CONSOLIDATION.md`](MEMORY_RETRIEVAL_AND_CONSOLIDATION.md).
It does not wire durable memory into `main2.js`, import legacy memory, define
migration, or begin adoption work.

## Method

Evaluation used deterministic in-memory graphs with fixed evidence timestamps,
repository provenance, one repository subject, and `prod`/`stage` environment
entities. The prototype's existing executable fixture was also run:

```text
node test/durable-memory-prototype.test.js
# durable-memory prototype fixtures passed
```

The representative checks invoked the exported `retrieve` and `consolidate`
functions directly. Each graph passed `validateGraph` before the behavior under
test. No runtime memory file, operational state, or legacy memory was read.

## Results

| Workflow | Expected design behavior | Observed prototype behavior | Result |
| --- | --- | --- | --- |
| Direct planning/lookup query under a one-card budget | Rank the directly relevant, well-supported claim above a weak lexical match and report the omitted card. | The direct claim ranked first (score `0.950`); one omission was reported. | Pass |
| Environment-scoped execution query | Exclude a claim scoped only to a disjoint environment. | A `prod` query returned only the `prod` claim and excluded the `stage` claim. | Pass |
| Historical review | A `review` query may include a superseded claim and its successor. | `retrieve` filters to `status === active` before it considers `intent`; the superseded claim was absent. | Gap |
| Diagnosis with a conflict and one-card budget | Include the directly contradictory companion rather than silently selecting one endpoint. | The selected card listed `conflict_with: ["b"]` and warning text, but the contradictory card was omitted by the budget. | Gap |
| Consolidation of equivalent values in disjoint environments | Preserve coexisting scoped statements; scopes form part of the assertion key. | `consolidate` grouped claims by subject, predicate, and value only, superseding the `stage` claim with the `prod` claim. | Gap (incorrect mutation proposal) |
| Unresolved incompatible active claims | Preserve both endpoints and emit a bounded review finding. | `consolidate` returned no review finding and does not inspect `contradicts` edges. | Gap |
| Invalid journal proposal and corrupted snapshot | Fail closed with no partial state. | Existing fixture confirms both operations throw; it also confirms unsafe bearer-shaped text is rejected. | Pass |

## Assessment

The prototype establishes useful foundations: validated graph replay, bounded
unsafe-text rejection, direct relevance ranking, scoped exclusion, budget
omissions, and fail-closed storage checks. It is not yet suitable for the
retrieval/consolidation contract in representative agent workflows.

The material defects are all contained in the prototype boundary, not in the
selected graph model or file layout:

1. Retrieval must implement intent-aware lifecycle selection for `review` and
   include a successor/history relationship where applicable.
2. Retrieval must reserve budget for conflict companions (or render both as one
   complete conflict card), rather than only attaching an ID to a selected
   endpoint.
3. Consolidation keys must include normalized scope sets and validity intervals.
   It must not generate supersession operations for claims that can coexist.
4. Consolidation must detect incompatible overlapping values and explicit
   `contradicts` edges, retain both claims, and return a bounded review finding.
5. Later implementation work should add representative executable fixtures for
   authoritative replacement, dependency/constraint ordering, provenance
   preservation, and explicit no-mutation checks for every rejected
   consolidation candidate.

## Decision for the next plan step

Do not integrate or migrate to the prototype as currently evaluated. Step 8
may document adoption and migration only with this limitation made explicit:
production adoption depends on correcting and testing the four material
retrieval/consolidation gaps above. The current prototype remains local-only
and is not connected to `main2.js`.
