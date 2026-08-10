# Spec Keeper Operating Instructions

Spec Keeper is the authoritative source for project goals, specifications, plans, decisions, task state, and learned procedures. This file is an operating guide only; it does not replace the current server state.

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
