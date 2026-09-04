# Git Tool Worktree Command Surface (Specification)

Step 2 of 7 for adding `git worktree` support to the dedicated `Git` tool.
This document is the single source of truth for the worktree surface that the
implementation step (step 3) builds, the error-handling step (step 4)
contractualizes, and the documentation/tests (steps 5 and 6) must agree with.

This file contains no secrets and no `data.json` content.

## 1. Scope

The `Git` tool gains one new mode, `mode: "worktree"`, which dispatches to
exactly five whitelisted subcommands:

| Subcommand | Effect class | Git command |
| --- | --- | --- |
| `list` | read-only | `git worktree list` |
| `add` | mutating | `git worktree add` |
| `remove` | mutating | `git worktree remove` |
| `move` | mutating | `git worktree move` |
| `prune` | mutating | `git worktree prune` |

Everything else under `git worktree` (for example `lock`, `unlock`, `repair`)
is rejected, as is every option/flag not explicitly whitelisted below.

## 2. Selector shape

Worktree commands use the existing top-level `mode` selector plus a new
required `subcommand` selector. This keeps the existing read-only `mode` vs
mutating `action` split intact and avoids overloading the legacy top-level
`action` enum (whose `list` value already means "status alias").

```ts
export interface GitWorktreeModeOptions extends GitBaseOptions {
  mode: "worktree";
  /** Worktree subcommand to run. Required when mode is "worktree". */
  subcommand: "list" | "add" | "remove" | "move" | "prune";
  // list
  porcelain?: boolean;
  // add
  path?: string;      // required for add and remove
  newBranch?: string; // add: -b <newBranch>
  detach?: boolean;   // add: --detach
  commitish?: string; // add: optional <commit-ish> positional
  // remove
  force?: boolean;    // remove: --force
  // move
  oldPath?: string;   // move: source worktree path (required)
  newPath?: string;   // move: destination path (required)
  // prune: no parameters
}
```

Rules:

- `subcommand` is required exactly when `mode === "worktree"`. A worktree call
  without `subcommand`, or a `subcommand` on any other mode/action, is rejected
  synchronously with a `TypeError`.
- When both `mode` and `action` are present, the existing dispatcher already
  gives `mode` precedence (`isModeOptions` checks `"mode" in options`). That
  behavior is unchanged; worktree inherits it.
- For `mode: "worktree"`, only the parameter keys listed for the selected
  subcommand (plus `mode`, `subcommand`, and `cwd`) are allowed. Any other own
  enumerable key — including keys valid on other modes such as `format`,
  `branch`, `paths`, `all`, `message`, `oneline`, `stat`, `staged`, `check`,
  `others`, `excludeStandard`, `revision` — is rejected with a `TypeError`
  before any git process runs. This is stricter than the read-only modes on
  purpose: the worktree surface is an explicit allow-list and unknown flags
  must never pass through to git.

## 3. Exact per-subcommand allow-list

Boolean parameters are opt-in only: `false` is equivalent to omitted and adds
no flag.

### 3.1 `subcommand: "list"` (read-only)

Allowed parameters: `porcelain` (`boolean`, optional).

| Call | Generated `command` array |
| --- | --- |
| `{ mode: "worktree", subcommand: "list" }` | `["worktree", "list"]` |
| `{ mode: "worktree", subcommand: "list", porcelain: true }` | `["worktree", "list", "--porcelain"]` |

Rejected for `list`: any path argument, `--verbose`, `--lock-reason`,
`--expire`, `-z`, and every other flag not listed.

### 3.2 `subcommand: "add"` (mutating)

Allowed parameters:

- `path` (`string`, required) — the new worktree directory path.
- `newBranch` (`string`, optional) — maps to `-b <newBranch>`.
- `detach` (`boolean`, optional) — maps to `--detach`.
- `commitish` (`string`, optional) — the optional positional `<commit-ish>`
  to check out (defaults to `HEAD` when omitted).

Canonical argument order (options first, then positionals, matching
`git worktree add [<options>] <path> [<commit-ish>]`):

```text
["worktree", "add", ...(detach ? ["--detach"] : []),
 ...(newBranch !== undefined ? ["-b", newBranch] : []),
 path, ...(commitish !== undefined ? [commitish] : [])]
```

Examples:

