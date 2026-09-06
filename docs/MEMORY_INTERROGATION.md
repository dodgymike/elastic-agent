# Hybrid memory retrieval and interrogation

## Inspect a prompt without executing it

Use the same workspace and session ID as the run that recorded the memories:

```sh
ELAGENT_MEMORY_TYPE=persistent-v2 npm start -- \
  --interrogate-memory --session-id aaaa-1112-0005 \
  --provider deepseek-v4 "What did we learn about authentication?"
```

The JSON response contains:

- `scope`, `backend`, `provider`, and `model`;
- `memories.text`: the selected, budgeted memory context;
- `memories.retrieval.items`: relevant records, scores, source event IDs, and
  match reasons for the v2 backend;
- `memories.retrieval.semanticTerms` and `semanticStatus`: expansion terms and
  whether semantic expansion succeeded, was disabled, or fell back;
- `prompt`: the full initial planning prompt, without truncation;
- `messages`: that prompt in the provider-neutral user-message representation.

CLAUDE.md comes first, followed by planning instructions, the supplied request,
and recalled memory. Interrogation shares memory retrieval and suffix assembly
with live generation and retrieves the snapshot once. It previews the **initial
planning message**, not future messages containing research tool results, tool
schemas, or provider-specific request serialization. It does not classify the
request, generate an execution plan, execute tools, claim tasks, append memory
events, or edit the agent's run state. Opening a v2 store still performs its
normal SQLite initialization/migrations.

A session ID is required to avoid silently inspecting a fresh empty session.
Task and loop modes cannot be combined with interrogation. Legacy memory modes
remain usable, but expose their existing summary behavior; a fresh in-memory or
graph process has no previous-process memories. `persistent-v2` is required for
the new durable hybrid retrieval. This change does not migrate legacy memory or
change the default backend. `ELAGENT_MEMORY_DISABLE` is respected.

For clean JSON without npm's build output, build once and invoke Node directly:

```sh
npm run build
ELAGENT_MEMORY_TYPE=persistent-v2 node dist/main.js \
  --interrogate-memory --session-id aaaa-1112-0005 \
  --provider deepseek-v4 "What did we learn about authentication?" \
  > /tmp/memory-inspection.json
```

Use the repository-supported Node version. Output includes actual recalled
content and the supplied prompt; keep inspection artifacts outside Git.

## How hybrid retrieval works

The live v2 backend now ranks records for the current query instead of always
injecting its recent-event rendering. Initial planning supplies the raw user
request as the search query, so instruction boilerplate does not dominate it.
Other initial generation paths fall back to searching their input text.

Semantic matching uses **LLM query expansion**, not an embedding/vector index.
The configured planner provider/model generates up to 12 short related terms.
For example, “login” can retrieve “authentication credential renewal” without
those exact words appearing in the query. The expansion receives only the
redacted, bounded query, never the stored memory corpus. It has a 15-second
provider-request timeout, no tools, and strict array validation. Expansion
failure retains lexical retrieval and is reported as `fallback`.

This can add one provider request per nonempty v2 query recall. It uses the
configured provider's credentials and billing. It is skipped for empty stores.
For fully offline inspection or lexical-only recall:

```sh
ELAGENT_MEMORY_SEMANTIC=0 ELAGENT_MEMORY_TYPE=persistent-v2 \
  node dist/main.js --interrogate-memory --session-id YOUR_SESSION "your query"
```

Exact scope isolation is enforced before ranking. Semantic hints cannot widen
workspace, principal, or session access, or create authoritative constraints.
Explicit constraints and open tasks retain priority; exact file matching and
lexical matching contribute alongside weaker semantic-term scores. Unrelated
ordinary records are not selected merely for recency. Superseded/retracted
structured records are excluded. Legacy outcome events contribute their stored
reasoning/findings as unverified narrative, not new authoritative facts.

Whole records are selected within the character budget; oversized records are
omitted, not sliced into incomplete facts. Returned selected records and source
contexts match what was actually included in the prompt.

## Current limits

Candidate acquisition retains the existing bounded store window (up to 200
events), and ranking returns at most 20 records by default. This is not a full
semantic index over an unlimited archive. Expansion quality depends on the
configured model, and auxiliary expansion usage is not yet included in the
main run's token totals. Cross-session search and embedding infrastructure are
separate features. Existing durable deletion and scope rules remain authoritative.

## Validation

`npm run test:memory-hybrid-interrogation` uses temporary SQLite stores and a fake
provider to cover semantic matches, scope isolation, lexical fallback, whole-
record budgets, query-only expansion, and exact live/preview prompt equality.
Also run `test:memory-retrieval`, `test:multi-turn-memory`, and
`test:multi-turn-runtime` when changing these shared boundaries.
