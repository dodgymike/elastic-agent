# One-task-at-a-time verification protocol (plan steps 3-18)

This document defines the operating protocol for the MI-01..MI-16 verification
pass. It converts each numbered `memory-improvements` task into a single,
independently auditable verification-and-repair unit.

## Scope and intent

- **Verify, do not reimplement.** Every MI-01..MI-16 task is expected to be
  `DONE`; the pass confirms that claim against the repo and the recorded
  validation, and repairs only observed breakage.
- **Repair only when needed.** A task is repaired only when a recorded check
  fails or required code is missing.
- **Synthetic fixtures only.** Never read `data.json`, conversation logs,
  credentials, or live memory payloads. Use synthetic fixtures and temporary
  owner-only state.
- **Preserve unrelated work.** Pre-existing working-tree changes are left
  untouched; stage and commit only intended files.

## Toolchain gate

All `npm` commands run under a supported Node binary (>=22.9.0 per
`package.json` `engines.node` and `.nvmrc`). If no supported Node is reachable,
stop and report the blocker rather than running validation.

## Per-task procedure

For each task MI-0X (X in 01..16), in order, exactly one task at a time:

1. **(a) Read** `memory-improvements/0X-*.md` in full, including its Status
   line and Completion record.
2. **(b) Verify prerequisites.** Confirm each prerequisite task has Status
   `DONE` and a truthful completion record, and confirm every named
   implementation/completion commit for this task appears in `git log`.
3. **(c) Run validation.** Run exactly the validation commands recorded for
   the task (plus any related suites its completion record lists) with the
   supported Node binary.
4. **(d) Pass → no change.** If every check passes, record
   `verified, no change needed` and do not reimplement or rewrite the task.
5. **(e) Fail → repair.** If a check fails or code is missing:
   1. Reproduce the failure with a focused failing test.
   2. Implement the smallest scoped fix.
   3. Rerun the task's suites plus `npm run build` and `git diff --check`.
   4. Commit only the intended files with a message like
      `MI-0X: fix <short summary>`.
6. **(f) Record results.** Update the task's completion record with actual
   results and any skipped checks so it stays truthful.

## Outcome recording

- **Passing task:** no code change. Annotate the completion record with
  `verified, no change needed` and the supported Node binary actually used.
- **Repaired task:** record code/commit references, validation results, and any
  rollback notes.
- **Skipped check:** record it explicitly with the reason; never silently drop
  a check.

## Boundaries

- Process tasks strictly one at a time; do not start the next task until the
  current one is verified or repaired and committed.
- If a failure belongs to a different MI-0X, record it and route it to the
  owning task rather than silently broadening the current change.
- Step 19 re-runs the aggregate `npm run test:memory-improvements`,
  `npm run build`, and `git diff --check`, then reviews `git status` and
  commits only intended files.
