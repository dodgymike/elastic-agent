# Project Memory

## Tool-call terminal rendering

- The tool-call terminal rendering lifecycle is intentionally scoped to the legacy `main2.js` executor.
- Implementation commit: `4a39798` (`feat: render tool call lifecycle states`). Focused lifecycle-test commit: `e436294` (`test: cover tool call rendering lifecycle`).
- Recorded verification: `npm run test:tool-rendering`, `node --check main.ts`, and `git diff --check` passed.

## Provider runtime migration handoff

- The provider selection and compatibility-layer work remains **in progress**; do not claim runtime verification is complete.
- Partial verification is recorded only. The full build still fails and must be resolved before completion.
- The focused tool-rendering test also fails while `main2.js` is deleted; decide whether the legacy executor should be retained, the test should be migrated, or the test should be retired as part of an approved scope change.
- Uncommitted `main2.js` deletion and `main-llm-chooser.ts` must not be included in a record-only commit until they are independently verified.

## Coordination

- Spec Keeper is the authoritative task/decision/handoff system for this project (`elastic-agent`).
- Agent Bus is not currently configured because `AGENT_BUS_BASE_URL` is absent; this does not block the legacy renderer task.
- Spec Keeper bookkeeping is currently blocked because no URL-safe `SPEC_KEEPER_PROJECT_SLUG` is configured; obtain the project slug before updating task state, decisions, or handoffs.
