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

## Examples

1. Redeem a token and store the recipe safely:

   ```js
   const recipe = await SpecKeeperEnroll({ token: "<enrollment token>" });
   // Persist recipe to the approved secret store with restrictive permissions;
   // do NOT write it to the repository.
   ```
