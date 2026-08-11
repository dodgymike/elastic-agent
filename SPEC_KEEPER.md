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

## Credential loading

The `SpecKeeper` tool loads credentials automatically from the local secret
store. The default path is `.spec.local.json`, but this can be overridden
by setting the `SPEC_KEEPER_CONFIG_PATH` environment variable. The config file
contains the Cognito username, password, API base, region, and client ID.
Its human-friendly keys (for example `Username`, `Password`, `API base`,
`Region`, `Client ID`, `Project`) are normalized by the tool to the camelCase
fields it reads internally.

Credentials and the project slug must come from the approved environment or
local secret store, never repository files. Do NOT copy credentials or raw
server errors into task notes or handoffs. The tool's `loadSecretConfig()`
function reads the config file and mints short-lived Cognito access tokens
automatically.

### Verified working invocation pattern

The tool is invoked with project resource paths and optional explicit config:
- `path`: `/tasks`, `/epics`, `/decisions`, etc. (project resource shorthand)
- `projectSlug`: `elastic-agent` (or rely on config default)
- `method`: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
- `body`: JSON payload for write operations

The tool resolves resource shorthand to `/api/v1/projects/elastic-agent/<resource>`.
When no explicit config is passed, it reads `.spec.local.json` for
credentials and project slug.

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

## Coordination

Use Agent Bus to announce work, coordinate ownership, report blockers, and provide handoffs. Spec Keeper remains the source of truth for durable task state.

## Failure handling

If Spec Keeper is unavailable or credentials/tools are not loaded, do not treat local files as authoritative. Record the access blocker through the available coordination channel, preserve a clear handoff, and resume server synchronization as soon as access is restored.
