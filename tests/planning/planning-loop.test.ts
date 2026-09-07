import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runPlanningLoop, planningCallAllowed } from "../../src/llm/planning-loop.js";
import { planStepsFromObject } from "../../src/planning/prompt-parser.js";
import type { CompatibleResponse, CompatibleCreateRequest } from "../../src/llm/multi-turn-runtime.js";
const call = (name: string, args: object = {}) => ({ type: "function_call" as const, call_id: name, name, arguments: JSON.stringify(args) });
const reply = (id: string, output: CompatibleResponse["output"]): CompatibleResponse => ({ id, output });
const final = (text: string) => ({ type: "message" as const, status: "completed" as const, content: [{ type: "output_text" as const, text }] });
const plan = JSON.stringify({ steps: [{ step_number: 1, tldr: "Implement the observed fix" }] });

/** Build a valid structured plan whose steps can be overridden per fixture. */
const structuredPlan = (overrides: { goal?: string; steps?: object[] } = {}): string =>
    JSON.stringify({
        planId: "PLAN-grounded",
        version: 1,
        goal: overrides.goal ?? "Reach the requested outcome using verified current evidence.",
        scope: "Only the requested outcome; no already-satisfied or unsupported work.",
        steps: overrides.steps ?? [{
            id: 1,
            objective: "Verify the existing fix",
            expectedArtifact: "passing focused test",
            completionCriteria: ["The focused test passes against the current source"],
            dependencies: [],
        }],
        acceptanceCriteria: ["The requested outcome is satisfied and verified"],
    });
