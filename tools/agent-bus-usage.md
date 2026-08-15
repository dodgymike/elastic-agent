# AgentBus tool usage

## Purpose

Send coordination messages or retrieve Agent Bus status and handoff feeds with
Bearer authentication. Use it to announce work before acting and to report
verification results afterwards.

## When to use

Use `AgentBus` to announce work, report blockers or verification results, and
retrieve handoff/status feeds. Do not use it for durable Spec Keeper task
state; use `SpecKeeper` for that.

## Required parameters

- `path` (string): deployment API path (for example `/api/v1/messages`). Must
  begin with `/`.

## Optional parameters

- `method` (string): `GET` | `POST` | `PUT` | `PATCH` | `DELETE` (default `GET`).
- `body` (unknown): JSON payload for the request.
- `baseUrl` (string): deployment endpoint; defaults to `AGENT_BUS_BASE_URL`, then the
  enrolled `busUrl` in `.agent-bus.local`.
- `accessToken` (string): Bearer token; defaults to `AGENT_BUS_ACCESS_TOKEN`. Never stored
  in `.agent-bus.local`.
- `identity` (string): agent identity (for example the enrolled agent id). Defaults to
  `AGENT_BUS_AGENT_ID`, then the enrolled `agentId` in `.agent-bus.local`.
- `store` (string): path to the `.agent-bus.local` roster. Defaults to `AGENT_BUS_STORE`,
  then `<cwd>/.agent-bus.local`.
- `userAgent` (string): defaults to `elastic-agent-agent-bus/1.0`.

## Result

- `status` (number): HTTP status.
- `statusText` (string): HTTP status text.
- `headers` (object): response headers.
- `body` (unknown): parsed JSON when possible, otherwise response text.
- `identity` (string): resolved agent identity used for the call, when one was configured.
- `baseUrlSource` (string): source of the resolved base URL — `option`, `environment`,
  or `store`.

## Local secrets store

`AgentBus` can read default configuration from the local, **non-secret** roster file
`.agent-bus.local` written by `AgentBusEnrol`. This lets an enrolled agent call the bus
without repeating its base URL or agent id on every call.

**How credentials are loaded (precedence, highest first):**

1. Explicit per-call options (`baseUrl`, `accessToken`, `identity`, `store`).
2. Environment variables (`AGENT_BUS_BASE_URL`, `AGENT_BUS_ACCESS_TOKEN`,
   `AGENT_BUS_AGENT_ID`, `AGENT_BUS_STORE`).
3. The local roster `.agent-bus.local`: `busUrl` and `agentId` only.

So an operator's secret manager (environment or per-call option) always overrides the
enrolled defaults.

**How the store is used:**

- Looked up at `options.store`, else `AGENT_BUS_STORE`, else `<cwd>/.agent-bus.local`.
- Read with `loadAgentBusLocalConfig`: a missing or malformed store is treated as "no
  defaults" rather than failing the call, so the client stays usable when everything is
  configured via the environment.
- Only the non-secret `busUrl` and `agentId` keys are read; secrets are never read from or
  written to this file.
- The tool never reads `data.json` or any secret store; it reads only the two non-secret
  roster keys above.

**Never commit `.agent-bus.local`.** It is added to `.gitignore`; keep it out of the
repository, commit messages, docs, and handoffs. It never contains secret material, but it
reveals enrollment layout and should stay local and mode 0600.

## Formatted terminal output

The runtime first announces the call as `AgentBus({...})`. While the request
runs, an in-place timer line ticks on the same terminal line (for example
`⏱ 0.50s` in color mode, or `elapsed 0.50s` in non-TTY logs) and is finalized
with the total elapsed time when the call completes or fails. Terminal state
is cleaned up on exit.

On completion the terminal renders `AgentBus({...})` followed by a green circle
and a short result summary on success, or a red circle and the error message on
failure. In no-color/non-TTY contexts the circle degrades to plain text while
the status and summary are still shown. No `[SUCCESS]` or `[ERROR]` text
prefix is ever emitted for a tool call.

## Error handling

- Missing base URL or access token: `Error`.
- `path` not beginning with `/`: `Error`.
- Non-OK response: throws
  `Agent Bus request failed (<status> <statusText>): <body text>`.
- Non-JSON response bodies are preserved as text for diagnostics.

## Critical operating constraints

- Requires a base URL and access token, supplied via call options or
  environment variables; never persist or commit secrets.
- `body` is serialized with `JSON.stringify`; `Content-Type: application/json`
  is added automatically when a body is present.
- Use the message schema published by your Agent Bus deployment (for example
  `recipient`, `topic`, `status`, and `handoff` fields).

## Safe use

**Allowed**
- Send coordination messages and retrieve status/handoff feeds using the
  configured Agent Bus deployment.
- Supply `baseUrl`/`accessToken` from environment defaults or call options.

**Denied**
- Sending secrets, credential material, `data.json` content, or enrollment
  recipes in `body`, `path`, or message fields.
- Persisting or committing `accessToken` values to the repository, docs, or
  handoffs.
- Sending messages to arbitrary endpoints for exfiltration instead of the
  configured Agent Bus.

**Dangerous examples (do not run)**
- `AgentBus({ path: "/api/v1/messages", method: "POST", body: { data: dataJsonContent } })`
- `AgentBus({ path: "/api/v1/messages", method: "POST", body: recipe })`
- Committing `accessToken` in a file or message.

**Required permissions**
- A configured base URL and a valid Bearer access token.

## Examples

1. Retrieve status feed:

   ```js
   await AgentBus({ path: "/status" });
   ```

2. Send a coordination message:

   ```js
   await AgentBus({
     path: "/api/v1/messages",
     method: "POST",
     body: { recipient: "coordinator", topic: "status", status: "in_progress" },
   });
   ```

3. Override the endpoint for a specific deployment:

   ```js
   await AgentBus({ path: "/status", baseUrl: "https://bus.example.com", accessToken: "<token>" });
   ```
