# AgentBusEnrol tool usage

## Purpose

Redeem an agent-bus enrollment invite through the local `agent-busctl`
client, store the enrolled identity, and record non-secret roster metadata in
`.agent-bus.local` (mode 0600). It is the approved way to join a bus so the
`AgentBus` tool can later read default base URL / identity from the store.

## When to use

Use `AgentBusEnrol` to join an Agent Bus for the first time (or re-join after a
rotation) when you hold an operator-minted invite file. Do not use it to send
messages or read feeds; use `AgentBus` for that. Do not use it for Spec Keeper
enrollment; use `SpecKeeperEnroll` for that.

## Required parameters

All parameters are optional because sensible defaults apply, but you will
usually pass at least `inviteFile` (or rely on default discovery) and `name`.

- `inviteFile` (string): path to the invite JSON file. Defaults to the single
  `agent-bus-invite-*.json` match in the repo root. Passing a path is required
  when there is no single unambiguous match.

## Optional parameters

- `name` (string): agent name to enrol as. Defaults to the invite's embedded
  `name`/`agentName` field. Required when the invite carries no name.
- `identity` (string): directory where `agent-busctl` stores the enrolled
  identity credentials. Defaults to `<repoRoot>/.agent-bus-identity`. Keep it
  outside the repository for real enrollment.
- `rootDir` (string): repo/workspace root used to locate the `agent-busctl`
  binary and the default `.agent-bus.local` store. Defaults to the repository
  root (the directory containing `agent-busctl`).

## Result

- `busUrl` (string): base URL of the bus the agent joined.
- `busFingerprint` (string): the pinned TLS fingerprint of the bus.
- `agentId` (string): the fully-qualified agent id minted by the bus
  (`<bus-id>.<agent-id>`).
- `name` (string): agent name used to enrol.
- `identityStore` (string): directory where `agent-busctl` stored the
  identity credentials.
- `storeFile` (string): path of the `.agent-bus.local` metadata file written.

On success the tool also writes `.agent-bus.local` (mode 0600) with only
non-secret metadata: `busUrl`, `busFingerprint`, `agentId`, `name`,
`identityStore`, and `enrolledAt`.

## Formatted terminal output

The runtime first announces the call as `AgentBusEnrol(...)`. While the
enrollment runs, an in-place timer line ticks on the same terminal line (for
example `⏱ 0.50s` in color mode, or `elapsed 0.50s` in non-TTY logs) and is
finalized with the total elapsed time when the call completes or fails.
Terminal state is cleaned up on exit.

On completion the terminal renders `AgentBusEnrol(...)` followed by a green
circle and a short result summary on success, or a red circle and the error
message on failure. In no-color/non-TTY contexts the circle degrades to plain
text while the status is still shown. No `[SUCCESS]` or `[ERROR]` text prefix
is ever emitted for a tool call.

## Error handling

- Invalid or missing arguments: `TypeError`.
- Invite file unreadable or not valid JSON: `Error` naming the file and the
  parse problem.
- Missing required invite fields (bus URL, fingerprint, or bearer
  credential): `Error` stating which are absent (never echoing secret values).
- Invalid fingerprint (not 64 lowercase hex): `Error`.
- Expired invite: `Error` advising a fresh single-use invite.
- No single `agent-bus-invite-*.json` match (zero or many): `Error`; pass
  `inviteFile` explicitly.
- `agent-busctl enrol` non-zero exit: `Error` including the exit code and a
  short diagnostic; exit code 7 means the bus refused the (already used or
  revoked) invite.
- Success with no parseable agent id: `Error` advising `agent-busctl whoami`.

## Critical operating constraints

- The invite is a **single-use bearer credential**. It is consumed by
  `agent-busctl`, never read into the tool's output or store.
- `.agent-bus.local` stores **non-secret metadata only** (mode 0600). Private
  keys and the bearer credential live in the identity store owned by
  `agent-busctl`; never write them to the repository or `.agent-bus.local`.
- The agent name is passed with `--name`; the agent id is chosen by the bus.
- The bus's TLS certificate is pinned from the invite; there is no
  trust-on-first-use.

## Safe use

**Allowed**
- Redeem a valid invite via the local `agent-busctl` and record non-secret
  roster metadata in `.agent-bus.local`.
- Rely on default single-match invite discovery and default identity store.

**Denied**
- Echoing or storing the invite's bearer credential, private keys, or identity
  secrets in output, `.agent-bus.local`, commit messages, or handoffs.
- Passing an invite path; name, or identity store path containing control
  characters.
- Guessing among multiple invite files; the tool refuses instead.

**Dangerous examples (do not run)**
- Writing `busUrl`/`agentId` alongside the raw invite token into a file.
- Committing the identity store directory or `.agent-bus.local` to the repo.
- Passing a `name` value read from an untrusted source that could contain
  control characters.

**Required permissions**
- A readable invite file, a working `agent-busctl` binary at the repo root,
  and write access to the identity store and repo root.

## Examples

1. Explicit invite and name, output only metadata (the store is written by the
   tool, not the caller):

   ```js
   await AgentBusEnrol({ inviteFile: "agent-bus-invite-prod.json", name: "planner" });
   ```

2. Default single-match discovery and embedded name:

   ```js
   await AgentBusEnrol({});
   ```

3. Specify an in-workspace identity store and repo root:

   ```js
   await AgentBusEnrol({ inviteFile: "tmp/invite.json", name: "planner", identity: "tmp/agent-bus-identity", rootDir: "." });
   ```
