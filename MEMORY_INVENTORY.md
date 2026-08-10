# Memory Usage Inventory

**Scope:** execution-plan step 1. This inventory uses code, documentation, migration definitions, and SQLite schema/count metadata only. It does **not** read `data.json`.

## Current stores

| Store | Contents / role | Current state | Cross-run use |
| --- | --- | --- | --- |
| `/tmp/data.json` | Operational run configuration: response history, tool-call results, token usage, prompt/tool-summary history, plan state, execution feedback, and replanning history. | Read at process start and written during execution. Its configured path is hard-coded. | Yes, for the fields that are loaded into `configData`; prompt construction uses the bounded prompt and tool-summary histories. |
| `ELASTIC_AGENT_MEMORY_PATH` (default `/tmp/elastic-agent-memory.json`) | Arbitrary JSON value in `configData.memory`. | Write-only persistence primitive. Written after tool/model-loop iterations, initial plan persistence, and each completed plan step when that own property exists. | No: the file is never read, validated, injected into a prompt, distilled, or initialized by the runtime. |
| `database.sqlite` | A relational mirror format for selected operational fields: request responses, tool calls, response checkpoint, and pending tool-call IDs. | The checked-in database contains zero rows in all application tables (36,864 bytes). `initializeDatabase.js` rebuilds it from `data.json`. | No: `main2.js` does not open it. Repository helpers provide explicit-order reads/writes, but no runtime integration exists. |
| In-process arrays | Last 10 command-line prompts and tool-call TLDRs, plus the active plan and execution state. | Constructed from `configData` for a run; history is capped at 10 items. | Only through `/tmp/data.json`, not through the memory file. |
| Spec Keeper / Agent Bus | Intended durable project goals, decisions, task state, and handoffs. | The configured Spec Keeper canonical routes returned 404 during this inventory; Agent Bus lacks a configured base URL. | Not available for this run. |

## Runtime data flow

1. `main2.js` reads `/tmp/data.json`; on read/parse failure it begins with `{ responseIds: [] }`.
2. It normalizes operational arrays/objects, appends the current prompt, and builds planning context from the last 10 prompts and last 10 tool-call TLDRs.
3. It persists the operational configuration repeatedly to `/tmp/data.json` using an atomic write helper.
4. If `configData` already has its own `memory` property, it independently atomically serializes that value to the memory path. No code creates, updates, or consumes this property as part of an intentional memory workflow.

Atomic writes create the parent directory with requested mode `0700`, create a unique sibling temporary file at `0600`, sync it, then rename it over the destination. A failed memory write is logged and does not halt execution; it is not retried.

## Inventory findings

- Durable agent memory is **not implemented**: current memory persistence is an untyped, unversioned, plain-JSON write sink without startup load, validation, prompt retrieval, consolidation, retention, size limits, or sanitization.
- Existing practical context retention is limited to operational `data.json` histories (10 prompts and 10 tool summaries); this is separate from the nominal memory file.
- The SQLite design preserves JSON and ordering for four operational collections but currently has no records and is not a runtime memory backend.
- Runtime and documentation warn that the arbitrary memory value may contain secrets and has no dedicated secret-management handling.
- The supplied `MEMORY_WORKFLOW.md` accurately describes the missing durable-memory capabilities and should remain the baseline for subsequent design steps.

## Coordination status

Authoritative Spec Keeper state could not be consulted or updated: requests to `/goals`, `/epics`, `/tasks`, `/task-queue`, `/dependencies`, `/decisions`, `/plans`, and `/procedures` returned `404 Not Found`. The attempted Agent Bus blocker handoff could not be sent because `AGENT_BUS_BASE_URL` is unset. Restore/configure those services before the next step so task state and decisions can be synchronized.

## Verification performed

- Searched repository source and documentation while excluding `data.json`, `.git`, and `node_modules`.
- Inspected `main2.js`, memory documentation, SQLite migration DDL, database initialization code, and repository access helpers.
- Queried only SQLite schema and row counts via the installed Node SQLite packages; no application-table rows were read.
- Confirmed all four application tables have zero rows.
