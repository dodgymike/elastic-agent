import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAgentLog } from "../agent-log.js";
const root = mkdtempSync(join(tmpdir(), "agent-log-"));
try {
    const path = join(root, "agent.log");
    assert.equal(appendAgentLog(path, { event: "plan", status: "created", tldr: "Inspect\nthen implement", steps: ["Read source", "Implement fix"], session: "s", run: "r" }), true);
    for (const status of ["succeeded", "failed", "blocked", "invalid", "needs-verification", "aborted", "returned"]) {
        assert.equal(appendAgentLog(path, { event: "step", status, step: 1, tldr: "x".repeat(1000), session: "s", run: "r" }), true);
    }
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 8);
    assert.equal(records[0].tldr, "Inspect then implement");
    assert.deepEqual(records[0].steps, ["Read source", "Implement fix"]);
    assert.equal(records[1].tldr.length, 240);
    assert.equal(records[2].status, "failed");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(appendAgentLog(root, { event: "step", status: "failed", tldr: "cannot write", session: "s", run: "r" }), false);
    console.log("Agent log append, formatting, status, permissions, and failure tests passed.");
} finally { rmSync(root, { recursive: true, force: true }); }
