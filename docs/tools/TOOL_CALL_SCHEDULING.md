# Tool-Call Dependency Ordering & Safe Parallel Scheduling (Design)

**Scope:** execution-plan step 2, *Define a conservative dependency-ordering rule
set for safe parallel execution*. This is a design document only. CLI wiring
(`--max-tool-call-parallelism`) is plan step 3, scheduler implementation is
plan step 4, and focused tests are plan step 5.

## 1. Goals and invariants

The scheduler replaces the two sequential tool-dispatch loops
(`executePlanStep` and `runSingleStep` in `src/main.ts`) while preserving their
observable semantics. The invariants:

- **I1 — conflict ordering.** If two tool calls in one model response conflict,
  their completion order must match the order the model emitted them.
- **I2 — no conflicting overlap.** Two calls that conflict never run at the same
  time.
- **I3 — read/read freedom.** Read-only calls never block each other, even when
  they target the same path or URL.
- **I4 — bounded concurrency.** At most `maxToolCallParallelism` calls run
  concurrently (minimum 1, which must reproduce today's exact sequential
  behavior).
- **I5 — original result order.** Tool results are handed back to the model in
  the order the calls appeared in the response, never in completion order.
- **I6 — fail closed.** A call we cannot classify or for which we cannot extract
  a target is treated as globally serial and mutating.

## 2. Risk classification

Reuse `toolRiskLevel(toolName)` from `src/safety/tool-safety-classifier.ts`. Its mapping is
already the authoritative read/write/unknown base:

| Risk | Tools |
| --- | --- |
| `readonly` | `Read`, `FileSize`, `ListDirectory`, `Find`, `Grep`, `Http` |
| `mutating` | `Write`, `Edit`, `Delete`, `Mkdir`, `Rmdir`, `ExecuteCommand`, `Git`, `HttpRequest`, `AgentBus`, `AgentBusEnrol`, `SpecKeeper`, `SpecKeeperEnroll` |
| `unknown` | any tool name not listed above |

`unknown` is treated as mutating for conflict purposes and assigned a global
target key (rule 6), so it serializes with everything.

## 3. Target-key extraction

Each call gets one canonical target key with a `kind`:

- `file` — an exact file path.
- `dir` — a directory path (the call reads or mutates the directory and, for
  reads, its entry set or subtree).
- `url` — a URL string.
- `global` — no extractable/shared target; must serialize with every other call.

### 3.1 Normalization

- Non-string, empty, or whitespace-only target values produce `global`.
- Path-like values are normalized with `path.resolve(value)` against the
  process working directory (or the configured `--start-dir` when
  `toolSafetyConfig.startDirConfigured` is true), then separators are
  normalized. Existence is **not** required at scheduling time.
- URL values are trimmed; the exact normalized string is compared. No
  host/scheme rewriting in v1 (over-serializing distinct URLs is safe and
  conservative).

### 3.2 Per-tool extraction table

| Tool | Risk | Key kind | Source argument | Notes |
| --- | --- | --- | --- | --- |
| `Read` | readonly | `file` | `path` | |
| `FileSize` | readonly | `file` | `path` | |
| `ListDirectory` | readonly | `dir` | `directory` | reads the immediate entry set |
| `Find` | readonly | `dir` | `path` | recursive search under `path` |
| `Grep` | readonly | `dir` | `path` | if `path` is a file, the ancestor test degenerates to an exact-file comparison |
| `Write` | mutating | `file` | `path` | |
| `Edit` | mutating | `file` | `path` | |
| `Delete` | mutating | `file` | `path` | |
| `Mkdir` | mutating | `dir` | `path` | `recursive:true` may also create ancestors; the ancestor test below orders reads/writes around the created path |
| `Rmdir` | mutating | `dir` | `path` | `recursive:true` removes the whole subtree; the ancestor test below covers descendants |
| `Http` | readonly | `url` | `url` | |
| `HttpRequest` | mutating | `url` | `url` | classified mutating regardless of HTTP method |
| `ExecuteCommand` | mutating | `global` | — | command text is too variable; default serial |
| `Git` | mutating | `global` | — | shared `.git`/worktree state; default serial |
| `AgentBus` | mutating | `global` | — | process-local CLI and credential store |
| `AgentBusEnrol` | mutating | `global` | — | writes identity files |
| `SpecKeeper` | mutating | `global` | — | remote API state |
| `SpecKeeperEnroll` | mutating | `global` | — | writes credential/config files |
| anything else | `unknown` | `global` | — | fail closed |

**Hash-verified file mutations.** `Edit`, `Delete`, and `Write` (via
`read_hash`) already refuse stale content at the tool level. The scheduler does
not need content awareness: within a batch, the same-path read-before-write edge
in rule 5 naturally orders a `Read`/`FileSize` before a later same-path
mutation, and the tools themselves enforce cross-batch correctness by rejecting
stale hashes.

## 4. Conflict predicate

```
function keysConflict(a, b):
    if a.kind == "global" or b.kind == "global":
        return true
    if a.kind == "url" or b.kind == "url":
        return a.kind == "url" and b.kind == "url" and a.value == b.value
    // both are path-like (file or dir)
    return isSameOrUnder(a.value, b.value) or isSameOrUnder(b.value, a.value)
```

`isSameOrUnder(child, ancestor)` is true when `child == ancestor`, or `child`
starts with `ancestor + path.sep`. The root separator `"/"` is an ancestor of
every absolute path, so a directory read of `"/"` conflicts with every
path-like call (correct and conservative).

