# AgentBus tool usage

## Purpose

Send coordination messages, wait (long-poll) for incoming messages, and check
the current identity — all **exclusively through the local `./agent-busctl`
CLI**. This tool never issues a raw HTTP request and never reads a bearer/access
token; the `agent-busctl` credential store owns all secret material, and the
tool only passes it the non-secret `--identity <dir>` path.

Use it to announce work before acting and to report verification results
afterwards.

> **Loop-mode polling does NOT use this tool.** Loop-mode Agent Bus reads (the
> pre-planning poll, between-step polls, and the idle loop) shell out to the
> `agent-busctl` CLI (`loop-busctl-read.ts`) with their own cursor management and
> are independent of this tool.

## Actions (the only three)

This tool supports exactly three `agent-busctl` actions:

1. **whoami** — show the identity this shell acts as.
   `agent-busctl ... whoami`
2. **watch** — long-poll wait for messages addressed to you as they arrive.
   `agent-busctl ... watch [--for <dur>] [--count N]`
3. **send** — send a direct message to one fully-qualified agent.
   `agent-busctl ... send <to-agent-id> <body>`

The action is chosen from `action` (defaults inferred from the other flags:
`to` → send, a wait bound → watch, otherwise whoami). If a requested action has
no `agent-busctl` subcommand the tool **fails fast with a clear diagnostic** —
it never falls back to any HTTP path.

## Default flags (always applied)

Every invocation is prefixed with:

- `--identity <dir>` — the credential-store **directory**. Default resolution,
  highest precedence wins:
  1. explicit `identity` option;
  2. `AGENT_BUS_IDENTITY` env;
  3. the enrolled `identityStore` recorded in `.agent-bus.local` (written by
     `AgentBusEnrol`), so the tool always points at the store the identity was
     actually enrolled into — even when that differs from the default below;
  4. `<root>/tmp/elastic-identity` (overridable via `identity`).
- `--persist-session` — reuse the session token across processes so repeated
  shell-outs don't lock the identity out; overridable via `persistSession:
  false`.

Explicit options override these defaults. Preferring the roster's `identityStore`
avoids the classic `no identity has been enrolled` (exit 3) failure that happens
when `--identity` is pointed at a store that has no enrolled identity even
though an identity exists at the enrolled location.

## Parameters

- `action` (string): `whoami` | `watch` | `send`. Optional; inferred from the
  other flags when omitted.
- `verify` (boolean): [whoami] authenticate against the bus (`--verify`).
- `forDuration` (string): [watch] how long to wait, e.g. `"30s"`, `"5m"`
  (`--for <dur>`). A bounded watch that receives nothing exits 8 ("nothing
  arrived") rather than an error.
- `count` (number): [watch] stop after N messages (`--count N`).
- `to` (string): [send] fully-qualified recipient `<bus-id>.<agent-id>`; a bare
  name is refused by `agent-busctl`.
- `message` (string): [send] the message body, sent verbatim as a single
  argument. **Must never carry secret-store contents.**
- `json` (boolean): machine-readable output (`--json`). Defaults true.
- `identity` (string): override the default `--identity <dir>` credential-store
  directory. Defaults to `<root>/tmp/elastic-identity` (unless `.agent-bus.local`
  records an `identityStore`, which is preferred).
- `persistSession` (boolean): apply `--persist-session`. Defaults true.
- `busUrl` (string): override the `--bus <url>`. When omitted, the CLI resolves
  it from its own store / `AGENT_BUS_URL` / `.agent-bus.local`.
- `binary` (string): path to the `agent-busctl` binary. Defaults to
  `<root>/agent-busctl`, else `AGENT_BUSCTL`, else a `PATH` lookup.
- `root` (string): workspace root used to resolve relative paths and the default
  identity directory. Defaults to the current working directory.

## Result

- `action` (string): the action that ran.
- `binary` (string): the `agent-busctl` binary invoked.
- `exitCode` (number): process exit code (0 on success).
- `stdout` (string): raw stdout.
- `stderr` (string): raw stderr diagnostics (never secret material).
- `messages` (array): parsed message records for `watch` (NDJSON); empty
  otherwise.
- `identity` (string): resolved `--identity` credential-store directory.
- `persistSession` (boolean): whether `--persist-session` was applied.
- `busUrl` (string, optional): the resolved `--bus` URL, when one was provided.

## Local secrets store

The `agent-busctl` CLI resolves the bus URL and its own credential from its
enrolled identity store (`--identity`). This tool never reads the store for the
credential and never reads `data.json` or any secret store. It reads only the
non-secret `--identity` directory path so the CLI can locate the store.

**Never commit `.agent-bus.local`** or the identity store contents; they are
git-ignored and must stay out of the repository, docs, and handoffs.

## Formatted terminal output

The runtime first announces the call as `AgentBus({...})`. While the CLI runs, an
in-place timer line ticks on the same terminal line and is finalized with the
total elapsed time when the call completes or fails. On completion the terminal
renders `AgentBus({...})` with a green/red status summary. No `[SUCCESS]` or
`[ERROR]` text prefix is ever emitted for a tool call.

## Error handling

- A missing/unsupported action that has no `agent-busctl` subcommand: the tool
  **fails fast** and never falls back to HTTP.
- A `agent-busctl` binary that cannot be run: `Error` with the binary path.
- A non-zero `agent-busctl` exit code: throws
  `agent-busctl <action> failed (exit N) against '<binary>': <stderr>`.
- A bounded `watch` that receives nothing exits 8 and is reported as a
  non-zero-exit diagnostic ("nothing arrived"), not a thrown transport error.

## Critical operating constraints

- Talks to the bus **only** through `./agent-busctl`; never via HTTP, `fetch`,
  or a network client.
- The default flags `--identity <dir>` and `--persist-session` are always
  applied; explicit options override them.
- Never read `data.json`; never send secret-store contents, enrollment recipes,
  invite codes, or private keys in a `message`.

## Safe use

**Allowed**
- Send coordination messages to other agents/people, long-poll wait for
  incoming messages, and check identity via `./agent-busctl`.
- Outbound messages are **agent-to-agent communication**, not secret-store
  exfiltration.
- Supply `identity`/`forDuration`/`count`/`busUrl`/`binary` overrides.

**Denied**
- Sending secrets, credential material, `data.json` content, or enrollment
  recipes in `message`, `to`, or any field.
- Falling back to an HTTP transport if the CLI lacks a subcommand.
- Persisting or committing `.agent-bus.local` or the identity store contents.

**Dangerous examples (do not run)**
- `AgentBus({ action: "send", to: "...", message: dataJsonContent })`
- `AgentBus({ action: "send", to: "...", message: recipe })`

**Required permissions**
- A valid `agent-busctl` enrolment (the `--identity` store must be populated via
  `AgentBusEnrol`).

## Examples

1. Check identity:

   ```js
   await AgentBus({ action: "whoami" });
   ```

2. Long-poll wait up to 30s for one incoming message:

   ```js
   await AgentBus({ action: "watch", forDuration: "30s", count: 1 });
   ```

3. Send a coordination message to a fully-qualified agent:

   ```js
   await AgentBus({ action: "send", to: "bus-id.recipient", message: "status in_progress" });
   ```

4. Long-poll wait with an explicit identity override:

   ```js
   await AgentBus({ action: "watch", forDuration: "5s", identity: "tmp/elastic-identity" });
   ```
