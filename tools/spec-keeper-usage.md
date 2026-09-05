# SpecKeeper tool usage

## Purpose

Query and update Spec Keeper goals, epics, tasks, decisions, plans, procedures,
and task state. Use this tool for ALL planning and execution tasks; never for
answering simple questions. The client authenticates with Cognito (username and
password from the workspace credential file or environment) and mints
short-lived access tokens.

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
- `startDirectory` (string): workspace start directory used as the
  `.spec-keeper/config` lookup key. It is canonicalized (absolute-path
  resolution plus symlink resolution) before lookup. Defaults to the runtime's
  configured `--start-dir` when present, otherwise the process working
  directory.
- `projectSlug` (string): project slug for resource routes. When omitted, it
  resolves from the `.spec-keeper/config` workspace mapping (see
  Configuration).
- `accessToken` / `refreshToken` / `username` / `password` / `clientId` /
  `region` / `apiBase` / `userAgent`: explicit overrides. When omitted,
  `apiBase` resolves from the `.spec-keeper/config` workspace mapping or the
  built-in fallback, and credentials resolve from the matching
  `SPEC_KEEPER_*` environment variables or the workspace credential file (see
  Configuration).

## Result

- `status` (number): HTTP status.
- `statusText` (string): HTTP status text.
- `headers` (object): response headers.
- `body` (unknown): parsed JSON when possible, otherwise response text.

## Configuration

Non-secret routing metadata loads from `.spec-keeper/config`, a JSON object
keyed by canonical absolute start directory. Each value carries the workspace
`projectSlug`, `credentialFile` path, and optional `apiBase`. Credentials are
NEVER loaded from `.spec-keeper/config`; they come only from explicit
arguments, `SPEC_KEEPER_*` environment variables, or the referenced
credential file (which must be owner-only, for example mode `0600`).

Example `.spec-keeper/config`:

```json
{
  "/mnt/sdb4/mike/mike/source/elastic-agent": {
    "projectSlug": "elastic-agent",
    "credentialFile": ".spec-keeper/elastic-agent.json",
    "apiBase": "https://api.spec.elasticninja.com"
  }
}
```

The registry file itself lives at `<main.ts dir>/.spec-keeper/config` by
default (resolved from the config module's own location, never from
`process.cwd()`), while its entries are keyed by canonical absolute start
directory. Lookup canonicalizes the start directory (absolute-path resolution
plus symlink resolution) and then reads the registry from the main.ts
directory (or an explicit `configDirectory` override supplied by tooling and
tests). When no mapping exists for that directory, the tool fails closed with
an actionable error that lists the configured workspaces. The referenced
`credentialFile` is resolved relative to the canonical start directory and
loaded only after the workspace mapping resolves; a missing, malformed, or
group/world-readable credential file also fails closed.

### Precedence (resolved per field, highest first)

Operational settings (`projectSlug`, `apiBase`):

1. Explicit per-call arguments.
2. `.spec-keeper/config` workspace entry.
3. Built-in fallback (`https://api.spec.elasticninja.com` for `apiBase`;
   `projectSlug` is required in the workspace entry).

Credential-file path (`credentialFile`):

1. `.spec-keeper/config` `credentialFile`, resolved relative to the canonical
   workspace start directory.

Credentials (`accessToken`, `refreshToken`, `username`, `password`,
`clientId`, `region`):

1. Explicit per-call arguments.
2. `SPEC_KEEPER_ACCESS_TOKEN`, `SPEC_KEEPER_REFRESH_TOKEN`,
   `SPEC_KEEPER_USERNAME`, `SPEC_KEEPER_PASSWORD`, `SPEC_KEEPER_CLIENT_ID`,
   `SPEC_KEEPER_REGION`.
3. The referenced workspace credential file.

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
from the `.spec-keeper/config` workspace mapping and credentials from the
workspace credential file. Do NOT use
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

- `npm run test:spec-keeper-config` — legacy config precedence, key
  normalization, malformed/missing `.spec-keeper`, credential-store
  precedence, and required-value errors.
- `npm run test:spec-keeper-workspace` — `.spec-keeper/config` registry
  layout, canonical start-directory resolution, and missing-mapping errors.
- `npm run test:spec-keeper-tool-lookup` — the SpecKeeper tool's
  workspace-keyed lookup, credential-file loading, and fail-closed
  missing/malformed/permission handling.
- `npm run test:spec-keeper-migration` — legacy `.spec-keeper` file +
  `.spec.local.json` migration into the workspace layout, secure permissions,
  and runtime-defaults reconciliation.
- `npm run test:spec-keeper-routes` — project-resource route mapping and
  validation.
- `npm run test:spec-keeper-epic-flow` and
  `npm run test:spec-keeper-task-flow` — epic-first and task sync flows.

Manual/dry-run output must include a startup line under the `[SPEC KEEPER]`
label, for example:

    [SPEC KEEPER] defaults loaded: projectSlug=elastic-agent (source: workspace), apiBase=https://api.spec.elasticninja.com (source: workspace), credentialFile=<canonical-start-dir>/.spec-keeper/elastic-agent.json (source: workspace)

followed by one concise `[SPEC KEEPER]` line per operation (epic sync, plan
update, task create/fetch/status change, review completion). Request and
response bodies are never logged.

## Formatted terminal output

The runtime first announces the call as `SpecKeeper({...})`. While the request
runs, an in-place timer line ticks on the same terminal line (for example
`⏱ 0.50s` in color mode, or `elapsed 0.50s` in non-TTY logs) and is finalized
with the total elapsed time when the call completes or fails. Terminal state
is cleaned up on exit.

On completion the terminal renders `SpecKeeper({...})` followed by a green
circle and a short result summary on success, or a red circle and the error
message on failure. In no-color/non-TTY contexts the circle degrades to plain
text while the status and summary are still shown. No `[SUCCESS]` or `[ERROR]`
text prefix is ever emitted for a tool call.

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
- Resolving credentials from the workspace credential file or environment.

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
- Valid Cognito credentials from the workspace credential file or a minted
  access token for the resolved project slug.

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