| Call | Generated `command` array |
| --- | --- |
| `{ mode: "worktree", subcommand: "add", path: ".worktrees/topic" }` | `["worktree", "add", ".worktrees/topic"]` |
| `{ mode: "worktree", subcommand: "add", path: ".worktrees/topic", newBranch: "topic", detach: false }` | `["worktree", "add", "-b", "topic", ".worktrees/topic"]` |
| `{ mode: "worktree", subcommand: "add", path: ".worktrees/topic", detach: true, commitish: "HEAD~1" }` | `["worktree", "add", "--detach", ".worktrees/topic", "HEAD~1"]` |

Rejected for `add`: `--force`/`-f`, `--checkout`, `--no-checkout`, `--lock`,
`--orphan`, `--guess-remote`, `--track`, `--quiet`, and every other flag not
listed.

### 3.3 `subcommand: "remove"` (mutating)

Allowed parameters:

- `path` (`string`, required) — the worktree path to remove.
- `force` (`boolean`, optional) — maps to `--force`.

Canonical argument order:

```text
["worktree", "remove", ...(force ? ["--force"] : []), path]
```

Rejected for `remove`: `--expire`, multiple paths, and every other flag.

### 3.4 `subcommand: "move"` (mutating)

Allowed parameters:

- `oldPath` (`string`, required) — the worktree path to move.
- `newPath` (`string`, required) — the destination path.

Canonical argument order:

```text
["worktree", "move", oldPath, newPath]
```

Rejected for `move`: every flag (there is no whitelisted `--force` for move;
plain positional move only).

### 3.5 `subcommand: "prune"` (mutating)

Allowed parameters: none.

Canonical command: `["worktree", "prune"]`.

Rejected for `prune`: `--expire`, `--dry-run`/`-n`, and every other flag.
The safe plain form is the only accepted form.

## 4. Synchronous validation contract (before any git process runs)

Validation happens at the tool boundary and rejects with `TypeError`, per
`ERROR_HANDLING.md`. All of the following are checked before `spawn`:

1. `options` is a non-null object (existing `validateOptionsObject`).
2. `cwd`, when provided, is a non-empty string (existing `validateCwd`).
3. `subcommand` is one of `list`, `add`, `remove`, `move`, `prune` (explicit
   enum allow-list). Unknown worktree subcommands are rejected.
4. Only the per-subcommand parameter keys from section 3 are present
   (strict key allow-list; unknown keys are rejected).
5. Required fields per subcommand are present: `path` for `add`/`remove`;
   `oldPath` and `newPath` for `move`.
