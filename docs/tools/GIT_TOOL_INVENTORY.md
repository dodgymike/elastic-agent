# Git Tool Inventory (2026-08-15)

Step 1 of 6: inventory and deduplicate git commands observed in today's runs,
then map them to the four planned `Git` tool modes: `status`, `log`, `diff`,
and `ls-files`.

This file contains no secrets. Source logs containing credentials or API keys
were only inspected for git command substrings and were never staged or
committed.

## Sources reviewed

| Source | Size | Notes |
| --- | --- | --- |
| `.history-2026-08-15-001.log` | 26,255 bytes at first read | Shell history for today's runs; actively appended. |
| `.history_tmp_mike` | 15,626 bytes | Earlier shell history snapshot (main2.js era). |
| `.history_tmp_mike_2` | 3,885 bytes | Earlier snapshot; duplicates first 79 lines of today's history. |
| `llm.log` | 639,687,887 bytes | LLM prompt/response log, `2026-08-12T19:07:16Z` through `2026-08-15T16:10:49Z`. Too large for `Read`; queried with `grep` only. |

From `llm.log` the extraction matched `ExecuteCommand` tool-call arguments
whose command string starts with `git` (188 unique commands) or with
`cd /elastic-agent && git` (38 unique commands). The shell history was also
grep'd for `git ` to catch manually typed commands.

## Deduplicated variants by mode

Counts below are occurrence counts across the scanned logs and are indicative,
not authoritative history metrics.

### Mode: `status`

Observed variants deduplicated:

- `git status`
- `git status --short`
- `git status --short --branch`
- `git status --porcelain=v1`
- `git status --porcelain=v1 --branch`
- `git status --porcelain=v1 -uno`
- `git status --short <path>` (path-scoped)
- `git -C <dir> status` and `git -C <dir> status --short`
- `git status --short && git log --oneline -N` (combined; decomposes into
  `status` + `log`)

Canonical form for the Git tool:

```text
Git status mode
  - format: short | porcelain | branch
    * short     -> git status --short
    * porcelain -> git status --porcelain=v1
    * branch    -> add --branch (combinable with short or porcelain)
  - paths: optional repo-relative path filters
```

### Mode: `log`

Observed variants deduplicated:

- `git log`
- `git log --oneline`
- `git log --oneline -N` where N observed in {1,2,3,5,6,8,10,12,15,20}
- `git log --oneline -N --stat`
- `git log --oneline --all [-- <path>...]`
- `git log --oneline --no-decorate <rev>..HEAD`
- `git log --oneline <rev>`
- `git log --oneline [--] <path>...`
- `git log --oneline -N -- <path>...`
- `git log -p [-N] -- <path>...`
- `git log --all -p -S <pickaxe> -- <path>`
- `git log --all --oneline -S <pickaxe> -- .`
- `git log -1 --oneline [HEAD]`
- `git -C <dir> log --oneline -N`

Canonical form for the Git tool:

```text
Git log mode
  - oneline: boolean (default true)
  - stat: boolean
  - max-count: number (map -N)
  - path: optional repo-relative path filters
  - revision: optional revision/range (default HEAD when needed)
  - all: boolean
```

### Mode: `diff`

Observed variants deduplicated:

- `git diff` (unstaged worktree diff)
- `git diff --stat`
- `git diff --stat HEAD`
- `git diff --check`
- `git diff --check HEAD~1..HEAD`
- `git diff --cached` / `git diff --cached --stat` / `git diff --cached -- <path>`
  (staged diff)
- `git diff [--] <path>...` (unstaged, path filters)
- `git diff HEAD [--] <path>...` (worktree vs HEAD, path filters)
- `git diff <rev>` / `git diff <rev>..<rev>` (revision-range diff)
- `git -C <dir> diff [--stat] [path]`
- `git --no-pager diff <path>` (pager flag is a presentation concern)
- `git diff --check && git diff --stat` (combined; decomposes into two flags)

Canonical form for the Git tool:

```text
Git diff mode
  - staged: boolean (map --cached)
  - stat: boolean
  - check: boolean (whitespace check)
  - revision: optional revision/range (default HEAD when supplied, otherwise
    unstaged worktree)
  - paths: optional repo-relative path filters
```

### Mode: `ls-files`

Observed variants deduplicated:

- `git ls-files`
- `git ls-files <path>...` (explicit paths)
- `git ls-files <dir>` and `git ls-files <dir>/`
- `git ls-files --others --exclude-standard` (untracked, honoring ignore rules)
- `git ls-files ... | sort` and `git ls-files ... | grep ...` (post-processing
  is presentation, not a git flag)

Canonical form for the Git tool:

```text
Git ls-files mode
  - others: boolean (map --others)
  - exclude-standard: boolean (map --exclude-standard; implied by others)
  - paths: optional repo-relative path filters
```

## Mapping summary

| Observed command family | Git tool mode | Parameters |
| --- | --- | --- |
| `git status [--short\|--porcelain=v1] [--branch] [-uno] [path]` | `status` | `format`, `branch`, `paths` |
| `git log [--oneline] [-N] [--stat] [--all] [rev] [-- path]` | `log` | `oneline`, `maxCount`, `stat`, `all`, `revision`, `paths` |
| `git diff [--cached] [--stat] [--check] [rev] [-- path]` | `diff` | `staged`, `stat`, `check`, `revision`, `paths` |
| `git ls-files [--others --exclude-standard] [path]` | `ls-files` | `others`, `excludeStandard`, `paths` |

## Out of scope for the four modes

These git subcommands were also observed but do not belong to the four
read-only inspection modes. Routing decisions are left to later steps
(ExecuteCommand refusal + classifier):

- `git add ...` and `git commit -m ...` -> existing `Git` actions `stage` and
  `commit`.
- `git branch [-a|-A|-D]`, `git checkout`, `git push`, `git tag`, `git stash
  [list]`, `git worktree list`, `git config --global ...`, `git show ...`,
  `git check-ignore`, `git rev-parse`, `git --version`.
  These are mutating or specialized; if a future step wants them supported,
  add explicit modes/actions rather than mapping them silently.

## Safety note

The history files listed above contain credentials and API keys and must never
be staged, committed, or copied into docs. This inventory intentionally records
only git subcommand shapes and counts.
