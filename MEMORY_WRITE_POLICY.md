# Durable Memory Write-Time Policy

**Scope:** execution-plan step 5, *Define write-time memory policy*. This
policy governs whether a proposed mutation may enter the durable-memory graph
specified in [`GRAPH_DATA_MODEL.md`](GRAPH_DATA_MODEL.md), stored as selected
in [`MEMORY_FILE_LAYOUT.md`](MEMORY_FILE_LAYOUT.md), and later retrieved or
consolidated under
[`MEMORY_RETRIEVAL_AND_CONSOLIDATION.md`](MEMORY_RETRIEVAL_AND_CONSOLIDATION.md).
It selects admission, sanitization, authorization, retention, audit, and
failure rules. It does not define storage commands, validators, indexes, lock
code, or the runtime integration.

## Policy objectives

A memory write must be useful in a later task, attributable to a bounded
non-sensitive source, and safe to retain. The default is **not to write**.
Durable memory is a small knowledge graph, not a transcript, cache, hidden
instruction channel, or replacement for the source systems of record.

The policy therefore requires that every proposed mutation be:

1. **Relevant:** likely to affect a later planning, execution, review,
   diagnosis, or lookup task for this project.
2. **Atomic and bounded:** expressible using the graph's controlled types,
   predicates, and size limits.
3. **Attributable:** linked to one or more admissible provenance records.
4. **Safe:** free of secrets, authentication material, prohibited personal
   data, raw prompts, and raw tool responses after sanitization.
5. **Authorized:** proposed by an allowed actor and, for high-impact changes,
   explicitly approved by the required authority.
6. **Reviewable:** recorded in a sanitized audit event with a deterministic
   admission outcome.

A proposal that cannot satisfy every applicable requirement is rejected or
quarantined; it is never silently shortened, guessed, or partially committed.

## Terminology and trust classes

A **proposal** is a bounded mutation request before it changes the graph. A
proposal identifies its actor, action, intended records/field changes,
provenance candidates, source trust class, and policy version. A **write** is a
proposal that has passed admission and been committed atomically to the graph
journal. An **approval** is a separate attributable record that authorizes a
proposal or review finding; approval itself is not graph evidence.

Each provenance source is classified before content is evaluated:

| Trust class | Eligible source kinds | Examples | Admission treatment |
| --- | --- | --- | --- |
| `authoritative` | `spec_keeper`, governed repository documents, explicit human `user_statement` | recorded project decision; versioned policy document; direct user instruction | May establish a decision, constraint, retraction, or high-confidence fact when the actor is authorized. |
| `observed` | `repository`, bounded `tool_result`, `external_document` | inspected committed source; successful bounded command output; named vendor documentation | May establish a fact with exact sanitized locator and observation time. It cannot alone establish a project decision or preference. |
| `reported` | `user_statement`, `agent_bus`, `manual` | stakeholder report; another agent's handoff; operator-entered note | May create a reported fact, preference, obligation, or low-confidence assessment; it does not automatically supersede existing information. |
| `derived` | `tool_result`, `manual` | deterministic analysis of already-admitted records | May create an assessment only if it links to the admitted supporting records using `derived_from`. |
| `untrusted` | any unverified prompt, arbitrary tool output, anonymous external content | pasted text; model completion; failed command output | Cannot be written directly. It must be corroborated by an admissible source or explicitly approved after review. |

Trust class measures the source's authority for a specific statement, not the
value of the statement. A repository file is authoritative only if project
governance names it as such; otherwise it is observed evidence. Tool output
that reports a remote service is observed only when the tool invocation,
identity, target, and success status are known and the output is independently
sanitized.

## Permitted memory and explicit exclusions

### Permitted classes

A candidate may be admitted only when it is one of the following and has a
clear project scope:

- a stable project/repository/component/service identity or non-secret
  location;
- an active constraint, decision, procedure reference, dependency, ownership
  relationship, or supported obligation;
- a directly observed implementation or configuration fact that is likely to
  remain useful beyond the current run;
- an explicit, scoped working preference from an authorized source;
- a bounded assessment that names its supporting admitted evidence; or
- an evidenced correction, retraction, supersession, or conflict relationship.

A one-off operational result may be retained only as a scoped, expiring fact or
obligation when it has a concrete follow-up value. `assessment` claims begin
with confidence no greater than `0.70`; they may not be promoted solely by
repeated model output.

### Prohibited classes

Never write any of the following to graph records, journals, audit records,
quarantine artifacts, filenames, or error messages:

