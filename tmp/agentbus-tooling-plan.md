# Agent Bus tooling plan — Spec Keeper synchronization artifact

> **Status: BLOCKED (Spec Keeper offline).** This file is a **non-authoritative**
> local mirror of the plan that must be recorded in Spec Keeper once access is
> restored. Per `SPEC_KEEPER.md` failure handling, local files are NOT
> authoritative; this artifact exists only to preserve the plan and the access
> blocker as a handoff, so server synchronization can resume.
>
> It contains NO credentials, tokens, invite content, or secret-store material.
> Do not copy any secret here under any circumstances.

## Access blocker

- The `SpecKeeper` tool requires Cognito credentials (an access token, a
  refresh token, or enrolled username/password + region + client ID) resolved
  from the approved secret store (default `.spec.local.json`) or
  `SPEC_KEEPER_*` environment variables. None are available in this
  environment, and the tool-safety classifier fails closed on any probe of the
  secret store.
- The Agent Bus coordination channel (for reporting the blocker) is likewise
  unavailable: the enrolled identity store is empty and the sanctioned read
  path is denied.
- **Impact:** the plan below could not be committed to the Spec Keeper server.
- **What is needed:** restored Spec Keeper credentials / seeded secret store;
  then run the plan-recording operations below verbatim.
- **Owner:** coordinator / agent with valid Spec Keeper enrolment.

## Plan to record (verbatim once Spec Keeper is reachable)

Project slug: `elastic-agent` (defaults from `.spec-keeper`).

### Epic: agent-bus-tooling

- **Title:** Agent Bus tooling: AgentBusEnrol tool + AgentBus secrets-store usage
- **Description:** Add an `AgentBusEnrol` tool that redeems an agent-bus invite
  through the local `agent-busctl enrol --invite-file --name` command and stores
  credentials in a local `.agent-bus.local` store (mode 0600); enhance the
  existing `AgentBus` tool to read default base URL / identity / token from that
  store with env/per-call override precedence; add defaults, focused TypeScript
  tests, usage docs, and `.gitignore` entries.
- **Status:** `in_progress` (once recorded).

### Task: EA-agentbus-tooling (key prefix `EA-`)

- **Epic:** agent-bus-tooling
- **Title:** Agent Bus tooling: AgentBusEnrol + AgentBus secrets-store usage
- **Status:** `in_progress`
- **Acceptance criteria:** the AgentBusEnrol tool parses/validates the invite,
  shells out to `agent-busctl enrol --invite-file --name --identity`, writes
  non-secret metadata to `.agent-bus.local` (chmod 600), defaults single-match
  invite discovery (`agent-bus-invite-*.json`), and fails safely with actionable
  diagnostics; the AgentBus tool reads defaults from `.agent-bus.local` with
  env/per-call override precedence; tests cover valid/invalid invite, missing
  fields, default discovery, credential reading, and no secret leakage;
  `.gitignore` excludes `.agent-bus.local`; usage docs updated.

### Plan notes (record as task notes / progress)

1. Implement `tools/AgentBusEnrol.ts` mirroring `tools/SpecKeeperEnroll.ts`
   (TypeScript): parse + validate invite JSON, reject invalid JSON / missing
   fields, invoke repo-root `./agent-busctl enrol --invite-file --name
   (--identity resolvable to an in-workspace store such as `.agent-bus.local`)`,
   write non-secret metadata to `.agent-bus.local` (chmod 600), default invite
   discovery (`agent-bus-invite-*.json` single match), fail safely with
   actionable diagnostics. Register in `main.ts`; add
   `tools/agent-bus-enrol-usage.md`.
2. Enhance `tools/AgentBus.ts` to read default base URL / identity / token from
   `.agent-bus.local` mirroring the `SpecKeeper.ts` `loadSecretConfig` pattern
   with env/per-call override precedence; register new params; update
   `tools/agent-bus-usage.md`.
3. Add defaults (invite filename pattern, identity store path) to the new
   tooling.
4. Add TypeScript tests in `test/` (`agent-bus-enrol.test.ts`,
   `agent-bus.test.ts`) mocking the `agent-busctl` subprocess; add npm test
   scripts mirroring existing patterns.
5. Update docs: `README`/usage docs and `.gitignore` (add `.agent-bus.local`).
6. Run tests, `tsc --noEmit`, `git diff --check`; commit.

## Handoff

All work for the remaining plan steps is described in the surrounding task
execution plan (steps 1-10). This artifact preserves the Spec Keeper
synchronization intent only; it is not an authoritative task record.