async function main() {
    const requests: CompatibleCreateRequest[] = [];
    const dispatched: string[] = [];
    const responses = [reply("1", [call("Read", { path: "README.md" })]), reply("2", [call("Http", { url: "https://example.com" })]), reply("3", [final("not json")]), reply("4", [final(plan)])];
    const result = await runPlanningLoop({ prompt: "instructions", tools: [], create: async (request) => { requests.push(request); return responses.shift()!; }, onResponse: () => {}, dispatch: async (c) => { dispatched.push(c.name); return { type: "function_call_output", call_id: c.call_id, output: JSON.stringify({ content: "research evidence" }) }; } });
    assert.equal(result.result.kind, "plan");
    assert.deepEqual(dispatched, ["Read", "Http"]);
    assert.equal(requests[1].previous_response_id, "1");
    assert.equal(requests[2].previous_response_id, "2");
    assert.match(String(requests[3].input), /research evidence/);
    assert.match(String(requests[3].input), /not json/);
    assert.equal(planningCallAllowed(call("Write")), false);
    assert.equal(planningCallAllowed(call("Git", { action: "commit" })), false);
    assert.equal(planningCallAllowed(call("Git", { mode: "status" })), true);
    assert.equal(planningCallAllowed(call("Http", { method: "POST" })), false);
    assert.equal(planningCallAllowed(call("ExecuteCommand")), false);
    let executed = 0;
    const base = { prompt: "x", tools: [], onResponse: () => {}, dispatch: async (c: ReturnType<typeof call>) => { executed++; return { type: "function_call_output" as const, call_id: c.call_id, output: "{}" }; } };
    await assert.rejects(runPlanningLoop({ ...base, maxToolRounds: 1, create: async () => reply("loop", [call("Read")]) }), /budget exhausted/);
    assert.equal(executed, 1);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(runPlanningLoop({ ...base, signal: abort.signal, create: async () => { throw new Error("must not generate"); } }), /abort/i);
    const refused = [reply("deny", [call("Write")]), reply("done", [final(plan)])];
    executed = 0;
    await runPlanningLoop({ ...base, create: async (request) => { if (request.previous_response_id) assert.match(JSON.stringify(request.input), /research only/); return refused.shift()!; } });
    assert.equal(executed, 0);
    const aborted = await runPlanningLoop({ ...base, create: async () => reply("abort", [final('{"abort":true,"reason":"Missing evidence"}')]) });
    assert.equal(aborted.result.kind, "abort");

    // PI-04: the planning prefix must require grounded evidence when scope is
    // uncertain, observations with source paths/revision plus assumptions, and
    // treat retrieved session memory as historical rather than current fact.
    {
        const prefix = readFileSync(join(process.cwd(), "prompts", "planning-prefix.txt"), "utf-8");
        assert.match(prefix, /When the scope of the request is uncertain, you MUST read the relevant files,\s+tests, and tool capabilities before returning a plan/);
        assert.match(prefix, /cite the source path \(and Git\s+revision when known\)/);
        assert.match(prefix, /assumptions that still\s+need verification during execution/);
        assert.match(prefix, /historical evidence,\s+not current fact/);
        assert.match(prefix, /Every step must advance a requested outcome/);
        assert.match(prefix, /Planning is investigation, not implementation/);
        assert.match(prefix, /100 tool-call rounds and 250 calls/);
        assert.match(prefix, /REQUIRED STRUCTURED PLAN SHAPE/);
    }

    // PI-04 fixture: misleading historical memory. The model must read the
    // current source and plan only against the evidence passed through the
    // loop's tool-result continuation, avoiding the stale "fix" step.
    {
        const requests: CompatibleCreateRequest[] = [];
        const dispatched: { name: string; args: Record<string, unknown> }[] = [];
        const prompt = [
            "Make the refund path correct.",
            "",
            "[SESSION MEMORY — additional context remembered from earlier in this session]",
            "src/payment.ts still has the legacy refund bug and must be fixed.",
        ].join("\n");
        const grounded = structuredPlan({
            steps: [{
                id: 1,
                objective: "Verify the existing refund fix in src/payment.ts",
                expectedArtifact: "passing focused test",
                completionCriteria: ["A focused test exercises the refund path and passes"],
                dependencies: [],
            }],
        });
        const result = await runPlanningLoop({
            prompt,
            tools: [],
            create: async (request) => {
                requests.push(request);
                if (!request.previous_response_id) return reply("1", [call("Read", { path: "src/payment.ts" })]);
                const evidence = JSON.stringify(request.input);
                if (!evidence.includes("already fixed in commit abc123")) throw new Error("current evidence was not passed through to the model");
                return reply("2", [final(grounded)]);
            },
            onResponse: () => {},
            dispatch: async (c) => {
                dispatched.push({ name: c.name, args: JSON.parse(c.arguments) as Record<string, unknown> });
                return { type: "function_call_output", call_id: c.call_id, output: JSON.stringify({ content: "src/payment.ts already fixed in commit abc123" }) };
            },
        });
        assert.equal(result.result.kind, "plan");
        if (result.result.kind !== "plan") throw new Error("expected a plan");
        const steps = planStepsFromObject(result.result.plan).join("\n");
        assert.match(steps, /verify the existing refund fix/i);
        assert.doesNotMatch(steps, /fix the legacy refund bug/i);
        assert.equal(dispatched[0]?.name, "Read");
        assert.equal(dispatched[0]?.args.path, "src/payment.ts");
        assert.match(JSON.stringify(requests[1]?.input), /already fixed in commit abc123/);
    }

    // PI-04 fixture: missing sandbox support. The model must confirm tool
    // capabilities and plan around what actually exists instead of a sandbox.
    {
        const dispatched: string[] = [];
        const prompt = "Run the full test suite inside the sandbox tool.";
        const grounded = structuredPlan({
            goal: "Run the full test suite using the tools that actually exist.",
            steps: [{
                id: 1,
                objective: "Run the full test suite with the local npm test runner",
                expectedArtifact: "passing test run output",
                completionCriteria: ["npm test exits 0"],
                dependencies: [],
            }],
        });
        const result = await runPlanningLoop({
            prompt,
            tools: [],
            create: async (request) => {
                if (!request.previous_response_id) return reply("1", [call("ListDirectory", { directory: "tools" })]);
                const evidence = JSON.stringify(request.input);
                if (!evidence.includes("no sandbox runner")) throw new Error("capability evidence was not passed through to the model");
                return reply("2", [final(grounded)]);
            },
            onResponse: () => {},
            dispatch: async (c) => {
                dispatched.push(c.name);
                return { type: "function_call_output", call_id: c.call_id, output: JSON.stringify({ content: "tools directory contains no sandbox runner" }) };
            },
        });
        assert.equal(result.result.kind, "plan");
        if (result.result.kind !== "plan") throw new Error("expected a plan");
        const steps = planStepsFromObject(result.result.plan).join("\n");
        assert.doesNotMatch(steps, /sandbox/i);
        assert.match(steps, /local npm test runner/i);
        assert.deepEqual(dispatched, ["ListDirectory"]);
    }

    // PI-04 fixture: pre-existing fix. Memory claims a docs section is missing;
    // the model must read the file and avoid re-adding content already present.
    {
        const dispatched: string[] = [];
        const prompt = [
            "Update the deployment docs.",
            "",
            "[SESSION MEMORY — additional context remembered from earlier in this session]",
            "docs/DEPLOY.md is missing the rollback section and needs it added.",
        ].join("\n");
        const grounded = structuredPlan({
            goal: "Ensure the deployment docs are current without re-adding existing content.",
            steps: [{
                id: 1,
                objective: "Confirm docs/DEPLOY.md already contains the rollback section",
                expectedArtifact: "verified current doc",
                completionCriteria: ["Grep finds the rollback section in docs/DEPLOY.md"],
                dependencies: [],
            }],
        });
        const result = await runPlanningLoop({
            prompt,
            tools: [],
            create: async (request) => {
                if (!request.previous_response_id) return reply("1", [call("Read", { path: "docs/DEPLOY.md" })]);
                const evidence = JSON.stringify(request.input);
                if (!evidence.includes("rollback section already present")) throw new Error("current evidence was not passed through to the model");
                return reply("2", [final(grounded)]);
            },
            onResponse: () => {},
            dispatch: async (c) => {
                dispatched.push(c.name);
                return { type: "function_call_output", call_id: c.call_id, output: JSON.stringify({ content: "docs/DEPLOY.md rollback section already present" }) };
            },
        });
        assert.equal(result.result.kind, "plan");
        if (result.result.kind !== "plan") throw new Error("expected a plan");
        const steps = planStepsFromObject(result.result.plan).join("\n");
        assert.doesNotMatch(steps, /add the rollback section/i);
        assert.match(steps, /already contains the rollback section/i);
        assert.deepEqual(dispatched, ["Read"]);
    }

    console.log("Planning loop research, continuation, repair, restrictions, budgets, abort, and grounded-evidence fixture tests passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
