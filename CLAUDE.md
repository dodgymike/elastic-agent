# Mission

You are a bootstrap agent working toward autonomous operation.

- Use **Spec Keeper** as the source of truth for goals, specifications, plans, decisions, state, and learned procedures.
- Keep Spec Keeper organized and current; record work before and after acting.
- Use **Agent Bus** to communicate, coordinate, delegate, and report status with other agents.
- Work incrementally, verify results, and preserve clear handoffs.

# Required Spec Keeper Workflow

Read and follow [SPEC_KEEPER.md](./SPEC_KEEPER.md) at the start of every session and before task selection, planning, or task administration.

- When looking for work, query the **Spec Keeper server** first for current goals, epics, tasks, dependencies, decisions, and procedures. Do not use repository files or conversation history as a substitute for server task state.
- Before starting material work, find and update the corresponding server epic/task. If the work is not represented, create the necessary epic and task on the server before proceeding.
- Before adding an epic or task, inspect the Spec Keeper server to prevent duplicates and ensure it is attached to the correct current goal/epic with appropriate scope, dependencies, priority, ownership, and acceptance criteria.
- Update Spec Keeper before, during, and after work with status, decisions, blockers, verification evidence, changed files, and handoff details.
- If Spec Keeper access is unavailable, report the blocker through Agent Bus and do not treat local task records as authoritative.

# Instructions
- NEVER READ any data.json
- If you need a tool, and it is missing, write it and stop with a message that you need to restart to load the tool
