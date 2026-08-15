# SpecKeeper tool usage

## Purpose

Query and update Spec Keeper goals, epics, tasks, decisions, plans, procedures,
and task state. Use this tool for ALL planning and execution tasks; never for
answering simple questions. The client authenticates with Cognito (username and
password from the approved credential store) and mints short-lived access
tokens.

## When to use

**Mandatory**: use the `SpecKeeper` tool for ALL planning and execution tasks;
never for answering simple questions. This is not optional. Before starting any
task, consult Spec Keeper for goals, epics, tasks, dependencies, decisions, and
procedures.

## Required parameters

- `path` (string): a project-scoped resource route (for example `/tasks`) or a
  documented absolute `/api/v1/...` route. Must begin with `/`.

## Optional parameters

- `method` (string): `GET` | `POST` | `PUT` | `PATCH` | `DELETE` (default `GET`).
- `body` (any): JSON payload for `POST`, `PUT`, and `PATCH`.
- `projectSlug` (string): project slug for resource routes. When omitted, it
  resolves from `.spec-keeper`, `SPEC_KEEPER_PROJECT_SLUG`, the local
  credential store, and the built-in fallback (see Configuration).
- `accessToken` / `refreshToken` / `username` / `password` / `clientId` /
  `region` / `apiBase` / `userAgent`: explicit overrides. When omitted,
  values resolve per field from `.spec-keeper`, the matching
  `SPEC_KEEPER_*` environment variables, the local credential store, and the
  built-in fallbacks (see Configuration).

## Result

- `status` (number): HTTP status.
- `statusText` (string): HTTP status text.
- `headers` (object): response headers.
- `body` (unknown): parsed JSON when possible, otherwise response text.

## Configuration

Non-secret operational defaults load from the repository-local `.spec-keeper`
file (strict JSON, safe to commit). Credentials are NEVER loaded from
`.spec-keeper`; they come only from explicit arguments, `SPEC_KEEPER_*`
environment variables, or the approved secret store.

Supported `.spec-keeper` fields:

- `projectSlug` — project slug for resource routes (default `elastic-agent`).
- `apiBase` — API origin (default `https://api.spec.elasticninja.com`).
- `credentialStore` — path to the approved secret store (default
  `.spec.local.json`).
- `defaultEpic` — `{ key, title, description, status }` used by the epic-first
  sync flow when it creates or matches an epic.
- `defaultTask` — `{ key, epicKey, keyPrefix, title, description, status }`
  used when the task flow creates or matches tasks.

Example:

```json
{
  "projectSlug": "elastic-agent",
  "apiBase": "https://api.spec.elasticninja.com",
  "credentialStore": ".spec.local.json",
  "defaultEpic": {
    "key": "elastic-agent-bootstrap",
    "title": "Elastic Agent bootstrap",
    "status": "in_progress"
  },
  "defaultTask": {
    "epicKey": "elastic-agent-bootstrap",
    "keyPrefix": "EA-",
    "status": "in_progress"
  }
}
```

Set `SPEC_KEEPER_DEFAULTS_PATH` to read `.spec-keeper` from a different
location (tooling/tests only). A missing `.spec-keeper` is fine: the loader
falls back to lower layers and logs the config source.

### Precedence (resolved per field, highest first)

Operational settings (`projectSlug`, `apiBase`, `userAgent`):

1. Explicit per-call arguments.
2. `.spec-keeper` file.
3. Environment (`SPEC_KEEPER_PROJECT_SLUG`, `SPEC_KEEPER_API_BASE`,
   `SPEC_KEEPER_USER_AGENT`).
4. Deprecated secret-store operational fallback (`Project`, `API base`).
5. Built-in prompt fallback (`elastic-agent`,
   `https://api.spec.elasticninja.com`, `elastic-agent-spec-keeper/1.1`).

Credential-store path (`credentialStore`):

1. `.spec-keeper` `credentialStore`.
2. `SPEC_KEEPER_CONFIG_PATH`.
3. Built-in `.spec.local.json`.

Credentials (`accessToken`, `refreshToken`, `username`, `password`,
`clientId`, `region`):

