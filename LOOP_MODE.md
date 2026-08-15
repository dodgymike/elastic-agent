# Loop mode (`--loop`)

Loop mode lets the runtime keep running after it starts a plan and watch the
Agent Bus between execution steps **and while idle between plans**. Incoming
coordination messages are classified at each step boundary and either interrupt
the work order (a *relevant* message triggers a re-plan) or are persisted to a
durable queue for later (an *irrelevant* message never disturbs the plan in
flight). After a plan finishes, the agent does not exit: it keeps polling the
bus waiting for new work, so it stays "listening" — exactly the behavior of a
long-lived coordination agent.

## Poll mode only

Loop mode consumes the Agent Bus **exclusively by polling**. Every live read is
a bounded HTTP `GET` of the messages feed through `loop-poll.ts`:

- `pollLoopBusOnce` — one bounded between-step read.
- `pollLoopBusUntilMessage` — the keep-listening loop that polls at
  `LOOP_POLL_INTERVAL_MS` while idle between plans.

Loop mode never subscribes, streams, long-polls, or opens a persistent
connection to the bus. The only non-poll retrieval is the durable-queue drain
on restart (below), which re-reads messages a *previous* run polled and
persisted to `bus-queue.json` — it is not a live transport. Keeping delivery
poll-only means each idle loop makes no outbound connection until the configured
poll interval elapses, so an agent running `--loop` costs nothing between polls
and always fails open when the bus is unreachable.

This document describes the CLI surface, the classification rule, the durable
queue, the between-step poll loop, and the re-planning safety guard. The
implementation is split across four small modules so each concern stays focused
and independently testable:

- `loop-mode.ts` — the classification rule (relevant vs. queued).
- `loop-queue.ts` — durable queue persistence and restart draining.
- `loop-poll.ts` — the between-step Agent Bus poll and message routing.
- `loop-replan.ts` — turning a relevant message into a new plan and deciding
  when that re-plan is safe.

`main.ts` wires these together; `cli-task-mode.ts` owns the CLI argument rules.

---

## CLI usage

Loop mode is a **mode modifier**, not a third exclusive mode. It is additive
and may be combined with either base mode:

```sh
# Prompt mode + loop
elastic-agent --loop "implement the payment retry"

# Task mode + loop
elastic-agent --loop --task-id TASK-42
```

Mode rules (see `cli-task-mode.ts`):

- Prompt mode (positional `<prompt>`) and task mode (`--task-id <id>`) are
  mutually exclusive; at least one is required.
- `--loop` never selects a mode by itself and may be combined with either one.
- `--loop` is passed through to `resolveCliRunMode` and stored on the resolved
  run-mode object as `loop`.

---

## Classification rule (loop-mode.ts)

Every bus message received at a step boundary is classified as either
`relevant` or `queued`.

A message is **RELEVANT** when it changes the work order in flight:

1. it references the current task/plan ID (the classification context), or
2. it carries a plan-change directive (a keyword/phrase in
   `PLAN_CHANGE_DIRECTIVES`) — e.g. `replan`, `re-plan`, `pivot`, `redirect`,
   `cancel the plan`, `abort plan`, `do not continue`.

Any other message is **QUEUED**: it is persisted durably and does not interrupt
execution.

Classification is intentionally conservative and deterministic so it can be
unit-tested without a network. It is the guardrail that decides whether a
message warrants re-entering the planning phase; it is not a substitute for an
LLM reading the message content.

Helpers exported for testing and reuse:

- `messageToSearchableText` — flattens a string, a shallow object, or an object
  with a nested `body` into a single searchable string.
- `normalizeForClassification` — lower-cases and collapses whitespace.
- `classifyAgentBusMessage(message, context)` — returns `{ kind, reason }`.

---

## Durable queue (loop-queue.ts)

Irrelevant messages are persisted to `bus-queue.json` in the project root
(chosen via `defaultBusQueueFilePath`), the same file being drained on a later
restart. The queue file and its `.tmp` sibling are git-ignored runtime state.

Key properties:

- **Atomic writes** — writes go to a sibling `<file>.tmp` then are renamed over
  the target, so a crash mid-write never leaves a half-written queue that loses
  messages.
- **Graceful reads** — a missing file is an empty queue; a malformed file is
  treated as an empty queue with a warning (never a crash). Individual bad rows
  are skipped and reported rather than discarding the whole queue.
- **Restart draining** — `drainBusQueue` replays all queued messages in order,
  oldest first, through a caller-supplied handler. If the handler rejects, the
  offending message and the ones after it are re-persisted so nothing is lost
  across a restart.

Exports:

- `readBusQueue(filePath)` → `{ filePath, messages, warnings }`
- `writeBusQueue(filePath, messages)` — atomic replace.
- `enqueueBusMessage(filePath, message)` → updated snapshot.
- `drainBusQueue(filePath, { handler })` → `{ drainedCount, remaining, warnings }`

---

## Between-step poll (loop-poll.ts)

At each execution-step boundary, loop mode performs a bounded poll of the Agent
Bus messages feed, classifies every message, persists the queued ones, and
surfaces the relevant ones so the step loop can decide whether to abort and
re-plan.

- `normalizeAgentBusMessages` reduces an opaque GET response body to a flat list
  of messages regardless of deployment shape (bare array, `{ messages: [...] }`,
  `{ data: [...] }`, or a single `{ message }`/`{ data }` object).
- `routeAgentBusMessages` classifies a batch and enqueues the irrelevant ones.
- `pollLoopBusOnce` orchestrates one poll through an injectable `read`
  dependency so it is fully unit-testable without a network.