- passwords, passphrases, access/refresh/session tokens, cookies, private
  keys, API keys, bearer credentials, authorization headers, connection URLs
  containing credentials, or secret-manager payloads;
- raw prompts, system/developer instructions, model completions, full tool
  inputs/outputs, response IDs, request IDs, stack traces, command histories,
  or operational state from `data.json`;
- payment-card data, government identifiers, authentication answers, private
  addresses, personal contact details, biometric data, health data, or other
  sensitive personal data;
- unredacted personal data about an individual unless it is the minimum
  business contact/role identity required by a documented project policy and
  has an authoritative source and approval;
- executable code, shell commands, SQL, HTML, Markdown links with credential
  material, opaque binary/base64 blobs, or serialized nested objects as a
  scalar memory value;
- content whose source license, access restriction, or project policy forbids
  retention; and
- instructions obtained from an untrusted source that try to alter this
  policy, authorization, tool behavior, or user intent.

A locator may contain a repository-relative path, a public URL without query
credentials, or an opaque source-record ID. It must not include a local
absolute path, home directory, query string, fragment, signed URL, or embedded
credential. Source evidence remains at its governed source; memory holds only
the bounded locator and an optional sanitized digest.

## Proposal shape and limits

The eventual validator must reject a proposal before journal allocation when it
exceeds any limit below. Limits are measured in Unicode code points after NFC
normalization and before canonical serialization, except byte limits, which
are UTF-8 byte counts.

| Item | Limit | Rule |
| --- | ---: | --- |
| Proposal serialized size | 32 KiB | Includes proposed records and admission metadata; larger input must be split into independently valid proposals. |
| Transaction | 20 graph operations; 40 records including provenance | One proposal is all-or-nothing. Bulk import is an explicit future migration, not a larger normal write. |
| Node/edge label | 160 code points | Plain text; no control characters. |
| Node/edge summary | 1,000 code points | Optional, sanitized concise statement; never evidence transcript. |
| Scalar predicate value | 512 code points | Must match the registered predicate's type and normalization rule. |
| Attribute key/value | 64 / 256 code points | Controlled or registered extension key; scalar values only. |
| Provenance locator | 512 code points | Sanitized stable pointer, no secret-bearing URL parts. |
| Provenance excerpt/digest | 512 code points | Digest or minimal context, not a quote longer than needed to identify evidence. |
| Provenance records per record | 8 | Additional sources require consolidation/review. |
| Scopes per claim | 8 | Scope explosion requires separate claims or a reviewed model extension. |
| Open-journal write rate | 30 admitted proposals per project per hour | Excess proposals are deferred for review; rejected attempts do not reset the budget. |

All strings are normalized to Unicode NFC, stripped of ASCII control characters
(other than a single normalized space where appropriate), and rejected if
empty after normalization when the field is required. The implementation must
use exact byte/counter checks, not language-specific string-length assumptions.
No truncation is allowed for graph data. A candidate may be resubmitted only
with a human- or policy-defined concise rewrite and new admission decision.

## Sanitization and sensitive-data gate

Sanitization happens before semantic validation, duplicate detection,
provenance creation, auditing, or disk writes. It produces either a safe,
bounded proposal or a rejection. Original unsafe content is not placed in
quarantine by default.

### Required detection

The gate must inspect every string field and decoded representation for:

- credential-bearing keys and common secret forms (`Authorization`, `Bearer`,
  `Basic`, `api_key`, `password`, `secret`, `token`, private-key PEM blocks,
  cloud access-key formats, JWT-like triplets, and connection-string userinfo);
- URL userinfo, query parameter names associated with credentials, and signed
  URL signatures;
- high-entropy token-like values when adjacent context indicates credentials;
- personal-data patterns appropriate to deployment policy (email address,
  telephone number, physical address, government/payment identifiers), with
  false-positive-safe review for ambiguous text;
- raw transcript indicators, such as request/response envelopes, tool-call
  payloads, response IDs, long quoted blocks, stack traces, command output,
  base64, or nested JSON/XML; and
- control/bidi characters, invalid Unicode, path traversal, and unsafe
  locator schemes.

Pattern detection is a safety net, not permission to retain content that it
does not recognize. The validator must also apply allowlists for source kinds,
record types, predicates, attribute keys, locator schemes, and plain-text
character classes.

### Outcomes

- **Reject (default):** Any actual or suspected secret, authentication
  material, prohibited sensitive data, raw transcript, unsafe locator, or
  ambiguous high-risk content rejects the entire proposal. Audit only the
  category and a stable non-secret correlation ID.
