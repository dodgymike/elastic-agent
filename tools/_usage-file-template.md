# Tool usage file template

This template defines the naming convention and required structure for the
per-tool usage prompt files under `tools/`.

## Naming convention

- Create exactly one usage file per exposed tool.
- Path: `tools/<tool-name>-usage.md`, where `<tool-name>` is the tool's
  registered name converted to lower-kebab-case.
- The path must be repository-relative and readable with the `Read` tool.
- The same path must be stored in the tool definition's `usage_prompt` field.

Examples:

| Tool name            | Usage file                              |
|----------------------|-----------------------------------------|
| `Read`               | `tools/read-usage.md`                   |
| `Write`              | `tools/write-usage.md`                  |
| `Edit`               | `tools/edit-usage.md`                   |
| `Http`               | `tools/http-usage.md`                   |
| `HttpRequest`        | `tools/http-request-usage.md`           |
| `ListDirectory`      | `tools/list-directory-usage.md`         |
| `ExecuteCommand`     | `tools/execute-command-usage.md`        |
| `Git`                | `tools/git-usage.md`                    |
| `AgentBus`           | `tools/agent-bus-usage.md`              |
| `SpecKeeper`         | `tools/spec-keeper-usage.md`            |
| `SpecKeeperEnroll`   | `tools/spec-keeper-enroll-usage.md`     |

## Required sections

Each usage file must include the following sections, in order:

1. `# <ToolName> tool usage` — title.
2. `## Purpose` — one or two sentences on what the tool does.
3. `## When to use` — when to select this tool rather than another one, and
   any planning/execution versus question-answering constraints.
4. `## Required parameters` — every required parameter with name, type, and
   meaning.
5. `## Optional parameters` — omit this section when the tool has none.
6. `## Result` — exactly what a successful call returns.
7. `## Error handling` — whether failures throw or are returned as values, and
   how the caller should recover.
8. `## Critical operating constraints` — invariants that must always be
   honored (hash/overwrite rules, path requirements, secret handling,
   sequencing, non-zero exit codes, etc.).
9. `## Safe use` — explicit guardrails with **Allowed**, **Denied**,
   **Dangerous examples (do not run)**, and **Required permissions**.
10. `## Examples` — one to three minimal, correct examples.

## Writing rules

- Describe only the contract the tool actually implements; do not invent
  parameters, flags, or guarantees.
- Keep the file short enough to be read before the first call to the tool.
- Never include credentials, secrets, or instructions to read `data.json`.
- Use the exact parameter names and types from the tool schema.
- Mark parameters that must be supplied together and mutually exclusive
  options explicitly.

## Skeleton

```markdown
# <ToolName> tool usage

## Purpose

<one or two sentences>

## When to use

<when to choose this tool and any planning/answering constraints>

## Required parameters

- `<param>` (`<type>`): <meaning>

## Optional parameters

- `<param>` (`<type>`): <meaning>  <!-- omit this section when none -->

## Result

<what a successful call returns>

## Error handling

<throw vs return behavior and recovery steps>

## Critical operating constraints

<invariants the caller must always honor>

## Safe use

**Allowed**

<safe operations>

**Denied**

<unsafe operations>

**Dangerous examples (do not run)**

<examples of blocked calls>

**Required permissions**

<permissions or preconditions required>

## Examples

1. <description>

   ```js
   await <ToolName>({ <param>: "<value>" });
   ```
```
