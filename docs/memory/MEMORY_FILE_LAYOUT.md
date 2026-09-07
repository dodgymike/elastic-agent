# Durable Memory File Layout and Canonical Formats

**Scope:** execution-plan step 3, *Choose a file layout and canonical formats*.
This document selects the physical representation for the logical graph in
[`GRAPH_DATA_MODEL.md`](GRAPH_DATA_MODEL.md). It does not select retrieval,
consolidation, admission/retention policy, or implement storage tooling.

## Decision summary

A durable-memory graph is stored in a private, per-project directory as a
**versioned JSON snapshot plus append-only JSON Lines journals**. JSON is the
canonical interchange and snapshot format; JSON Lines is canonical only for
the operation and audit journals. The snapshot is authoritative after a
successful checkpoint. Journals contain changes made since that checkpoint and
are replayed in ascending sequence number to reconstruct the current graph.

This arrangement makes the small initial graph inspectable and recoverable
without introducing a database dependency, while preserving an append-only
history needed for provenance, conflict review, and safe atomic writes. It is
not a request to use the checked-in `database.sqlite` or operational
`data.json`; those remain separate and neither is a durable-memory store.

## Root and isolation

The eventual runtime configuration must supply a `memoryRoot` directory.
Absent an explicit configuration, the intended default is a private runtime
location such as:

```text
$XDG_STATE_HOME/elastic-agent/memory/<project-key>/
```

On systems without `XDG_STATE_HOME`, the platform-appropriate user state
directory is used. A deployment may configure a different private location.
The memory root must never default inside the repository, `/tmp`, or a shared
world-readable directory. It must be distinct from the current
`ELASTIC_AGENT_MEMORY_PATH` legacy JSON sink and from `/tmp/data.json`.

`<project-key>` is a sanitized, stable project identifier selected by
configuration or derived from a non-secret repository identity. It is not a
raw URL, filesystem path, branch name, or user-provided free text. The runtime
must reject keys that could escape the configured root (`/`, `\\`, `..`, NUL,
or platform-equivalent traversal forms).

The root directory and all memory subdirectories are created with mode `0700`;
regular files are created with mode `0600`. Implementations must verify that
an existing path is a directory/file of the expected kind, resolve containment
without following untrusted symlinks, and fail closed if permissions or path
ownership cannot be made safe. Encryption at rest and multi-user sharing are
out of scope for this file-layout decision.

## Directory tree

A memory directory at format version 1 has this layout:

```text
<project-memory-root>/
├── manifest.json
├── graph.snapshot.json
├── journal/
│   ├── 00000000000000000001.jsonl
│   └── ...
├── audit/
│   └── 00000000000000000001.jsonl
└── quarantine/
    └── <implementation-created diagnostic artifacts>
```

| Path | Canonical format | Purpose |
| --- | --- | --- |
| `manifest.json` | canonical JSON | Small recovery and compatibility entry point: format version, graph identity, checkpoint and journal boundaries, and integrity metadata. |
| `graph.snapshot.json` | canonical JSON | Complete validated graph at `snapshot_sequence`; it is the checkpoint base for replay. |
| `journal/*.jsonl` | canonical JSON Lines | Ordered graph mutation operations after the snapshot. A segment is immutable once closed. |
| `audit/*.jsonl` | canonical JSON Lines | Sanitized, append-only record of writes, rejections, checkpoints, migration, and security-remediation events. It is never a raw prompt/tool transcript. |
| `quarantine/` | non-canonical diagnostic artifacts | Invalid or interrupted inputs retained only when safe and permitted by the future write policy. Readers never replay this directory. |

The directory has no implicit files. Unknown root files and unrecognized
subdirectories cause validation failure rather than being silently consumed.
Derived indexes, locks, temporary files, and backups are implementation
artifacts and must use names that cannot be mistaken for canonical records
(for example, a `.tmp-<random>` suffix); they are excluded from recovery after
staleness checks. The layout intentionally has no `data.json` file.

## Canonical JSON

`manifest.json` and `graph.snapshot.json` are UTF-8 JSON documents with no
byte-order mark. They use these canonical serialization rules:

1. Object member names are emitted in lexicographic Unicode code-point order.
2. Arrays retain their defined logical order; no consumer may assume an
   incidental insertion order. Snapshot record collections are sorted by their
   opaque `id`; provenance records are sorted by `id`; edges are sorted by
   `id`.
3. Strings use JSON escaping with no non-ASCII escaping requirement; all
   timestamps are UTC RFC 3339 strings as required by the logical model.
4. Numbers are finite JSON numbers. `NaN`, `Infinity`, `-Infinity`, and
   negative zero are rejected. Implementations must serialize an integer
   exactly when it is representable and reject values outside their documented
   exact numeric range rather than rounding them silently.
5. Insignificant whitespace is canonicalized as two-space indentation and one
   terminal newline. A cryptographic digest is computed over those UTF-8 bytes.
6. Duplicate object keys, invalid Unicode, unknown un-namespaced extension
   fields, and trailing non-whitespace content are invalid.

A snapshot has the graph envelope defined in the model, with these physical
requirements:

```json
{
  "created_at": "2025-01-01T00:00:00Z",
  "edges": [],
  "graph_id": "opaque-id",
  "nodes": [],
  "provenance": [],
  "schema_version": "1.0",
  "updated_at": "2025-01-01T00:00:00Z"
}
```

The timestamp and ID values above are illustrative. Collection field names are
fixed (`nodes`, `edges`, `provenance`) to eliminate serializer ambiguity. The
logical model's controlled vocabulary and integrity checks remain mandatory.
Extension fields use a registered namespace, for example `x_example_feature`;
the `x_` prefix alone does not authorize arbitrary producer-specific blobs.

