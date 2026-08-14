# Spec Keeper Operating Instructions

Spec Keeper is the authoritative source for project goals, specifications, plans, decisions, task state, and learned procedures. This file is an operating guide only; it does not replace the current server state.

## Definitive project configuration

| Setting | Value |
|---|---|
| **Project slug** | `elastic-agent` |
| **API base** | `https://api.spec.elasticninja.com` |
| **Cognito region** | `eu-west-1` |
| **Client ID** | `4tnoco9jd6f1bfde6ps0bldqca` |
| **Credential store** | `.spec.local.json` (default `SPEC_KEEPER_CONFIG_PATH`) |
| **Auth mechanism** | Cognito `USER_PASSWORD_AUTH` or `REFRESH_TOKEN_AUTH` via the `SpecKeeper` tool |

## Service routes and client configuration

The hosted Spec Keeper API uses the versioned, project-scoped contract:
`/api/v1/projects/<project-slug>/<resource>`. The visible project discovered
from `GET /api/v1/projects` is `elastic-agent`. This is the only project
configured for this agent.

`tools/SpecKeeper.ts` maps supported resource shorthand such as `/tasks`,
`/tasks/<id>/status`, and `/tasks/<id>/chain-runs` to that project-scoped
contract. It does not map obsolete root resources such as `/goals` or
`/task-queue`; use a documented absolute `/api/v1/...` path only for endpoints
that are not project resources (for example, `GET /api/v1/projects` to discover
visible projects).

## Non-secret defaults file (`.spec-keeper`)

Operational defaults load from the repository-local `.spec-keeper` file
(strict JSON, safe to commit). It may carry `projectSlug`, `apiBase`,
`credentialStore`, `defaultEpic`, and `defaultTask`; it must never contain
tokens, passwords, or client IDs. A missing `.spec-keeper` is harmless, and
the resolved config source is logged at startup under `[SPEC KEEPER]`.

Precedence, resolved per field:

1. Explicit per-call tool arguments.
2. `.spec-keeper`.
3. `SPEC_KEEPER_PROJECT_SLUG` / `SPEC_KEEPER_API_BASE` /
   `SPEC_KEEPER_USER_AGENT` (and `SPEC_KEEPER_CONFIG_PATH` for the credential
   store path).
4. Deprecated operational fallback fields in the secret store (`Project`,
   `API base`).
5. Built-in prompt fallback (`elastic-agent`,
   `https://api.spec.elasticninja.com`, `elastic-agent-spec-keeper/1.1`).

## Credential loading

The `SpecKeeper` tool loads credentials automatically from the local secret
store. The default path is `.spec.local.json`, but this can be overridden by
`.spec-keeper` `credentialStore` or the `SPEC_KEEPER_CONFIG_PATH` environment
variable (see precedence above). The config file contains the Cognito
username, password, API base, region, and client ID. Its human-friendly keys
(for example `Username`, `Password`, `API base`, `Region`, `Client ID`,
`Project`) are normalized by the tool to the camelCase fields it reads
internally.

Credentials must come from the approved environment or local secret store,
never from `.spec-keeper` or other repository files. Do NOT copy credentials
or raw server errors into task notes or handoffs. The tool's
`loadSecretConfig()` function reads the secret store and mints short-lived
Cognito access tokens automatically.

### Verified working invocation pattern

The tool is invoked with project resource paths and optional explicit config:
- `path`: `/tasks`, `/epics`, `/decisions`, etc. (project resource shorthand)
- `projectSlug`: `elastic-agent` (or rely on config default)
- `method`: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
- `body`: JSON payload for write operations

The tool resolves resource shorthand to `/api/v1/projects/elastic-agent/<resource>`.
When no explicit config is passed, it reads `.spec-keeper` for operational
defaults (project slug, API base, credential-store path, default epic/task)
and the resolved secret store for credentials.

### Reliable patterns from bootstrap usage

- **Project discovery**: `GET /api/v1/projects` returns the full list of visible projects. The enrolled project is `elastic-agent`.
- **Task state transitions**: Use `POST /tasks/<id>/status` (or the appropriate resource endpoint as documented by the server schema).
- **Task notes**: `POST /tasks/<id>/notes` for adding notes to a task.
- **Absolute `/api/v1` routes** are passed through unchanged for non-project endpoints.

## Required workflow

1. **Before selecting or starting work**, query the Spec Keeper server for the project's current goals, active epics, tasks, dependencies, decisions, and procedures. Do not infer the next task from repository files, chat history, or a local task list when the server is available.
2. **Before making a material change**, locate the corresponding epic/task in Spec Keeper. If none exists, create or update the appropriate epic and task on the server first, including scope and acceptance criteria.
3. **When adding epics or tasks**, consult the server first to avoid duplicate or conflicting work. Place new work under the correct current goal or epic and record its dependencies, priority, owner, and acceptance criteria as supported by the server schema.
4. **During work**, keep task status and relevant plan/decision records current in Spec Keeper. Record blockers and handoff information promptly.
5. **After verification**, update the server record with the outcome, evidence, changed files, follow-up work, and final status. Do not mark work complete until verification has succeeded.

## Verification

Run `npm run test:spec-keeper-config` and `npm run test:spec-keeper-routes`
after changing config or route handling, plus
`npm run test:spec-keeper-epic-flow` and `npm run test:spec-keeper-task-flow`
for the sync flows. Manual/dry-run output must include a startup line such as:

    [SPEC KEEPER] defaults loaded: projectSlug=elastic-agent (source: spec-keeper), apiBase=https://api.spec.elasticninja.com (source: spec-keeper), credentialStore=.spec.local.json (source: spec-keeper)

followed by one `[SPEC KEEPER]` line per sync operation. Request and response
bodies and credentials are never logged.

## Coordination

Use Agent Bus to announce work, coordinate ownership, report blockers, and provide handoffs. Spec Keeper remains the source of truth for durable task state.

## Failure handling

If Spec Keeper is unavailable or credentials/tools are not loaded, do not treat local files as authoritative. Record the access blocker through the available coordination channel, preserve a clear handoff, and resume server synchronization as soon as access is restored.
