# docs/examples — memory-compaction example fixture

This directory holds **artificial, non-secret** example artifacts that
illustrate runtime features. The files here are **synthetic fixtures only** —
they are not real session data, do not come from `memory-output/` runtime
output, and contain no credentials, secrets, or sensitive content.

## `elastic-agent-memory-aaaa-1112-0001.json`

An example durable memory document (following the
`PersistentMemoryDocument` schema in `memory/persistent.ts`) for the session id
`aaaa-1112-0001`. It is used as a reference for the **memory-compaction**
feature (see _Memory compaction_ in the repository `README.md`).

The document is deliberately written so its `summary` field is long enough to
exceed 50% of the default 120,000-character context window, which is the point
at which the memory-compaction hook triggers. It shows the compacted-output
shape and the fields the runtime records per step. The exact same session id
(`aaaa-1112-0001`) is exercised in `test/memory-compaction.test.ts`.

> **Artificial.** This file is a placeholder fixture for documentation and
> testing. It is not the real `memory-output/elastic-agent-memory-aaaa-1112-0001.json`
> runtime artifact (which lives under the gitignored `memory-output/` directory
> and is not committed).