## Manifest

The manifest is deliberately small so a loader can establish compatibility and
find a coherent checkpoint before parsing potentially many journal segments.
Its version-1 shape is:

```json
{
  "format_version": "1.0",
  "graph_id": "opaque-id",
  "journal": {
    "first_sequence": 43,
    "last_sequence": 57,
    "segments": [
      {
        "first_sequence": 43,
        "last_sequence": 57,
        "path": "journal/00000000000000000043.jsonl",
        "sha256": "lowercase-hex-digest"
      }
    ]
  },
  "snapshot": {
    "path": "graph.snapshot.json",
    "sequence": 42,
    "sha256": "lowercase-hex-digest"
  },
  "updated_at": "2025-01-01T00:00:00Z"
}
```

All referenced paths are fixed relative paths below the memory root and must
pass the containment rules above. `sequence` is a non-negative safe integer;
operations have strictly increasing, gap-free sequence numbers across the
snapshot/journal boundary. An empty initialized graph has snapshot sequence
`0`, journal first/last sequence `0`, and an empty segment list.

`sha256` is an integrity/corruption detector, not an authenticity or
confidentiality control. A mismatch blocks normal loading and is recorded in
the audit log when safe to do so. Loader recovery is described below; it must
never select a newer-looking file merely because it parses.

## Journal and audit JSON Lines

A JSON Lines file is UTF-8 without BOM, containing exactly one canonical,
single-line JSON object followed by `\n` per line. Empty lines, comments,
multiline JSON, and a missing terminal newline are invalid for a sealed
segment. The file's lines are ordered by `sequence`; their sequence range must
match the manifest segment entry.

Each graph-operation line has this minimum envelope:

```json
{"at":"2025-01-01T00:00:00Z","graph_id":"opaque-id","operation":{"kind":"..."},"sequence":43}
```

`operation.kind` is a controlled mutation vocabulary. The exact operations
and replay semantics will be specified with the tooling prototype, but each
operation must be self-contained, schema-validatable, deterministic to replay,
and reference only existing IDs or IDs created earlier in the same operation.
A journal does not contain a whole replacement graph, unbounded evidence, raw
prompt, raw tool result, credential, or secret. A replay failure (including a
postcondition failure) invalidates that manifest generation rather than
partially accepting later operations.

Audit lines use a separate controlled `event_kind` and contain `at`, a
non-secret operation/correlation ID, outcome, and bounded sanitized reason or
summary. They may cite a graph sequence but do not establish graph state and
are not replayed. Audit rotation and retention belong to step 5.

## Write, checkpoint, and recovery boundary

A mutation is committed only after its complete canonical JSONL line has been
written and synced to the currently open journal segment, then the directory
metadata is synced where supported. The manifest is atomically replaced last,
using a same-directory private temporary file, file sync, rename, and directory
sync. Concurrent writers require a project-scoped exclusive lock; readers use
a stable manifest generation and must retry if it changes during their read.

A checkpoint procedure:

1. Loads and validates the manifest, snapshot, and every referenced operation.
2. Replays the journal to a fully validated graph.
3. Writes and syncs a complete new snapshot to a same-directory temporary file.
4. Names or seals any required journal segments and calculates digests.
5. Atomically replaces the manifest with the new snapshot sequence and retained
   journal range, then syncs its directory.
6. Deletes superseded segments only after the new manifest is durable.

If interrupted, the previous manifest remains the sole recovery authority;
unreferenced temporary files or segments are ignored, not auto-adopted. If the
manifest points to missing, malformed, mismatched, or non-contiguous data, the
runtime fails closed for writes and retrieval. Repair requires an explicit
operator/tool action that preserves a sanitized audit event. The quarantine
area must not be replayed automatically.

The current runtime's `writeFileAtomically` pattern is a useful primitive for
snapshot and manifest replacement, but it is insufficient alone for journal
ordering, locking, checkpoint recovery, and directory durability.

## Versioning and migration

`format_version` versions this physical layout; `schema_version` in each graph
versions the logical model. Both use `major.minor` decimal versions.

- A reader accepts the same major version and any supported minor version.
  Unknown fields must follow the registered extension rules.
- A writer emits its current supported minor version only after a successful,
  explicit migration.
- A major-version mismatch is unsupported and blocks normal load.
- Migration is an offline, explicit, idempotent operation: validate and back
  up the old generation, produce a new complete directory generation, validate
  it, atomically switch the active manifest, and audit the outcome. It never
  rewrites a snapshot or sealed journal in place.

Backward compatibility is preferred for minor additions. Removing or changing
meaning of an existing field requires a major format or schema version. The
later tooling step will define migration commands and test fixtures; no
migration is performed as part of this decision.

## Explicit non-decisions

This step does **not** define the controlled predicate vocabulary, query API,
retrieval ranking, conflict resolution, consolidation cadence, operation
vocabulary, retention limits, secret detection, or authorization. Those remain
respectively within the later retrieval/consolidation, write-policy, and
prototype steps. It also does not migrate or reinterpret the current legacy
memory JSON file; adoption and migration planning is step 8.

## Acceptance criteria satisfied

- A private per-project filesystem location and exact canonical directory tree
  are selected.
- Snapshot, manifest, graph journals, and audit journals have distinct,
  documented formats and authority.
- Canonical JSON/JSONL, ordering, validation, integrity, atomicity, recovery,
  permissions, and version boundaries are defined.
- Existing operational state stores are expressly excluded.
- Retrieval, consolidation, admission, retention, and implementation mechanics
  remain deferred to their intended plan steps.
