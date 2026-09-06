# Artifact tracking policy

> Scope: backlog item **SECLOG-03 — Clean up artifact tracking policy [P1, S]**.
> This document records a **metadata-only** inventory of generated artifacts
> (file names, tracked/untracked status, and ignore rules). No artifact
> **contents** were read or inspected while producing this inventory.

## Goal

A normal agent run must not leave memory, log, or state artifacts that can be
accidentally staged. Required fixtures must stay available, and the documented
ignore behavior must match `.gitignore`.

## Method

- Tracked files were enumerated with `git ls-files` (file names only).
- Untracked artifacts were enumerated from `git status` (file names only).
- `database.sqlite`, `llm2.log`, and `data.json` were **not** read.
- No git history was rewritten and no credentials were rotated.

## Inventory

| Path | Kind | Status | Disposition |
| --- | --- | --- | --- |
| `data.json` | runtime state / protected path | tracked (also listed in `.gitignore`) | **Protected.** Do not read, stage, diff, or operate on it. The ignore rule already exists, but ignore rules do not apply to tracked files. Untracking it requires explicit operator authorization and is out of scope here. |
| `database.sqlite` | runtime SQLite database | tracked | Runtime output. Ignore rule added. Untrack with `git rm --cached database.sqlite` (requires a shell-capable supported host; see below). |
| `llm2.log` | runtime LLM log | tracked | Runtime output. Ignore rule added. Untrack with `git rm --cached llm2.log`. |
| `llm.log` | runtime LLM prompt/response log | untracked | Already ignored (`llm.log`). |
| `prompt.log` | runtime prompt-only log (`--log-prompts`) | untracked | Already ignored (`prompt.log`). |
| `memory-output/` | generated persistent-memory documents | untracked | Ignore rule added (`memory-output/`); README already described this directory as gitignored. |
| `database.sqlite-*` | SQLite WAL/SHM/journal sidecars | untracked | Ignore rule added (`database.sqlite-*`). |
| `bus-queue.json`, `bus-queue.json.tmp`, `bus-cursor.json`, `bus-cursor.json.tmp` | loop-mode Agent Bus runtime state | untracked | Already ignored. |
| `dist/`, `node_modules/`, `test/.*-build/` | build output | untracked | Already ignored. |
| `agent-busctl` | local agent-busctl client build | tracked (also listed in `.gitignore`) | Classification finding: the ignore comment says it is a local build that should stay out of the repository, yet the binary is tracked. Untracking needs an operator decision because the AgentBus tool defaults to this binary path. Out of SECLOG-03's evidence scope; recorded for follow-up. |
| `docs/examples/elastic-agent-memory-aaaa-1112-0001.json` | sanitized example memory document | tracked fixture | Keep. Documented in README as an artificial, non-secret fixture. |
| `test/fixtures/memory-aaaa-1112-0001.json` | sanitized memory fixture | tracked fixture | Keep. Exercised by `test/memory-compaction.test.ts`. |
| `test/fixtures/build-prompt-skeleton.golden.txt` | golden output fixture | tracked fixture | Keep. |
| `tmp/*.md`, `tmp/*.jsonl`, `tmp/*.json` | working notes and one-off analysis records | tracked | Out of SECLOG-03 scope (not runtime memory/log/state). Review separately if they are found to represent runtime state. |

## Precise ignore rules added

```gitignore
# Generated persistent-memory documents; keep out of the repository.
memory-output/

# Generated runtime SQLite database and sidecars; keep out of the repository.
database.sqlite
database.sqlite-*
```

`llm2.log` was added to the existing runtime LLM log rules next to `llm.log`.

## Cleanup required on a supported host

The following index-only removals keep the local files but stop tracking them.
They require a working shell (`git rm`) and therefore a supported host with
usable bubblewrap/namespace support; the runtime Git tool has no `rm` action and
the shell sandbox is unavailable on the current dev host.

```sh
git rm --cached database.sqlite
git rm --cached llm2.log
git commit -m "Stop tracking generated runtime artifacts"
```

Do **not** run `git rm --cached data.json` or otherwise operate on `data.json`;
it is a protected path and requires separate operator authorization.

## Verification

On a supported host, run:

```sh
npm run test:artifact-policy
git status
```

Acceptance:

- `npm run test:artifact-policy` passes (ignore rules present, fixtures present,
  and this policy is documented).
- After a normal run, `git status` shows no memory/log/state artifacts eligible
  for accidental staging (the tracked `database.sqlite` and `llm2.log` stop
  reappearing as modified once the cleanup above is committed).
- Required fixtures remain available under `docs/examples/` and `test/fixtures/`.

## Guardrails

- No history rewrite.
- No credential rotation.
- `data.json` and other secret/protected paths remain untouched.
