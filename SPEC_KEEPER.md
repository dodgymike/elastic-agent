# Spec Keeper Operating Instructions

Spec Keeper is the authoritative source for project goals, specifications, plans, decisions, task state, and learned procedures. This file is an operating guide only; it does not replace the current server state.

## Service routes and client configuration

The hosted Spec Keeper API uses the versioned, project-scoped contract:
`/api/v1/projects/<project-slug>/<resource>`. The visible project discovered
from `GET /api/v1/projects` is `elastic-agent`; configure this as `SPEC_KEEPER_PROJECT_SLUG` (or
`projectSlug` in the approved local secret store). Pass `projectSlug` explicitly
when an invocation must target another project.

`tools/SpecKeeper.ts` maps supported resource shorthand such as `/tasks`,
`/tasks/<id>/status`, and `/tasks/<id>/chain-runs` to that project-scoped
contract. It does not map obsolete root resources such as `/goals` or
`/task-queue`; use a documented absolute `/api/v1/...` path only for endpoints
that are not project resources (for example, `GET /api/v1/projects` to discover
visible projects).

Configure the API origin with `SPEC_KEEPER_API_BASE` only when an alternate
deployment is required. Credentials and the project slug must come from the
approved environment or local secret store, never repository files. The client
rejects malformed paths and reports non-2xx responses with a bounded, redacted
diagnostic; do not copy credentials or raw server errors into task notes or
handoffs.

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
