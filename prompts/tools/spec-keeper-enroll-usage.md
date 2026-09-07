# SpecKeeperEnroll tool usage

## Purpose

Redeem a one-time Spec Keeper agent-enrollment token and persist the returned
credential recipe into the workspace credential layout:

- `.spec-keeper/<project-slug>.json` — the credential file (owner-only, mode
  `0600`; never committed), written under the workspace start directory.
- `.spec-keeper/config` — the non-secret workspace mapping keyed by the
  canonical start directory. This registry is shared and lives under the
  directory containing the agent's `src/main.ts` (or an explicit
  `configDirectory`), so the SpecKeeper lookup reads the same file this
  enrolment writes.

The single-use enrollment token is consumed by the redeem call and is never
written to disk or logged.

## When to use

Use `SpecKeeperEnroll` only to redeem a one-time enrollment token and store the
returned agent credentials in the workspace credential store. The credential
file must never be committed (the `.gitignore` rule for `.spec-keeper/*.json`
is added by the configuration migration step).

## Required parameters

- `token` (string): token from the `#token=` fragment of a Spec Keeper
  enrollment URL.

## Optional parameters

- `projectSlug` (string): project slug recorded in `.spec-keeper/config` and
  used to name the credential file. Defaults to the enrollment recipe's
  `project_slug`. Must be a URL-safe slug.
- `startDirectory` (string): workspace start directory that keys the
  `.spec-keeper/config` entry and owns the written credential file. Defaults to
  the process working directory.

## Result

The enrollment recipe plus the persisted workspace metadata:

- `username`, `password`
- `api_base`, `project_slug`, `role`
- `region?`, `client_id?`
- `recipe` (object with the full credential set)
- `workspace.startDirectory` — the canonical absolute start-directory key
  recorded in `.spec-keeper/config`
- `workspace.projectSlug` — the slug used for the mapping
- `workspace.credentialFile` — absolute path of the written credential file
- `workspace.configPath` — absolute path of the updated `.spec-keeper/config`

## Behavior

1. The token is redeemed against the Spec Keeper enrollment endpoint.
2. The canonical start directory is derived from `startDirectory` (or
   `process.cwd()`) with absolute-path resolution plus symlink resolution.
3. The endpoint details and credential set are written to
   `.spec-keeper/<project-slug>.json` under the workspace start directory with
   owner-only permissions where supported.
4. The shared `.spec-keeper/config` registry (under the src/main.ts directory by
   default, or an explicit `configDirectory`) is created or updated with an
   entry keyed by the canonical start directory:
   `{ projectSlug, credentialFile, apiBase? }`. Existing entries are
   preserved.

The credential file contains only the returned recipe (for example `username`,
`password`, `api_base`, `project_slug`, `region`, `client_id`, and the full
`recipe` object). The `.spec-keeper/config` file contains no credentials — only
the routing metadata the `SpecKeeper` tool needs to find them.

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
  `Spec Keeper enrollment failed (<status>): <redacted body>`.
- Invalid/missing `projectSlug`: `Error` explaining the URL-safe requirement
  or that `project_slug` is missing from the recipe.
- A legacy `.spec-keeper` **file** already present where the new `.spec-keeper`
  directory is needed: `Error` telling the caller to migrate it first. The
  file is never overwritten or deleted.
- Malformed or non-object `.spec-keeper/config`: `Error`; the file is refused
  rather than overwritten.
- Network/fetch failures propagate.

## Critical operating constraints

- The token is non-empty and is single-use.
- The returned recipe contains secrets: it is written only to
  `.spec-keeper/<project-slug>.json` with owner-only permissions.
- Never write the enrollment recipe to the repository, commit messages, task
  notes, or handoffs.
- Never print or log the token or the returned secret values.

## Safe use

**Allowed**
- Redeem a single-use enrollment token and persist the returned recipe in
  `.spec-keeper/<project-slug>.json` (mode `0600`) plus the non-secret
  `.spec-keeper/config` entry.

**Denied**
- Writing the recipe to the repository, docs, task notes, commit messages, or
  handoffs.
- Logging the recipe or the token.
- Reusing a one-time token.
- Overwriting a malformed `.spec-keeper/config` or a legacy `.spec-keeper`
  file.

**Dangerous examples (do not run)**
- Writing the returned recipe to `CLAUDE.md`, `docs/integrations/SPEC_KEEPER.md`, or any repo
  file.
- Passing the token or recipe in an `ExecuteCommand` command that logs it.
- Calling `SpecKeeperEnroll` with a `startDirectory` outside the workspace.

**Required permissions**
- A non-empty, single-use enrollment token.

## Examples

1. Redeem a token and persist the credentials for the current workspace:

   ```js
   const result = await SpecKeeperEnroll({
     token: "<enrollment token>",
     projectSlug: "elastic-agent",
     startDirectory: "/mnt/sdb4/mike/mike/source/elastic-agent",
   });
   // result.workspace.credentialFile is the written credential store; never
   // print result.password or result.recipe.
   ```

2. Redeem a token and let the slug default to the recipe's `project_slug`:

   ```js
   const result = await SpecKeeperEnroll({ token: "<enrollment token>" });
   // Writes .spec-keeper/<project_slug>.json under the process working
   // directory and upserts the shared .spec-keeper/config registry (under the
   // src/main.ts directory) with the canonical process.cwd() key.
   ```