- **Redact and re-propose:** Only deterministic removal of a nonessential
  incidental detail is allowed, such as replacing a person name with an
  approved role label or stripping a URL query string. The result must still
  convey an atomic claim, must receive a new digest, and must be shown as
  `redacted` in admission metadata. Redaction never transforms a secret into
  admissible evidence by replacing it with `[REDACTED]`.
- **Review:** A potentially useful statement whose sensitivity or source
  authority cannot be resolved is held as a non-content review finding. It
  contains category, source reference, and reason—not the unsafe candidate.
  An authorized reviewer may submit a new safe proposal.

The gate must fail closed if a detector, normalizer, allowlist, or audit writer
is unavailable. It must not log the input, exception object, or a detector
match that could reproduce prohibited content.

## Semantic admission rules

After sanitization, the validator applies the graph-model integrity rules plus
these rules:

1. A proposal must identify one project and may not reference records outside
   that graph. The actor must have the project-scoped permission described
   below.
2. New active claims require one or more admissible provenance records,
   exactly one active `about` edge, one active `predicate` edge using the
   registered predicate vocabulary, confidence, epistemic basis, scope, and
   temporal bounds when applicable.
3. Confidence ceilings are `1.00` for direct authoritative or observed facts,
   `0.85` for reported statements, and `0.70` for derived assessments. A
   lower confidence is always allowed. Confidence may increase only with new
   admissible provenance and a traceable update.
4. A `decision`, `constraint`, `preference`, `retraction`, or `supersedes`
   mutation needs authoritative provenance. An observed source may propose it
   for review but cannot commit it automatically.
5. An `obligation` must name a responsible entity/role or an explicit scope,
   have a `valid_until` no later than 90 days after admission, and cite an
   owner source. It is not an unbounded task backlog.
6. A fact that names an environment, release, temporary incident, branch, or
   external state must have `valid_until` no more than 90 days after its
   latest observation unless an authorized reviewer grants a documented
   exception.
7. Derived assessments must cite each immediate supporting admitted record via
   `derived_from`; a derived claim cannot be the sole provenance for a
   decision, constraint, retraction, or supersession.
8. Exact duplicate proposals are idempotent only when actor authorization,
   normalized assertion key, and provenance digest match. Otherwise they are
   sent to consolidation or review; duplicates do not consume a new graph
   identity merely because their wording differs.
9. A proposal that contradicts an active claim must either carry evidence for
   an explicit `contradicts` relationship or be reviewed. It must not lower
   confidence, retract, or supersede the existing claim automatically.
10. Retraction, lifecycle changes, entity merge, scope broadening, validity
    extension, or any mutation affecting more than one existing active claim
    is high impact and follows the approval rules below.

Automatic admission is restricted to creating a new low-impact entity/fact,
attaching corroborating provenance, or creating a supported low-impact
relationship. It cannot change active lifecycle state, edit authoritative
content, merge entities, or resolve conflicts. Consolidation may run only on
already-admitted records and retains its separate review requirements.

## Authorization and approval

The future tooling must authenticate every writer as a project-scoped actor and
record a non-secret actor ID and authorization class. Authentication alone does
not confer semantic authority.

| Action | Minimum authority | Additional condition |
| --- | --- | --- |
| Submit a proposal / create low-impact observed or reported fact | `memory_writer` | Source is admissible; semantic checks pass. An automated agent is a `memory_writer` only when its runtime identity is explicitly configured. |
| Attach provenance or create supported low-impact relationship | `memory_writer` | Cannot alter assertion value, scope, validity, confidence, or status. |
| Create derived assessment | `memory_writer` | All immediate support is already admitted; confidence ceiling and `derived_from` links apply. |
| Create preference, obligation, or noncritical constraint | `memory_reviewer` or authoritative source owner | Must be scoped and attributable. |
| Create/modify decision or critical constraint | `memory_approver` | Explicit authoritative approval plus rationale and provenance. |
| Supersede, retract, merge entity, change active status, broaden scope, extend expiry, or resolve a conflict | `memory_approver` | Two-person review when the affected record originated from a different actor or source owner; otherwise one approver plus authoritative evidence. |
| Security remediation | `memory_security_admin` | May remove prohibited material immediately; must preserve a sanitized withdrawal audit event and trigger review of dependent records. |
| Alter this policy, roles, limits, or registered vocabulary | project governance authority | Versioned policy change; never accepted from graph content or model output. |