- `pollLoopBusUntilMessage` *loops on the feed*, sleeping `pollIntervalMs`
  between polls and waiting until a relevant message arrives (or the wait is
  bounded/aborted). This is the "keep listening" primitive used while idle
  between plans.

Poll timing:

| Setting | Env var | Default | Notes |
| ------- | ------- | ------- | ----- |
| Poll interval | `LOOP_POLL_INTERVAL_MS` | `5000` | Minimum `100`; enforced to avoid a hot-loop. |
| Per-poll request timeout | `LOOP_POLL_REQUEST_TIMEOUT_MS` | `2000` | One hung bus read never blocks a step boundary indefinitely. |
| Idle-wait cap | `LOOP_MAX_IDLE_POLLS` | `0` | `0` waits indefinitely (until a relevant message or Ctrl-C); a positive integer bounds how many idle polls a run performs. |
| Feed path | `LOOP_BUS_MESSAGES_PATH` | `/api/v1/messages` | Route read from the Agent Bus. |

Soft-failure contract: a missing/malformed queue file or an unreachable bus is
reported as a warning and loop mode fails **open** to normal execution rather
than crashing a step boundary. During the idle wait an unreachable bus is a
soft no-op: loop mode keeps polling instead of crashing, so a temporarily
unavailable bus never kills the agent.

---

## Idle listening between plans

When a plan completes with no relevant message pending, loop mode does **not**
exit. `runAgentReplanLoop` (in `main.ts`) enters an idle-wait that keeps polling
the Agent Bus via `pollLoopBusUntilMessage`:

- Each idle poll classifies every message; irrelevant ones are queued durably
  and never dropped.
- When a *relevant* message arrives while idle, it becomes the pending replan
  directive and the agent re-enters planning with it as the new work order —
  the same replan path (budget + safety guard) used for step-boundary messages.
- The idle wait continues until a relevant message arrives, `LOOP_MAX_IDLE_POLLS`
  is exhausted (when set to a positive value), or the run is interrupted
  (Ctrl-C / SIGTERM routes through the normal abort handler).

This is what makes `--loop` a true long-lived listener: it keeps watching the
bus for new work after finishing a plan instead of stopping.

---

## Reading the queue on restart

Loop mode "reads the queue when restarting". At the top of `runAgentReplanLoop`
(in `main.ts`), before executing any work, `drainLoopQueueAtRestart` drains the
durable `bus-queue.json` left by a prior run (via `drainBusQueue`) and
re-classifies every drained message against the **current** plan:

- A message that is **relevant now** (it references the current task/plan ID or
  carries a plan-change directive) is promoted to a pending re-plan candidate,
  so the restart re-enters planning with it.
- A message that is **still irrelevant** is acknowledged and dropped — it was
  queued precisely because it must not interrupt execution, and replaying it
  verbatim into a fresh plan could corrupt the work order.

This is a *local, non-live* read (the messages were already polled and persisted
by an earlier run); it is not an Agent Bus connection, so the "poll mode only"
live-delivery contract is unchanged. A missing or corrupt queue is a soft
failure: it surfaces as a `[WARNING]` and does not abort startup.

---

## Re-planning on a relevant message (loop-replan.ts)

When the poll returns one or more relevant messages, execution of the current
plan is deferred and the runtime re-enters the planning phase with those
messages as the new work order. `main.ts` runs the plan-then-execute flow again
(`runAgentReplanLoop`) and eventually cleans up once the whole replan loop
finishes or aborts.

- `extractReplanPrompt` concatenates the searchable text of every relevant
  message into the new prompt, so a multi-message directive is preserved.
- `resolveLoopReplanMaxIterations` bounds how many consecutive loop-driven
  replans a single run may perform to prevent an unbounded plan/execute churn.
  Env var `LOOP_REPLAN_MAX_ITERATIONS`, default `5`, minimum `1`.
- `decideSafeReplan` is the fail-safe guard run before re-entering planning:

  - A preserved execution worktree with staged work is kept and reused — that
    staged set is carried into the new plan rather than lost.
  - **Uncommitted changes on the main checkout block re-planning** with an
    actionable reason (commit, stash, or clean them), so a dirty main working
    tree can never be corrupted by the new execution phase.
  - An unknown ("cannot confirm") state is treated as a blocker so loop mode
    fails **closed** when it cannot prove the repository is safe to re-plan
    over.

---

## Module ownership and wiring

| Concern | Module | Wired by |
| ------- | ------ | -------- |
| CLI flag + mode rules | `cli-task-mode.ts` | `main.ts` |
| Classification rule | `loop-mode.ts` | `loop-poll.ts`, `main.ts` |
| Durable queue + drain | `loop-queue.ts` | `loop-poll.ts`, `main.ts` |
| Between-step poll | `loop-poll.ts` | `main.ts` |
| Idle listening loop | `loop-poll.ts` | `main.ts` (`runAgentReplanLoop`) |
| Re-plan prompt + safety | `loop-replan.ts` | `main.ts` |

## Tests

Focused tests live in `test/` and compile standalone via these npm scripts (the
Agent Bus is mocked — no network is touched):

- `npm run test:loop-mode`
- `npm run test:loop-queue`
- `npm run test:loop-poll`
- `npm run test:loop-replan`

They cover classification of relevant vs. queued messages, queue save/load,
restart draining (including the fail-safe undrained tail), re-plan invocation
on a relevant message, and the idle-loop primitive
(`pollLoopBusUntilMessage`: waiting for a relevant message, respecting the
idle-poll cap, and stopping on abort).
