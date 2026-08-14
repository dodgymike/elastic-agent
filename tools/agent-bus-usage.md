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