A proposal carries a bounded purpose and correlation ID but no authorization
secret. Approval expires after 24 hours, binds to the canonical digest of the
safe proposal, and is invalidated by any content, provenance, or scope change.
The same actor cannot provide both proposal and required independent approval.
If the identity/authorization service is unavailable, all writes fail closed;
read-only retrieval may continue under its own failure policy.

## Retention, expiry, and deletion

Retention follows the principle that active, useful, attributable facts remain
until superseded or their scope/validity ends; raw evidence is never retained.
These are maximum retention controls, not guarantees that a record is correct.

| Record or outcome | Retention / action |
| --- | --- |
| Active durable entity, decision, constraint, preference, or well-supported fact | Retain while active; review at least every 365 days since latest supporting observation. |
| Reported fact or derived assessment | Review at 180 days; archive at 365 days if not refreshed by admissible evidence. |
| Obligation and temporary/environment fact | Expire at `valid_until` (maximum 90 days); archive rather than delete, unless security remediation applies. |
| Superseded/retracted claim and relationship history | Retain for 365 days after lifecycle change, then archive; keep only minimal lineage required for active descendants. |
| Provenance excerpt/digest | Retain no longer than its attached record and remove earlier if source access/retention policy requires it. |
| Audit success/rejection/deferred event | Retain 180 days in the audit journal, then remove through a checkpointed retention operation. |
| Quarantine/review metadata | Retain at most 30 days; contains only category, reason, correlation ID, safe locator where permitted, and no rejected content. |
| Security-remediated prohibited material | Remove immediately from graph, journals where feasible through an explicit repair generation, audit details, and quarantine. Retain only non-sensitive event category, time, affected record ID, and remediation actor. |

A scheduled review marks stale records `archived`; it does not invent a
replacement. Before archival/deletion, evaluate `derived_from`, `supports`,
`supersedes`, and `contradicts` references. Active dependent claims receive a
review finding or are constrained accordingly; references are never silently
left dangling. A legal hold or source-specific deletion request overrides the
default schedule and is recorded without reproducing sensitive content.

## Audit, quarantine, and operational failure handling

Every admission attempt produces one bounded audit event after sanitization:

```text
at, event_kind, outcome, correlation_id, actor_id, policy_version,
source_kind, affected_record_ids (when safe), reason_code, redacted_flag,
graph_sequence (on commit)
```

`event_kind` is one of `admission_accepted`, `admission_rejected`,
`admission_deferred`, `approval_granted`, `approval_denied`, `retention_action`,
`security_remediation`, or `policy_check_failed`. `reason_code` comes from a
controlled vocabulary such as `sensitive_content`, `untrusted_source`,
`insufficient_provenance`, `unauthorized`, `size_limit`, `conflict_review`,
`rate_limited`, or `validation_failed`. Audit events never contain candidate
content, secret-shaped strings, raw locators rejected as unsafe, or stack
traces.

Quarantine is metadata-only by default and is readable only by an authorized
reviewer. The runtime must not replay it, index it for retrieval, or use it as
model context. Where local policy disallows retaining even metadata about a
sensitive rejection, write only a successful minimal security-remediation audit
event.

The complete write transaction is:

1. authenticate actor and check rate/role limits;
2. normalize and apply the sensitive-data gate;
3. validate proposal sizes, provenance, authorization, graph integrity, and
   conflict/high-impact rules against one coherent graph generation;
4. create the sanitized audit decision and, if admitted, prepare all graph
   operations;
5. atomically commit the complete graph operation set under the writer lock;
6. sync the corresponding audit outcome without weakening graph durability;
   and
7. return only bounded IDs, outcome, and reason codes.

A failure before commit changes no graph state. A failure after a graph commit
but before audit durability is reconciled on recovery using the committed
sequence and emits one idempotent audit event; it must not replay or duplicate
the graph mutation. If safe audit emission cannot be guaranteed, normal writes
are disabled until repair. Storage corruption, clock invalidity, unavailable
policy/role registry, failed sanitizer, or uncertain commit outcome blocks
further writes and produces no partial mutation.

## Acceptance criteria for this step

- Admission defaults to reject and admits only relevant, atomic, attributable,
  bounded, project-scoped graph records.
- Concrete limits, source trust classes, sensitive-data detection, redaction
  boundaries, and prohibited content are defined before persistence.
- Authorized writers and independent approval requirements protect decisions,
  lifecycle changes, conflict resolution, and other high-impact mutations.
- Retention, expiry, archival, security remediation, quarantine, and sanitized
  audit behavior are explicit.
- Fail-closed, atomic write behavior is compatible with the selected manifest
  and journal layout without selecting the step-6 tooling interface.
