# SpecKeeper tool usage

## Purpose

Query and update Spec Keeper goals, epics, tasks, decisions, plans, procedures,
and task state. Use this tool for ALL planning and execution tasks; never for
answering simple questions. The client authenticates with Cognito (username and
password from the approved credential store) and mints short-lived access
tokens.

## Mandatory requirement

Use the `SpecKeeper` tool for ALL planning and execution tasks. This is not
optional. Before starting any task, consult Spec Keeper for goals, epics,
tasks, dependencies, decisions, and procedures.

## Required parameters

- `path` (string): a project-scoped resource route (for example `/tasks`) or a
  documented absolute `/api/v1/...` route. Must begin with `/`.

## Optional parameters

- `method` (string): `GET` | `POST` | `PUT` | `PATCH` | `DELETE` (default `GET`).
- `body` (any): JSON payload for `POST`, `PUT`, and `PATCH`.
- `projectSlug` (string): project slug for resource routes.
- `accessToken` / `refreshToken` / `username` / `password` / `clientId` /
  `region` / `apiBase` / `userAgent`: explicit overrides; otherwise resolved
  from the matching `SPEC_KEEPER_*` environment variables or the local
  credential store.

## Result

- `status` (number): HTTP status.
- `statusText` (string): HTTP status text.
- `headers` (object): response headers.
- `body` (unknown): parsed JSON when possible, otherwise response text.

## Configuration

- **Project slug**: `elastic-agent`.
- **Credential store**: `.spec.local.json` (default `SPEC_KEEPER_CONFIG_PATH`),
  or set the `SPEC_KEEPER_CONFIG_PATH` env var to point at the approved secret
  store.
- **API base**: `https://api.spec.elasticninja.com` (default; override via
  `SPEC_KEEPER_API_BASE` only when needed).
- **Auth**: Cognito username/password stored in the credential config. The
  `SpecKeeper` tool loads them automatically from the config file and mints
  short-lived access tokens.
- Credentials are NEVER stored in the repository. Do not copy credentials into
  CLAUDE.md, SPEC_KEEPER.md, task notes, or handoffs.

## When to consult Spec Keeper

1. **Before selecting or beginning any work** — query the server for current
   goals, task queue, task state, dependencies, and existing context. Choose the
   appropriate task from server state, not from local files or assumptions.
2. **At every task state transition** — update the task status as work starts
   (`in_progress`), progresses, becomes blocked (`blocked`), and completes
   (`done`).
3. **Before making a material change** — locate the corresponding epic/task in
   Spec Keeper. If none exists, create one on the server with scope and
   acceptance criteria.
4. **When the execution approach, scope, dependencies, or sequencing changes** —
   update the task plan in Spec Keeper.
5. **When a material decision is made** — record it and its rationale in Spec
   Keeper.
6. **When blocked** — record the blocker with impact, what's needed, and any
   dependency/owner.
7. **When pausing, transferring, or completing work** — create/update handoffs
   with current state, verification performed, remaining work, and next action.

## State transitions to record

- Task **started** → set status to `in_progress`.
- Task **progress** → add notes / update plan as applicable.
- Task **blocked** → set status to `blocked`, record blocker.
- Task **completed** → verify first, then set status to `done` with outcome,
  evidence, and follow-up.

## Invocation pattern

Use project-scoped resource paths (e.g., `/tasks`, `/epics`, `/decisions`,
`/notes`). The tool automatically resolves these to
`/api/v1/projects/elastic-agent/<resource>` using the project slug and
credentials from the config. Do NOT use obsolete root paths like `/goals` or
`/task-queue` — use only supported project resources (`agents`, `epics`,
`tasks`, `reservations`, `counters`, `locks`, `import`, `export`, `events`,
`notes`, `changes`, `decisions`, `chain-runs`, `jira-config`, `jira`) or
documented absolute `/api/v1/...` routes.

## Failure handling

If Spec Keeper is unavailable, do not treat local files as authoritative.
Record the access blocker through the coordination channel, preserve a clear
handoff, and resume server synchronization as soon as access is restored.

## Error handling

- `path` not absolute, contains control characters, or uses an unsupported
  resource: `Error` before any request is sent.
- Project resource route without a valid `projectSlug`: `Error`.
- Missing access token and no way to mint one (no region/client ID/credentials):
  `Error`.
- Cognito authentication failure: `Error` with the HTTP status.
- Non-OK API response: throws with the method, resolved path, status, and a
  redacted diagnostic (secret-shaped values are redacted).
- Network failure: throws `Spec Keeper request <METHOD> <path> could not be sent.`

## Examples

1. Read the task queue:

   ```js
   await SpecKeeper({ path: "/tasks", method: "GET" });
   ```

2. Create a task:

   ```js
   await SpecKeeper({
     path: "/tasks",
     method: "POST",
     body: {
       key: "my-task",
       title: "My task",
       description: "Scope and acceptance criteria...",
       epic_key: "spec-keeper-bootstrap",
       status: "in_progress",
     },
   });
   ```

3. Mark a task in progress / done:

   ```js
   await SpecKeeper({ path: "/tasks/my-task", method: "PATCH", body: { status: "in_progress" } });
   await SpecKeeper({ path: "/tasks/my-task", method: "PATCH", body: { status: "done", status_note: "Verified and committed." } });
   ```

4. Record a decision:

   ```js
   await SpecKeeper({ path: "/decisions", method: "POST", body: { title: "...", rationale: "..." } });
   ```
