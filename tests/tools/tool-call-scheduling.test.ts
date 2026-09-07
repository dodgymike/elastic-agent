// Focused tests for dependency-aware tool-call scheduling.
//
// These tests exercise the exact rule set in docs/tools/TOOL_CALL_SCHEDULING.md against
// the pure policy modules (src/tools/tool-call-scheduler.ts and
// src/tools/tool-call-parallelism.ts) without booting src/main.ts:
//
//   - target-key extraction (per-tool file/dir/url/global mapping)
//   - conflict predicate (equal-or-ancestor paths, exact URLs, global keys)
//   - forward-only DAG construction (read->write, write->read, write->write,
//     independent read freedom, global-keyed serialization)
//   - bounded greedy scheduler (original-order results, max concurrency,
//     max parallelism 1 sequential fallback, dependency ordering, failures)
//   - --max-tool-call-parallelism validation (default, bounds, invalid values)
//
// Compiled and executed standalone by the `test:tool-call-scheduling` npm
// script.
import assert from "node:assert/strict";

import {
  buildToolCallDag,
  extractToolTargetKey,
  isSameOrUnderPath,
  runScheduledToolCalls,
  toolTargetKeysConflict,
} from "../../src/tools/tool-call-scheduler.js";
import type {
  ScheduledToolCallDescriptor,
  ToolCallDependencyEdge,
  ToolTargetKey,
} from "../../src/tools/tool-call-scheduler.js";
import {
  DEFAULT_MAX_TOOL_CALL_PARALLELISM,
  MAX_TOOL_CALL_PARALLELISM,
  MIN_TOOL_CALL_PARALLELISM,
  resolveMaxToolCallParallelism,
} from "../../src/tools/tool-call-parallelism.js";

const BASE = "/workspace";

/** Build a scheduler call descriptor with the supplied tool arguments. */
function call(toolName: string, args: Record<string, unknown> = {}): ScheduledToolCallDescriptor {
  return { toolName, arguments: args };
}

/** Build a dependency DAG using a fixed base directory for relative paths. */
function dagOf(...calls: ScheduledToolCallDescriptor[]): ToolCallDependencyEdge[] {
  return buildToolCallDag(calls, { cwd: BASE });
}

