# `main2.js` Memory Persistence

This document describes the behavior implemented in the current `main2.js`.
It deliberately distinguishes the completed persistence primitive from the
larger durable-memory workflow, which is **not yet implemented**.

## Completed behavior: safe persistence of an existing memory value

`main2.js` selects the memory file from `ELASTIC_AGENT_MEMORY_PATH`; when that
environment variable is unset, it uses `/tmp/elastic-agent-memory.json`.

The runtime writes that file only when the in-memory run configuration has its
own `memory` property. It attempts this write after each model/tool-loop
iteration, after the initial plan state is saved, and after each completed plan
step. The value is serialized as formatted JSON. No schema or version is
currently enforced: whatever JSON-serializable value is held in
`configData.memory` is persisted.

Writes use `writeFileAtomically`:

1. The parent directory is created if absent, with requested mode `0700`.
2. A uniquely named sibling temporary file is created exclusively with mode
   `0600`.
3. JSON is written and the temporary file descriptor is synced.
4. The descriptor is closed and the temporary file is renamed over the target.
5. If any stage fails, an open descriptor is closed when possible and the
   temporary file is removed before the failure is reported.

`saveMemory` catches persistence errors, writes a concise error to stderr, and
returns `false`; it does not stop the active run. The preceding valid memory
file is therefore not truncated by a serialization or write failure, but a
failed update is not retried.

## Not implemented yet

The code does **not** currently provide a complete cross-run memory workflow:

- It does not read or validate the memory file at startup.
- It does not add prior memory to the planning or execution prompts.
- It does not ask the model to distill end-of-run memory or assign a new
  `configData.memory` value.
- It does not define a memory schema, size budget, retention policy, or
  sanitization rules.
- OpenAI Responses calls are not retried or classified by failure type;
  unhandled failures reach the top-level error logger.

Consequently, setting a `memory` property through another mechanism can use the
safe persistence primitive, but a subsequent invocation will not restore or
use that memory. Claims of durable context across runs should wait for the
missing load, prompt-injection, distillation, validation, and failure-handling
steps to be implemented and tested.

## Operational notes

The memory file is runtime state and should remain outside the repository. Use
a private path for `ELASTIC_AGENT_MEMORY_PATH`; the default is under `/tmp`.
Do not place secrets in the current unvalidated memory value, because it is
included in no special secret-management flow and is plain JSON on disk.
