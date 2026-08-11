# Project Memory

## Tool-call terminal rendering

- The tool-call terminal rendering lifecycle is intentionally scoped to the legacy `main2.js` executor.
- `main.ts` is a provider-neutral, text-only runtime and has no tool registration, execution, or renderer lifecycle. Do not claim tool-call lifecycle support there without separately scoped implementation.
- Legacy lifecycle: render a concise pending entry before parsing/execution, then a succeeded or failed terminal entry. Preserve serialized `function_call_output`, tool-call TLDR history, and actionable errors on both terminal paths.
- Implementation commit: `4a39798` (`feat: render tool call lifecycle states`). Focused lifecycle-test commit: `e436294` (`test: cover tool call rendering lifecycle`).
- Recorded verification: `npm run test:tool-rendering`, `node --check main2.js`, and `git diff --check` passed.

## Coordination

- Spec Keeper is the authoritative task/decision/handoff system for this project (`elastic-agent`).
- Agent Bus is not currently configured because `AGENT_BUS_BASE_URL` is absent; this does not block the legacy renderer task.
