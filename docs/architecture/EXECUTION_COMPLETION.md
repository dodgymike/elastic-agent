# Execution completion tracking

Formal plan execution uses the normalized outcome from `src/planning/step-outcome.ts` for
memory, step-task status, progress messages, and its final completion gate.
Only `succeeded` authorizes run-level completion. Failed, blocked, invalid,
needs-verification, pending, or missing outcomes prevent the execution phase
from returning successfully into review/commit or run-task completion.

`src/planning/execution-completion.ts` checks every current step, not merely the number of
entries in the completion ledger. A successful later step does not implicitly
resolve an earlier failure. Phase restarts reset the gate's current-step map so
success from an old phase cannot satisfy a new step at the same index. Persisted
attempts and tool results remain available for diagnosis under the existing
execution bookkeeping.

Progress output reports the normalized result after reduction. Returning control
from a model no longer emits an unconditional “Step completed” success message.
Unresolved execution throws the existing `unable-to-complete` abort category;
normal abort cleanup and task failure handling apply. Already executed side
effects are not rolled back by this gate.

## Scope and evidence limits

This change enforces agreement with the existing outcome reducer; it does not
independently prove the model's claims. The current reducer accepts a nonempty
model summary or findings as completion evidence. Runtime-owned verification
receipts tied to explicit acceptance criteria are still needed for stronger
proof. The direct/no-plan path retains its existing completion behavior.

## Validation

`tests/planning/execution-completion.test.ts` checks all normalized outcomes, missing
steps, a failure followed by a success, phase reset, and agreement with memory
and external task status mappings. Compile it with the repository TypeScript
compiler and run the emitted JavaScript. Related regression suites are
`test:step-outcome`, `test:plan-handler`, and `test:spec-keeper-task-lifecycle`.
