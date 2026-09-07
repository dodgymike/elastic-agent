# Memory v2 contract and identity decisions (MI-01)

Status: implemented for MI-01 (contracts and adapters only). The default
backend is **unchanged** until the rollout task (MI-16) explicitly migrates it.

## Identity boundaries

- `MemoryScopeV2` is the immutable gate for every store access:
  `workspaceId`, `principalId`, `sessionId`. All three are required. Missing
  scope or a mismatched scope throws; there is no fallback to another user or
  workspace.
- `MemoryIdentityV2` extends the scope with `runId` and an optional `taskId`.
  A task ID is informational and **never** stands in for a principal.
- When no authenticated principal exists, `resolveLocalPrincipalId(workspaceId)`
  returns an explicit `local:<workspaceId>` value. It is never derived from
  credentials, environment secrets, or task IDs.
- Workspaces are canonicalized once with `canonicalizeWorkspacePath` (real path
  when available, normalized absolute path otherwise) and identified with
  `deriveWorkspaceId`. Independent workspaces are isolated by default, even
  when their directory basenames match. Sharing requires an explicit stable
  workspace mapping and is never inferred from a basename.

## Event envelope

`MemoryEventEnvelopeV2` (stored) vs `MemoryEventAppendV2` (caller input):

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`; parsing any other value fails |
| `identity` | full `MemoryIdentityV2` |
| `eventId` | stable semantic ID assigned by the caller |
| `sequence` | positive, per-session, monotonically increasing; store-stamped |
| `runRef` / `stepRef` | run and step provenance |
| `timestamp` | descriptive ISO-8601; never an ordering or uniqueness key |
| `kind` | controlled set: observation, outcome, checkpoint, decision, fact, constraint |
| `outcome` | `{ asserted, verification }`; assertion is separated from evidence level (`unverified`, `verified`, `refuted`) |
| `payload` | opaque JSON-safe value |
| `evidenceRefs` | event IDs this event is derived from or supported by |

Append inputs omit `schemaVersion` and `sequence`; the store stamps them when
the write is durably accepted.

## Event IDs and conflict detection

- `stableEventId(scope, semanticKey)` derives a deterministic ID so retries of
  the same semantic event reuse the same ID.
- `freshEventId()` produces a new ID for a genuinely new event/attempt.
- `computeEventDigest(event)` hashes identity + run/step reference + kind +
  outcome + payload + evidence references, excluding the ID, sequence, schema
  version, and timestamp. A reused ID with a different digest is a **conflict**,
  not a silent overwrite.

## Typed results

- Append: `durable` (with sequence) | `duplicate` | `conflict` | `failure`.
  A successful `void` return from a legacy backend is **not** durable success.
- Initialize: `ready` | `failure`.
- Retrieve: reports `scope`, `revision`, `events`, `evidenceRefs`, and
  `degraded` state.
- Flush: `durable` (with revision) | `failure`.
- Close: `closed` | `failure`.

## Lifecycle and compatibility

`MemoryModuleV2` is the new lifecycle/capability interface (initialize, append,
retrieve, flush, close). Old backends do not implement it directly.
`LegacyMemoryModuleAdapter` surfaces a legacy v1 `MemoryModule` behind it:

- `capabilities.durable` is `false`.
- `append` fails closed with an actionable reason because the v1 contract
  cannot establish a durable write (the legacy in-process state still serves
  the current run).
- `retrieve` returns a degraded result and best-effort rendered text.

Rollout (`ELAGENT_MEMORY_TYPE=persistent-v2`) is intentionally **not** wired in
this task. Rollback of MI-01 removes the additive types/exports and their
adapter; no stored-data migration is required.
