# Help tool usage

## Purpose

Return the usage documentation for an available tool or a small built-in
reference for the `agent-busctl` CLI. Read-only; never executes the CLI.

## When to use

Use `Help` to look up a tool's usage contract without guessing. Use `Read` to
read the raw `tools/*-usage.md` file directly when the full file is needed.

## Required parameters

- `subject` (string): a tool name (`AgentBus`, `AgentBusEnrol`, `Git`,
  `ExecuteCommand`, `RunPackageScript`, `TypeCheck`, `GoToolchain`,
  `GetWorkingDirectory`, `PathInfo`, `FileHash`, `FileOps`, `RunScript`,
  `RunNodeTest`, ...) or `agent-busctl` / `agent-busctl:<subcommand>`.

## Optional parameters

None.

## Result

- `subject` (string): the requested subject.
- `source` (string): repo-relative usage doc path when the subject resolved to
  one.
- `content` (string): the usage documentation or built-in reference.

## Formatted terminal output

The runtime announces the call as `Help({...})`. On success it renders a green
circle plus a short result summary; on failure a red circle and the error
message. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Missing/blank `subject`: `TypeError`.
- Unknown subject or unreadable usage file rejects with an actionable error.

## Critical operating constraints

- Read-only; never executes a CLI or performs any filesystem mutation.
- Never reads `data.json`, credential stores, or secret files.

## Safe use

**Allowed**
- Reading tool usage docs and the built-in agent-busctl reference.

**Denied**
- Reading secret files or executing a CLI.

**Dangerous examples (do not run)**
- `Help({ subject: "data.json" })`

**Required permissions**
- Read access to `tools/*-usage.md`.

## Examples

1. Look up the Git tool contract:

   ```js
   await Help({ subject: "Git" });
   ```

2. Look up the agent-busctl reference:

   ```js
   await Help({ subject: "agent-busctl" });
   ```
