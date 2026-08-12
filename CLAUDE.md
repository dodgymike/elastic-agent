# Mission

You are a bootstrap agent working toward autonomous operation.

- Work incrementally, verify results, and preserve clear handoffs.

## File editing (Read / Write / Edit)

- Every `Read` of a file returns a `read_hash` (SHA-256 of the file content). Always pass that `read_hash` back when you then edit the file.
- `Edit` changes a file in place using `old_string`/`new_string` (or an `edits` array) and applies only when the current file SHA-256 matches the `read_hash` you supply. If `Edit` reports the file changed (hash mismatch) or an `old_string` appears more than once, re-`Read` the file first to get its current `read_hash` and content.
- `Write` for an existing file likewise requires the `read_hash` from the most recent `Read`.

# Instructions
- NEVER READ any data.json
- If you need a tool, and it is missing, write it and stop with a message that you need to restart to load the tool
- Always commit your changes with a useful git commit message, when you are done
- Use Spec Keeper when planning and executing a task that requires planning, NEVER WHEN ANSWERING QUESTIONS

# Spec Keeper workflow

## Mandatory requirement

Use the `SpecKeeper` tool for ALL planning and execution tasks. This is not optional.
Before starting any task, consult Spec Keeper for goals, epics, tasks, dependencies, decisions, and procedures.

## Configuration

- **Project slug**: `elastic-agent`
- **Credential store**: `.spec.local.json` (default `SPEC_KEEPER_CONFIG_PATH`), or set the `SPEC_KEEPER_CONFIG_PATH` env var to point at the approved secret store
- **API base**: `https://api.spec.elasticninja.com` (default; override via `SPEC_KEEPER_API_BASE` only when needed)
- **Auth**: Cognito username/password stored in the credential config. The `SpecKeeper` tool loads them automatically from the config file and mints short-lived access tokens.
- Credentials are NEVER stored in the repository. Do not copy credentials into CLAUDE.md, SPEC_KEEPER.md, task notes, or handoffs.

## When to consult Spec Keeper

1. **Before selecting or beginning any work** — query the server for current goals, task queue, task state, dependencies, and existing context. Choose the appropriate task from server state, not from local files or assumptions.
2. **At every task state transition** — update the task status as work starts (`in_progress`), progresses, becomes blocked (`blocked`), and completes (`done`).
3. **Before making a material change** — locate the corresponding epic/task in Spec Keeper. If none exists, create one on the server with scope and acceptance criteria.
4. **When the execution approach, scope, dependencies, or sequencing changes** — update the task plan in Spec Keeper.
5. **When a material decision is made** — record it and its rationale in Spec Keeper.
6. **When blocked** — record the blocker with impact, what's needed, and any dependency/owner.
7. **When pausing, transferring, or completing work** — create/update handoffs with current state, verification performed, remaining work, and next action.

## State transitions to record

- Task **started** → set status to `in_progress`
- Task **progress** → add notes / update plan as applicable
- Task **blocked** → set status to `blocked`, record blocker
- Task **completed** → verify first, then set status to `done` with outcome, evidence, and follow-up

## Invocation pattern

Use the `SpecKeeper` tool with project-scoped resource paths (e.g., `/tasks`, `/epics`, `/decisions`, `/notes`). The tool automatically resolves these to `/api/v1/projects/elastic-agent/<resource>` using the project slug and credentials from the config. Do NOT use obsolete root paths like `/goals` or `/task-queue` — use only supported project resources (agents, epics, tasks, reservations, counters, locks, import, export, events, notes, changes, decisions, chain-runs, jira-config, jira) or documented absolute `/api/v1/...` routes.

## Failure handling

If Spec Keeper is unavailable, do not treat local files as authoritative. Record the access blocker through the coordination channel, preserve a clear handoff, and resume server synchronization as soon as access is restored.
