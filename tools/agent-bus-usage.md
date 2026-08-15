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
- `baseUrl` (string): deployment endpoint; defaults to `AGENT_BUS_BASE_URL`.
- `accessToken` (string): Bearer token; defaults to `AGENT_BUS_ACCESS_TOKEN`.
- `userAgent` (string): defaults to `elastic-agent-agent-bus/1.0`.

## Result

- `status` (number): HTTP status.
- `statusText` (string): HTTP status text.
- `headers` (object): response headers.
- `body` (unknown): parsed JSON when possible, otherwise response text.

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