The ancestor-or-equal test is what preserves sequential semantics for directory
reads: `ListDirectory(D)`, `Find(D)`, and `Grep(D)` observe the entry set or
subtree under `D`, so any mutation at `D` or below can change their result. A
mutation to `D/x` must therefore be ordered relative to a directory read of
`D`. Two different files under the same directory (`/a/b.txt` vs `/a/c.txt`)
do **not** conflict and may run concurrently.

## 5. Edge construction (DAG)

For every pair of calls `i < j` in the model response (original order):

```
edge i -> j  iff  (risk(i) != "readonly" or risk(j) != "readonly")
                  and keysConflict(key(i), key(j))
```

Edges always point from an earlier index to a later index, so the graph is
acyclic by construction. Read/read pairs never receive an edge, even for the
same target.

Worked examples (A and B are different paths with no ancestor relationship):

| Calls | Edges | Effect |
| --- | --- | --- |
| `Read A`, `Write A` | 0→1 | write waits for the read (read-before-write) |
| `Write A`, `Read A` | 0→1 | read waits for the write (read-after-write) |
| `Write A`, `Write A` | 0→1 | writes to the same target are serialized |
| `Read A`, `Read A` | none | parallel |
| `Read A`, `Write B` | none | independent; parallel up to the limit |
| `Read /a`, `Write /a/b.txt` | 0→1 | directory read before descendant write |
| `Read /a`, `ExecuteCommand` | 0→1 | global-keyed call waits for earlier reads |
| `ExecuteCommand`, `Read /a` | 0→1 | later reads wait for a global-keyed call |
| `Read /a`, `Read /b`, `ExecuteCommand` | 0→2, 1→2 | the two reads run concurrently; the command waits for both |

## 6. Scheduler contract

- Input: the ordered `function_call` outputs from one model response, plus the
  configured `maxToolCallParallelism` (`n >= 1`; default `4`; suggested upper
  bound `16` — see plan step 3 for validation).
- Build the DAG with the rule above, then run a greedy topological scheduler:
  a node is runnable when all of its predecessors have completed; start as many
  runnable nodes as possible without exceeding `n` in flight.
- `n == 1` must reproduce today's exact sequential order and semantics.
- **Completion** means the call's dispatch promise settled, whether the tool
  succeeded or failed. A failed call is a result; it does not abort scheduling
  of its dependents (today's loop already continues after individual tool
  errors and lets the model see the error result).
- Results are collected into `toolOutputs` in original index order (I5), not in
  completion order.
- `saveData(configData)` / `saveMemory(configData.memory)` run once per response
  batch after collection, exactly as they do today — never once per concurrent
  call.

## 7. Shared-state guards (implementation requirements)

`dispatchToolCall` touches process-global and config-shared state. Step 4 must
not run those sections concurrently. The concrete requirements:

1. **Denial tracker (`configData`).** Load the tracker once per batch, record
   each call's denial/success in original index order during the serial result
   phase, and persist once per batch. No concurrent load/persist interleavings.
2. **Terminal rendering and timers.** All stdout writes (`renderToolCallPending`,
   `renderToolCallSucceeded`, `renderToolCallFailed`, `startToolTimer`) are
   serialized. Recommended shape: pending render plus parsing/classification in
   a serial prepare phase (original order), and success/failure rendering in the
   serial result phase; only the actual `exec_handler` runs concurrently.
3. **`--start-dir` cwd switching.** `process.cwd()` is process-global, so
   per-call `switchToStartDir`/`restoreStartDir` cannot interleave across
   concurrent executors. Implementation must choose exactly one of:
   - (a) switch to the start directory once around the whole batch and restore
     afterwards, with the serial prepare/result phases running while cwd is
     stable; or
   - (b) fall back to `n == 1` when `toolSafetyConfig.startDirConfigured` is
     true.
   `AgentBus` remains exempt from start-dir injection exactly as it is today.
4. **Shared LLM runtime (`client`).** The safety classifier and the
   `ExecuteCommand` git-command router make LLM calls on the shared runtime.
   They must stay in the serial prepare phase, never inside the concurrent
   window.
5. **Tool-call history.** `appendHistory(configData.toolCallTldrs, ...)` is
   applied in original index order in the serial result phase.

### 7.1 Recommended dispatch split (for step 4)

- `prepareToolCall(output, ...)` — parse JSON arguments, find the
  `exec_handler`, run the `ExecuteCommand` preflight + git routing, run the
  safety classifier, render the pending line. Serial, original order.
- `executePreparedToolCall(...)` — run `exec_handler` under the tool timer with
  cwd already stable. Concurrent, bounded by `n`.
- result phase — render success/failure, update the denial tracker and tool-call
  history, and build `toolOutputs`. Serial, original order.

## 8. Conservative-default summary

The scheduler may run concurrently only:

- read/read pairs (any keys), and
- path/url-disjoint pairs with no `global` key,

bounded by `maxToolCallParallelism`. Everything else is serialized:

- same or overlapping path (ancestor-or-equal),
- same URL,
- any `global`-keyed call (so all `ExecuteCommand`, `Git`, `AgentBus`,
  `AgentBusEnrol`, `SpecKeeper`, `SpecKeeperEnroll`, and unknown tools default
  to serial execution),
- any write/read or write/write pair whose keys conflict,
- any call whose tool name is unknown or whose target argument is missing,
  empty, or unparseable (fail closed as `global`).

## 9. Non-goals for this change

- No cross-batch scheduling: each model response is scheduled independently.
- No model-declared dependency annotations (e.g. a `dependsOn` field) in v1;
  dependencies are inferred solely from tool arguments.
- No content-hash awareness beyond the existing tool-level `read_hash` /
  `file_hash` verification.
- No case-insensitive filesystem handling in v1 (Linux path semantics assumed);
  note as future work if Windows/macOS support is required.