6. Every path argument (`add.path`, `remove.path`, `move.oldPath`,
   `move.newPath`) passes `validateWorktreePath`:

   - non-empty string; no NUL bytes;
   - no `..` segment after normalizing both `/` and `\` separators;
   - does not start with `-` (prevents option injection through a positional);
   - is not a protected path: never `data.json` (case-insensitive basename),
     and never a protected basename/stem — `.env*`, `id_rsa`, `id_ed25519`,
     `id_ecdsa`, `id_dsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.netrc`,
     `.npmrc`, `.pypirc`, `.git-credentials`, `.htpasswd`, and basenames whose
     stem ends in `token`/`tokens`/`api-key`/`apikey`/`password`/`passwd`/
     `secret`/`secrets`/`credential`/`credentials` (reuse the
     `dataJsonTargetReason` and `protectedPathReason` semantics from
     `tool-safety-classifier.ts`);
   - resolves canonically to a path under the workspace root.

7. Canonical path containment (the worktree path policy):

   - The workspace root is `cwd` when provided, otherwise `process.cwd()`.
   - Resolve each path against that root, then symlink-resolve with
     `fs.realpathSync`; when realpath fails (path does not exist yet, which is
     normal for `add.path` and `move.newPath`), fall back to the normalized
     resolved path. This mirrors `canonicalAbsolutePath` in
     `tool-safety-classifier.ts` and stays fail-closed: a fallback path can
     only be more restrictive, never less.
   - The canonical path must be inside the workspace root
     (`relative(root, candidate)` must not be `..`, start with `..<sep>`, or be
     absolute).
   - `add.path` is additionally restricted to the managed worktree root
     `<workspaceRoot>/.worktrees` (the `WORKTREES_DIR` established by
     `worktree.ts`), so the tool never creates a worktree outside the managed
     root.

8. `newBranch` (when present for `add`) must be a valid, safe branch name:
   non-empty; no NUL, whitespace, or other control characters; must not start
   with `-`; must not contain `..`, `@{`, `\`, `~`, `^`, `:`, `?`, `*`, or
   `[`; must not start or end with `/`. (Git itself also validates and returns
   a nonzero exit for invalid names; this check prevents option injection and
   rejects clearly dangerous names before spawn.)

9. `commitish` (when present for `add`) must be a non-empty string with no NUL
   and must not start with `-`.

## 5. Result and error behavior

- Successful validation still returns the normal `GitCommandResult`
  (`{ command, exitCode, stdout, stderr }`) from `runGit`.
- A git nonzero exit (for example `worktree add` on an existing path, or a
  branch that already exists) is **returned** as a result, not thrown,
  matching the existing tool contract.
- Spawn failure or signal termination rejects the promise.
- Validation failures are synchronous `TypeError`s at the boundary.
- The pre-existing gap where `runGit` has no timeout must be closed as part of
  this work (ERROR_HANDLING.md §6 requires a default 60-second process
  timeout). This is a shared gap, not worktree-specific, and should be fixed
  in step 3/4.

## 6. Schema changes to `GitParameters` (tools/Git.tsx)

```ts
mode: { type: "string", enum: ["status", "log", "diff", "ls-files", "worktree"] },
subcommand: { type: "string", enum: ["list", "add", "remove", "move", "prune"] },
porcelain: { type: "boolean" },
newBranch: { type: "string" },
detach: { type: "boolean" },
commitish: { type: "string" },
force: { type: "boolean" },
oldPath: { type: "string" },
newPath: { type: "string" },
```

`path` stays `{ type: "string" }` (reused for `add`/`remove`). The `anyOf`
constraint stays exactly `[{ required: ["mode"] }, { required: ["action"] }]`
(the handler enforces `subcommand`-required-when-worktree itself).

`test/tool-schema-consistency.test.ts` pins the mode enum and action enum and
must be updated in step 6: the mode enum becomes
`["diff", "log", "ls-files", "status", "worktree"]`; the action enum stays
`["commit", "list", "stage"]`; the `anyOf` length stays 2.

## 7. Safety classifier and router coordination

The static classifier (`classifyGit` in `tool-safety-classifier.ts`) currently
rejects any selector it does not recognize, so it must be extended at the same
time the dispatcher is (step 3/4) or every worktree call will be blocked
before the handler runs:

- `mode === "worktree"` + `subcommand === "list"` -> `safe`
  ("Git worktree list is a read-only operation.").
- `mode === "worktree"` + `subcommand` in `add`/`remove`/`move` -> statically
  validate the path arguments exactly as the tool will (data.json/protected/
  traversal/out-of-root/`.worktrees` for add) and return `safe` only when all
  checks pass, mirroring how `stage` paths are classified; otherwise `unsafe`
  with the same actionable reason.
- `mode === "worktree"` + `subcommand === "prune"` -> `safe`
  ("Git worktree prune removes only stale worktree metadata and takes no path
  arguments.").
- `mode === "worktree"` with a missing/unknown `subcommand` -> `unsafe`
  ("the tool itself will reject the call").

The ExecuteCommand git router (`GIT_TOOL_LIST_TEXT` in
`git-command-router.ts` and `prompts/git-command-router.md`) must list the
worktree mode so the LLM classifier can redirect `git worktree ...` through
`Git({ mode: "worktree", ... })` instead of allowing it through the shell
(step 5).

## 8. Test surface (for step 6)

`test/git-tool.test.ts` (real temp repository) must add:

- accepted argument vectors for each of the five subcommands, including
  `--porcelain`, `--detach`, `-b <branch>`, `--force`, and the two-positional
  `move` form;
- `list` is accepted as read-only;
- rejection (`TypeError`) of unknown worktree subcommands;
- rejection of every unlisted flag/parameter per subcommand (for example
  `--force` on `add`, `paths` on `list`, `format` on `worktree`,
  `--expire`/`--dry-run` on `prune`);
- rejection of `..` traversal, absolute out-of-root paths, symlink escapes,
  and protected/secret paths (`data.json`, `.env`, `id_rsa`,
  `foo_token.txt`) for the mutating subcommands;
- `add.path` outside `.worktrees` is rejected even when inside the workspace;
- invalid `newBranch` values are rejected;
- a real `git worktree add` + `list --porcelain` + `remove` integration
  sequence inside the temp repository, with nonzero-exit behavior asserted
  rather than thrown.

`test/tool-schema-consistency.test.ts` must update the pinned Git mode enum as
described in section 6.