/** A minimal manually-resolved promise, useful for deterministic concurrency tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Yield to the macrotask queue so every queued microtask has run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------
  // 1. Target-key extraction (docs/tools/TOOL_CALL_SCHEDULING.md section 3).
  // ------------------------------------------------------------------
  {
    assert.deepEqual(
      extractToolTargetKey("Read", { path: "a.txt" }, { cwd: BASE }),
      { kind: "file", value: `${BASE}/a.txt` },
      "Read maps `path` to an absolute file key",
    );
    assert.deepEqual(
      extractToolTargetKey("FileSize", { path: "/abs/b.txt" }, { cwd: BASE }),
      { kind: "file", value: "/abs/b.txt" },
      "FileSize maps `path` to a file key and keeps absolute paths",
    );
    assert.deepEqual(
      extractToolTargetKey("ListDirectory", { directory: "src" }, { cwd: BASE }),
      { kind: "dir", value: `${BASE}/src` },
      "ListDirectory maps `directory` to a dir key",
    );
    assert.deepEqual(
      extractToolTargetKey("Find", { path: "src" }, { cwd: BASE }),
      { kind: "dir", value: `${BASE}/src` },
      "Find maps `path` to a dir key",
    );
    assert.deepEqual(
      extractToolTargetKey("Grep", { path: "src" }, { cwd: BASE }),
      { kind: "dir", value: `${BASE}/src` },
      "Grep maps `path` to a dir key",
    );
    assert.deepEqual(
      extractToolTargetKey("Write", { path: "out.txt" }, { cwd: BASE }),
      { kind: "file", value: `${BASE}/out.txt` },
      "Write maps `path` to a file key",
    );
    assert.deepEqual(
      extractToolTargetKey("Edit", { path: "out.txt" }, { cwd: BASE }),
      { kind: "file", value: `${BASE}/out.txt` },
      "Edit maps `path` to a file key",
    );
    assert.deepEqual(
      extractToolTargetKey("Delete", { path: "out.txt" }, { cwd: BASE }),
      { kind: "file", value: `${BASE}/out.txt` },
      "Delete maps `path` to a file key",
    );
    assert.deepEqual(
      extractToolTargetKey("Mkdir", { path: "dir" }, { cwd: BASE }),
      { kind: "dir", value: `${BASE}/dir` },
      "Mkdir maps `path` to a dir key",
    );
    assert.deepEqual(
      extractToolTargetKey("Rmdir", { path: "dir" }, { cwd: BASE }),
      { kind: "dir", value: `${BASE}/dir` },
      "Rmdir maps `path` to a dir key",
    );
    assert.deepEqual(
      extractToolTargetKey("Http", { url: " https://example.test/a " }, { cwd: BASE }),
      { kind: "url", value: "https://example.test/a" },
      "Http maps `url` to a trimmed exact URL key",
    );
    assert.deepEqual(
      extractToolTargetKey("HttpRequest", { url: "https://example.test/a" }, { cwd: BASE }),
      { kind: "url", value: "https://example.test/a" },
      "HttpRequest maps `url` to a URL key",
    );
    assert.deepEqual(
      extractToolTargetKey("ExecuteCommand", { command: "git status" }, { cwd: BASE }),
      { kind: "global", value: "global" },
      "ExecuteCommand falls back to a global key",
    );
    assert.deepEqual(
      extractToolTargetKey("Git", { mode: "status" }, { cwd: BASE }),
      { kind: "global", value: "global" },
      "Git falls back to a global key",
    );
    assert.deepEqual(
      extractToolTargetKey("AgentBus", { action: "whoami" }, { cwd: BASE }),
      { kind: "global", value: "global" },
      "AgentBus falls back to a global key",
    );
    assert.deepEqual(
      extractToolTargetKey("AgentBusEnrol", {}, { cwd: BASE }),
      { kind: "global", value: "global" },
      "AgentBusEnrol falls back to a global key",
    );
    assert.deepEqual(
      extractToolTargetKey("SpecKeeper", { path: "/goals" }, { cwd: BASE }),
      { kind: "global", value: "global" },
      "SpecKeeper falls back to a global key",
    );
    assert.deepEqual(
      extractToolTargetKey("SpecKeeperEnrol", {}, { cwd: BASE }),
      { kind: "global", value: "global" },
      "SpecKeeperEnrol falls back to a global key",
    );
    assert.deepEqual(
      extractToolTargetKey("TotallyUnknownTool", { path: "a.txt" }, { cwd: BASE }),
      { kind: "global", value: "global" },
      "Unknown tools fail closed as global",
    );

    // Fail-closed extraction: missing, empty, or non-string targets.
    assert.deepEqual(
      extractToolTargetKey("Read", {}, { cwd: BASE }),
      { kind: "global", value: "global" },
      "Missing target argument fails closed as global",
    );
    assert.deepEqual(
      extractToolTargetKey("Read", { path: "" }, { cwd: BASE }),
      { kind: "global", value: "global" },
      "Empty target fails closed as global",
    );
    assert.deepEqual(
      extractToolTargetKey("Read", { path: "   " }, { cwd: BASE }),
      { kind: "global", value: "global" },
      "Whitespace-only target fails closed as global",
    );
    assert.deepEqual(
      extractToolTargetKey("Read", { path: 42 }, { cwd: BASE }),
      { kind: "global", value: "global" },
      "Non-string target fails closed as global",
    );
    assert.deepEqual(
      extractToolTargetKey("Read", null, { cwd: BASE }),
      { kind: "global", value: "global" },
      "Non-object arguments fail closed as global",
    );

    // --start-dir becomes the base for relative paths when configured.
    assert.deepEqual(
      extractToolTargetKey(
        "Read",
        { path: "a.txt" },
        { cwd: BASE, startDirConfigured: true, startDir: "/start" },
      ),
      { kind: "file", value: "/start/a.txt" },
      "Relative paths resolve against the configured --start-dir",
    );
    assert.deepEqual(
      extractToolTargetKey(
        "Read",
        { path: "/abs/a.txt" },
        { cwd: BASE, startDirConfigured: true, startDir: "/start" },
      ),
      { kind: "file", value: "/abs/a.txt" },
      "Absolute paths ignore the configured --start-dir",
    );
  }

  // ------------------------------------------------------------------
  // 2. Conflict predicate (docs/tools/TOOL_CALL_SCHEDULING.md section 4).
  // ------------------------------------------------------------------
  {
    const fileA: ToolTargetKey = { kind: "file", value: "/a/one.txt" };
    const fileB: ToolTargetKey = { kind: "file", value: "/a/two.txt" };
    const dirA: ToolTargetKey = { kind: "dir", value: "/a" };
    const root: ToolTargetKey = { kind: "dir", value: "/" };
    const global: ToolTargetKey = { kind: "global", value: "global" };
    const urlX: ToolTargetKey = { kind: "url", value: "https://example.test/x" };
    const urlY: ToolTargetKey = { kind: "url", value: "https://example.test/y" };

    assert.equal(toolTargetKeysConflict(fileA, fileA), true, "equal file keys conflict");
    assert.equal(toolTargetKeysConflict(fileA, fileB), false, "sibling files do not conflict");
    assert.equal(toolTargetKeysConflict(dirA, fileA), true, "directory ancestor conflicts with descendant file");
    assert.equal(toolTargetKeysConflict(fileA, dirA), true, "conflict predicate is symmetric");
    assert.equal(toolTargetKeysConflict(root, fileB), true, "root is an ancestor of every absolute path");
    assert.equal(toolTargetKeysConflict(global, fileA), true, "global key conflicts with path key");
    assert.equal(toolTargetKeysConflict(fileA, global), true, "path key conflicts with global key");
    assert.equal(toolTargetKeysConflict(urlX, urlX), true, "equal URLs conflict");
    assert.equal(toolTargetKeysConflict(urlX, urlY), false, "distinct URLs do not conflict");
    assert.equal(toolTargetKeysConflict(urlX, fileA), false, "URL and path keys do not conflict");
  }

  // isSameOrUnderPath degenerate cases.
  {
    assert.equal(isSameOrUnderPath("/a", "/a"), true, "equal path is same-or-under");
    assert.equal(isSameOrUnderPath("/a/b/c", "/a"), true, "descendant is under ancestor");
    assert.equal(isSameOrUnderPath("/a", "/a/b"), false, "ancestor is not under descendant");
    assert.equal(isSameOrUnderPath("/ab/c", "/a"), false, "separator boundary prevents prefix confusion");
    assert.equal(isSameOrUnderPath("/a/b", "/"), true, "root is an ancestor of every absolute path");
  }

  // ------------------------------------------------------------------
  // 3. DAG edge construction (docs/tools/TOOL_CALL_SCHEDULING.md section 5).
  // ------------------------------------------------------------------
  {
    assert.deepEqual(
      dagOf(call("Read", { path: "/a.txt" }), call("Write", { path: "/a.txt" })),
      [{ from: 0, to: 1 }],
      "read before write on the same target",
    );
    assert.deepEqual(
      dagOf(call("Write", { path: "/a.txt" }), call("Read", { path: "/a.txt" })),
      [{ from: 0, to: 1 }],
      "read after write on the same target",
    );
    assert.deepEqual(
      dagOf(call("Write", { path: "/a.txt" }), call("Write", { path: "/a.txt" })),
      [{ from: 0, to: 1 }],
      "writes to the same target are serialized",
    );
    assert.deepEqual(
      dagOf(call("Read", { path: "/a.txt" }), call("Read", { path: "/a.txt" })),
      [],
      "read/read pairs never conflict, even on the same target",
    );
    assert.deepEqual(
      dagOf(call("Read", { path: "/a.txt" }), call("Write", { path: "/b.txt" })),
      [],
      "disjoint read/write pairs have no edge",
    );
    assert.deepEqual(
      dagOf(call("Read", { path: "/a" }), call("Write", { path: "/a/b.txt" })),
      [{ from: 0, to: 1 }],
      "directory read before descendant write",
    );
    assert.deepEqual(
      dagOf(call("Write", { path: "/a/b.txt" }), call("Read", { path: "/a" })),
      [{ from: 0, to: 1 }],
      "descendant write before directory read",
    );
    assert.deepEqual(
      dagOf(call("Read", { path: "/a" }), call("ExecuteCommand", { command: "git status" })),
      [{ from: 0, to: 1 }],
      "global-keyed call waits for an earlier read",
    );
    assert.deepEqual(
      dagOf(call("ExecuteCommand", { command: "git status" }), call("Read", { path: "/a" })),
      [{ from: 0, to: 1 }],
      "later reads wait for an earlier global-keyed call",
    );
    assert.deepEqual(
      dagOf(
        call("Read", { path: "/a" }),
        call("Read", { path: "/b" }),
        call("ExecuteCommand", { command: "git status" }),
      ),
      [
        { from: 0, to: 2 },
        { from: 1, to: 2 },
      ],
      "independent reads both precede the global-keyed call",
    );
    assert.deepEqual(
      dagOf(call("Read", { path: "/a" }), call("TotallyUnknownTool", { path: "/b" })),
      [{ from: 0, to: 1 }],
      "unknown tools serialize with everything (fail closed)",
    );
    assert.deepEqual(
      dagOf(call("Http", { url: "https://example.test/x" }), call("HttpRequest", { url: "https://example.test/x" })),
      [{ from: 0, to: 1 }],
      "HTTP GET before a mutating request on the same URL",
    );
    assert.deepEqual(
      dagOf(call("HttpRequest", { url: "https://example.test/x" }), call("Http", { url: "https://example.test/x" })),
      [{ from: 0, to: 1 }],
      "mutating request before HTTP GET on the same URL",
    );
    assert.deepEqual(
      dagOf(call("Http", { url: "https://example.test/x" }), call("Http", { url: "https://example.test/x" })),
      [],
      "read/read URL pairs never conflict",
    );
    assert.deepEqual(
      dagOf(call("Http", { url: "https://example.test/x" }), call("Http", { url: "https://example.test/y" })),
      [],
      "distinct URL reads have no edge",
    );
  }

  // ------------------------------------------------------------------
  // 4. Scheduler runner (docs/tools/TOOL_CALL_SCHEDULING.md section 6).
  // ------------------------------------------------------------------
  {
    // I5: results are returned in original order even when calls complete
    // out of order.
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];
    const settled: number[] = [];
    let active = 0;
    let maxActive = 0;
    const resultPromise = runScheduledToolCalls(
      [
        call("Read", { path: "/a.txt" }),
        call("Read", { path: "/b.txt" }),
        call("Read", { path: "/c.txt" }),
      ],
      [],
      3,
      (_call, index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(index);
        return gates[index].promise.then((value) => {
          active -= 1;
          settled.push(index);
          return value;
        });
      },
    );
    await tick();
    assert.deepEqual(started, [0, 1, 2], "independent reads all start with max parallelism 3");
    assert.equal(maxActive, 3, "three independent reads run concurrently");
    // Complete in reverse order; results must still be original-order.
    gates[2].resolve("r2");
    await tick();
    gates[0].resolve("r0");
    await tick();
    gates[1].resolve("r1");
    const results = await resultPromise;
    assert.deepEqual(results, ["r0", "r1", "r2"], "results are collected in original index order");
    assert.deepEqual(settled, [2, 0, 1], "completion order may differ from result order");
  }

  {
    // I4: at most maxToolCallParallelism calls run at once.
    const count = 5;
    const gates = Array.from({ length: count }, () => deferred<string>());
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const resultPromise = runScheduledToolCalls(
      Array.from({ length: count }, (_, i) => call("Read", { path: `/r${i}.txt` })),
      [],
      2,
      (_call, index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(index);
        return gates[index].promise.then((value) => {
          active -= 1;
          return value;
        });
      },
    );
    await tick();
    assert.deepEqual(started, [0, 1], "only two independent reads start under max parallelism 2");
    assert.equal(maxActive, 2, "concurrency never exceeds max parallelism");

    gates[0].resolve("r0");
    await tick();
    assert.deepEqual(started, [0, 1, 2], "a completed call immediately admits the next runnable call");

    gates[1].resolve("r1");
    await tick();
    assert.deepEqual(started, [0, 1, 2, 3], "the queue advances as in-flight work settles");

    gates[2].resolve("r2");
    await tick();
    assert.deepEqual(started, [0, 1, 2, 3, 4], "all calls are eventually admitted");

    gates[3].resolve("r3");
    gates[4].resolve("r4");
    const results = await resultPromise;
    assert.deepEqual(results, ["r0", "r1", "r2", "r3", "r4"], "bounded run preserves original-order results");
    assert.equal(maxActive, 2, "the in-flight cap is never exceeded");
  }

  {
    // I1/I2: a dependent never starts before its prerequisite settles.
    const gates = [deferred<string>(), deferred<string>()];
    const started: number[] = [];
    const resultPromise = runScheduledToolCalls(
      [call("Write", { path: "/a.txt" }), call("Read", { path: "/a.txt" })],
      [{ from: 0, to: 1 }],
      4,
      (_call, index) => {
        started.push(index);
        return gates[index].promise;
      },
    );
    await tick();
    assert.deepEqual(started, [0], "the dependent read does not start before the write settles");
    gates[0].resolve("w");
    await tick();
    assert.deepEqual(started, [0, 1], "the dependent read starts only after the write settles");
    gates[1].resolve("r");
    assert.deepEqual(await resultPromise, ["w", "r"], "dependent result order matches original order");
  }

  {
    // I4 + n == 1: maximum parallelism 1 reproduces exact sequential dispatch.
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];
    const resultPromise = runScheduledToolCalls(
      [
        call("Read", { path: "/s0.txt" }),
        call("Read", { path: "/s1.txt" }),
        call("Read", { path: "/s2.txt" }),
      ],
      [],
      1,
      (_call, index) => {
        started.push(index);
        return gates[index].promise;
      },
    );
    await tick();
    assert.deepEqual(started, [0], "n==1 starts only the first call");
    gates[0].resolve("r0");
    await tick();
    assert.deepEqual(started, [0, 1], "n==1 admits the next call only after the previous settles");
    gates[1].resolve("r1");
    await tick();
    assert.deepEqual(started, [0, 1, 2], "n==1 preserves strict original-order execution");
    gates[2].resolve("r2");
    assert.deepEqual(await resultPromise, ["r0", "r1", "r2"], "n==1 results match sequential order");
  }

  {
    // A predecessor resolving with an error-shaped value is still a settled
    // result and must not block its dependents (tool errors are results).
    const started: number[] = [];
    const results = await runScheduledToolCalls(
      [call("Write", { path: "/a.txt" }), call("Read", { path: "/a.txt" })],
      [{ from: 0, to: 1 }],
      4,
      (_call, index): Promise<{ error?: string; ok?: string }> => {
        started.push(index);
        if (index === 0) {
          return Promise.resolve({ error: "write failed" });
        }
        return Promise.resolve({ ok: "read" });
      },
    );
    assert.deepEqual(started, [0, 1], "a failed write is a result and does not block its dependent");
    assert.deepEqual(
      results,
      [{ error: "write failed" }, { ok: "read" }],
      "failed call results are preserved in original order",
    );
  }

  {
    // A run callback rejection is fatal: the scheduler surfaces it after
    // already-in-flight work settles.
    let inFlightSettled = false;
    await assert.rejects(
      runScheduledToolCalls(
        [call("Read", { path: "/a.txt" }), call("Read", { path: "/b.txt" })],
        [],
        2,
        (_call, index): Promise<string> => {
          if (index === 0) {
            return Promise.reject(new Error("boom"));
          }
          return new Promise((resolve) => {
            setTimeout(() => {
              inFlightSettled = true;
              resolve("ok");
            }, 5);
          });
        },
      ),
      /boom/,
      "a run rejection rejects the scheduler promise",
    );
    assert.equal(inFlightSettled, true, "in-flight work settles before the fatal error surfaces");
  }

  {
    // Invalid or backward edges are ignored; every call still runs once.
    const started: number[] = [];
    const results = await runScheduledToolCalls(
      [call("Read", { path: "/a.txt" }), call("Read", { path: "/b.txt" })],
      [
        { from: 1, to: 0 },
        { from: 0, to: 5 },
        { from: -1, to: 0 },
      ],
      2,
      (_call, index) => {
        started.push(index);
        return Promise.resolve(`r${index}`);
      },
    );
    assert.deepEqual(results, ["r0", "r1"], "invalid edges still yield both results");
    assert.deepEqual(started.slice().sort((a, b) => a - b), [0, 1], "every call runs exactly once");
  }

  {
    // Non-finite or sub-1 parallelism falls back to 1 (fail closed).
    const gates = [deferred<string>(), deferred<string>()];
    const started: number[] = [];
    const resultPromise = runScheduledToolCalls(
      [call("Read", { path: "/a.txt" }), call("Read", { path: "/b.txt" })],
      [],
      Number.NaN,
      (_call, index) => {
        started.push(index);
        return gates[index].promise;
      },
    );
    await tick();
    assert.deepEqual(started, [0], "non-finite parallelism falls back to sequential");
    gates[0].resolve("r0");
    await tick();
    assert.deepEqual(started, [0, 1], "fallback admits the next call after the first settles");
    gates[1].resolve("r1");
    assert.deepEqual(await resultPromise, ["r0", "r1"], "fallback preserves original-order results");
  }

  {
    // Empty batches resolve to an empty result array.
    const results = await runScheduledToolCalls(
      [],
      [],
      4,
      async (): Promise<string> => {
        throw new Error("run must not be called for an empty batch");
      },
    );
    assert.deepEqual(results, [], "empty batches produce an empty result array");
  }

  // ------------------------------------------------------------------
  // 5. --max-tool-call-parallelism validation.
  // ------------------------------------------------------------------
  {
    assert.equal(MIN_TOOL_CALL_PARALLELISM, 1, "minimum parallelism is 1");
    assert.equal(MAX_TOOL_CALL_PARALLELISM, 16, "maximum parallelism is 16");
    assert.equal(DEFAULT_MAX_TOOL_CALL_PARALLELISM, 4, "default parallelism is 4");

    assert.equal(resolveMaxToolCallParallelism(undefined), 4, "omitted option uses the default");
    assert.equal(resolveMaxToolCallParallelism(null), 4, "null uses the default");
    assert.equal(resolveMaxToolCallParallelism("1"), 1, "string '1' is valid");
    assert.equal(resolveMaxToolCallParallelism(" 4 "), 4, "whitespace-padded values are trimmed and valid");
    assert.equal(resolveMaxToolCallParallelism("16"), 16, "string '16' is the upper bound");
    assert.equal(resolveMaxToolCallParallelism(1), 1, "number 1 is valid");
    assert.equal(resolveMaxToolCallParallelism(4), 4, "number 4 is valid");
    assert.equal(resolveMaxToolCallParallelism(16), 16, "number 16 is the upper bound");

    const invalidValues: unknown[] = [
      0,
      17,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0",
      "17",
      "-1",
      "4.5",
      "1e2",
      "abc",
      "",
      "   ",
      {},
      [],
      true,
    ];
    for (const value of invalidValues) {
      assert.throws(
        () => resolveMaxToolCallParallelism(value),
        /--max-tool-call-parallelism must be an integer between 1 and 16/,
        `invalid value ${JSON.stringify(value)} fails fast with a usage error`,
      );
    }
  }
}

main()
  .then(() => {
    console.log("Tool-call scheduling and parallelism policy tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