1. Explicit per-call arguments.
2. `SPEC_KEEPER_ACCESS_TOKEN`, `SPEC_KEEPER_REFRESH_TOKEN`,
   `SPEC_KEEPER_USERNAME`, `SPEC_KEEPER_PASSWORD`, `SPEC_KEEPER_CLIENT_ID`,
   `SPEC_KEEPER_REGION`.
3. The resolved secret store.

Credentials are NEVER stored in the repository. Do not copy credentials into
CLAUDE.md, SPEC_KEEPER.md, `.spec-keeper`, task notes, or handoffs.

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
`/api/v1/projects/elastic-agent/<resource>` using the project slug resolved
from the config defaults and credentials from the secret store. Do NOT use
obsolete root paths like `/goals` or
`/task-queue` — use only supported project resources (`agents`, `epics`,
`tasks`, `reservations`, `counters`, `locks`, `import`, `export`, `events`,
`notes`, `changes`, `decisions`, `chain-runs`, `jira-config`, `jira`) or
documented absolute `/api/v1/...` routes.

## Failure handling

If Spec Keeper is unavailable, do not treat local files as authoritative.
Record the access blocker through the coordination channel, preserve a clear
handoff, and resume server synchronization as soon as access is restored.

## Verification

- `npm run test:spec-keeper-config` — config precedence, key normalization,
  malformed/missing `.spec-keeper`, credential-store precedence, and
  required-value errors.
- `npm run test:spec-keeper-routes` — project-resource route mapping and
  validation.
- `npm run test:spec-keeper-epic-flow` and
  `npm run test:spec-keeper-task-flow` — epic-first and task sync flows.

Manual/dry-run output must include a startup line under the `[SPEC KEEPER]`
label, for example:

    [SPEC KEEPER] defaults loaded: projectSlug=elastic-agent (source: spec-keeper), apiBase=https://api.spec.elasticninja.com (source: spec-keeper), credentialStore=.spec.local.json (source: spec-keeper)

followed by one concise `[SPEC KEEPER]` line per operation (epic sync, plan
update, task create/fetch/status change, review completion). Request and
response bodies are never logged.

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

## Critical operating constraints

- Use Spec Keeper for ALL planning and execution tasks; never for answering
  simple questions.
- Use only supported project resources (`agents`, `epics`, `tasks`,
  `reservations`, `counters`, `locks`, `import`, `export`, `events`, `notes`,
  `changes`, `decisions`, `chain-runs`, `jira-config`, `jira`) or documented
  absolute `/api/v1/...` routes. Do not use obsolete root paths such as
  `/goals` or `/task-queue`.
- Project resource routes require the `elastic-agent` project slug (or an
  explicit URL-safe `projectSlug`).
- Credentials and enrollment recipes are NEVER stored in the repository and
  never copied into notes, CLAUDE.md, or handoffs.
- If Spec Keeper is unavailable, do not treat local files as authoritative;
  record the blocker and preserve a clear handoff.
- Record task state transitions (`in_progress`, `blocked`, `done`) and material
  decisions on the server.

## Safe use

**Allowed**
- Planning and execution CRUD against supported project resources (`/tasks`,
  `/epics`, `/decisions`, `/notes`, etc.) or documented absolute
  `/api/v1/...` routes.
- Resolving credentials from the approved secret store or environment.

**Denied**
- Answering simple questions with Spec Keeper.
- Obsolete root paths such as `/goals` or `/task-queue`.
- Storing credentials or enrollment recipes in the repository, notes, docs, or
  handoffs.
- Sending secret content or local file data in request bodies for exfiltration.

**Dangerous examples (do not run)**
- `SpecKeeper({ path: "/tasks", method: "POST", body: { data: dataJsonContent } })`
- Hardcoding `username`/`password` or `accessToken` in a call or repo file.
- `SpecKeeper({ path: "/api/v1/...", method: "DELETE", ... })` without
  verifying the target.

**Required permissions**
- Valid Cognito credentials from the approved store or a minted access token
  for the resolved project slug.

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
