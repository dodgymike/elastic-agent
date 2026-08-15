# SpecKeeperEnroll tool usage

## Purpose

Redeem a one-time Spec Keeper agent-enrollment token and return its one-time
enrollment recipe (credentials). The recipe contains secrets that are shown
only once by Spec Keeper.

## When to use

Use `SpecKeeperEnroll` only to redeem a one-time enrollment token and obtain
the agent credential recipe. Store the returned recipe only in the approved
secret store (for example `/tmp/spec-keeper.json` with mode `0600`).

## Required parameters

- `token` (string): token from the `#token=` fragment of a Spec Keeper
  enrollment URL.

## Result

An enrollment recipe containing:

- `username`, `password`
- `api_base`, `project_slug`, `role`
- `region?`, `client_id?`
- `recipe` (object with the full credential set)

## Formatted terminal output

The runtime first announces the call as `SpecKeeperEnroll(...)`. While the
request runs, an in-place timer line ticks on the same terminal line (for
example `⏱ 0.50s` in color mode, or `elapsed 0.50s` in non-TTY logs) and is
finalized with the total elapsed time when the call completes or fails.
Terminal state is cleaned up on exit.

On completion the terminal renders the call label followed by a green circle
on success or a red circle with the error message on failure. In
no-color/non-TTY contexts the circle degrades to plain text while the status
is still shown. No `[SUCCESS]` or `[ERROR]` text prefix is ever emitted for a
tool call. The enrollment token and returned recipe remain secrets and must
never be written to the repository, notes, or handoffs.

## Error handling

- Missing or non-string `token`: `TypeError` (from `token.trim()`); the schema
  requires `token`, so always pass it as a non-empty string.
- Empty or whitespace-only token: `Error`
  (`A non-empty Spec Keeper enrollment token is required.`).
- Non-OK redeem response: throws
  `Spec Keeper enrollment failed (<status>): <body>`.
- Network/fetch failures propagate.

## Critical operating constraints

- The token is non-empty and is single-use.
- The returned recipe contains secrets: store it only in the approved secret
  store with restrictive permissions.
- Never write the enrollment recipe to the repository, commit messages, task
  notes, or handoffs.

## Safe use

**Allowed**
- Redeem a single-use enrollment token and store the returned recipe only in
  the approved secret store with restrictive permissions (for example mode
  `0600`).

**Denied**
- Writing the recipe to the repository, docs, task notes, commit messages, or
  handoffs.
- Logging the recipe or the token.
- Reusing a one-time token.

**Dangerous examples (do not run)**
- Writing the returned recipe to `CLAUDE.md`, `SPEC_KEEPER.md`, or any repo
  file.
- Passing the token or recipe in an `ExecuteCommand` command that logs it.

**Required permissions**
- A non-empty, single-use enrollment token.

## Examples

1. Redeem a token and store the recipe safely:

   ```js
   const recipe = await SpecKeeperEnroll({ token: "<enrollment token>" });
   // Persist recipe to the approved secret store with restrictive permissions;
   // do NOT write it to the repository.
   ```
