import assert from "node:assert/strict";
import { MultiTurnLlmRuntime } from "../llm/multi-turn-runtime.js";
import type { GenerateRequest, GenerateResponse, LlmAdapter } from "../llm/adapter-contract.js";
import type { ContextRequest, MemoryContextResult, MemoryModule } from "../memory/types.js";

/** A scripted fake adapter: each generate() shifts the next queued response. */
function scriptedAdapter(responses: GenerateResponse[]): { adapter: LlmAdapter; requests: GenerateRequest[] } {
    const requests: GenerateRequest[] = [];
    const adapter: LlmAdapter = {
        provider: "fixture",
        capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
        async generate(request) {
            requests.push(request);
            const next = responses.shift();
            if (!next) throw new Error("fixture adapter script exhausted");
            return next;
        },
    };
    return { adapter, requests };
}

/** A fake adapter that always returns the same response. */
function constantAdapter(response: GenerateResponse): { adapter: LlmAdapter; requests: GenerateRequest[] } {
    const requests: GenerateRequest[] = [];
    const adapter: LlmAdapter = {
        provider: "fixture",
        capabilities: { toolCalling: true, systemMessages: true, developerMessages: true },
        async generate(request) {
            requests.push(request);
            return response;
        },
    };
    return { adapter, requests };
}

function stopResponse(text = "done"): GenerateResponse {
    return { model: "fixture-model", finishReason: "stop", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function toolResponse(calls: readonly { id: string; name: string }[]): GenerateResponse {
    return {
        model: "fixture-model",
        finishReason: "tool_calls",
        message: {
            role: "assistant",
            content: [{ type: "text", text: "calling" }],
            toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: {} })),
        },
    };
}

function toolResult(callId: string, output = "{}") {
    return { type: "function_call_output" as const, call_id: callId, output };
}

class StubMemory implements MemoryModule {
    contextCalls = 0;
    constructor(readonly result: MemoryContextResult) {}
    async remember(): Promise<void> {}
    async getContext(_request: ContextRequest): Promise<MemoryContextResult> {
        this.contextCalls += 1;
        return this.result;
    }
}

function initialText(request: GenerateRequest): string {
    const message = request.messages[0];
    if (!message || message.role !== "user") return "";
    return message.content[0]?.text ?? "";
}

async function testBoundedRetention(): Promise<void> {
    // Thousands of completed stub conversations leave a bounded number of
    // retained handles and message references.
    const { adapter, requests } = constantAdapter(stopResponse("stub"));
    const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { maxRetainedConversations: 8 });
    for (let index = 0; index < 2000; index += 1) {
        await runtime.create({ input: `stub-${index}` });
    }
    const stats = runtime.conversationStats();
    assert.equal(requests.length, 2000, "every stub completion reaches the fake provider exactly once");
    assert.equal(stats.active, 0, "no pending-call conversations remain");
    assert.equal(stats.completed, 8, "completed conversations are retained up to the configured ceiling");
    assert.equal(stats.retained, 8, "retained handles stay bounded at the ceiling");
    assert.equal(stats.releasedCount, 2000 - 8, "every completion beyond the ceiling is released");
    assert.ok(stats.estimatedRetainedBytes > 0, "retained transcripts contribute a size estimate");

    // A zero ceiling releases completed conversations immediately.
    const immediate = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { maxRetainedConversations: 0 });
    for (let index = 0; index < 100; index += 1) {
        await immediate.create({ input: `immediate-${index}` });
    }
    const immediateStats = immediate.conversationStats();
    assert.equal(immediateStats.retained, 0, "zero ceiling retains no completed conversation");
    assert.equal(immediateStats.releasedCount, 100, "zero ceiling releases each completed conversation immediately");
    console.log("  ok: bounded conversation retention");
}

async function testContinuationValidationBeforeProviderCall(): Promise<void> {
    const { adapter, requests } = scriptedAdapter([
        toolResponse([{ id: "call-1", name: "Read" }, { id: "call-2", name: "Grep" }]),
        stopResponse("final"),
    ]);
    const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
    const first = await runtime.create({ input: "go", scope: "scope-a", purpose: "inspect" });
    assert.equal(first.conversation_id, "conv-1");
    assert.deepEqual(runtime.conversationHandle(first.id)?.pendingCallIds, ["call-1", "call-2"]);
    const callsBefore = requests.length;

    // Unknown response id.
    await assert.rejects(
        () => runtime.create({ previous_response_id: "missing", input: [] }),
        /unknown previous_response_id/,
    );
    // Cross-scope continuation.
    await assert.rejects(
        () => runtime.create({ previous_response_id: first.id, scope: "scope-b", input: [toolResult("call-1"), toolResult("call-2")] }),
        /scope mismatch/,
    );
    // Duplicate result id.
    await assert.rejects(
        () => runtime.create({ previous_response_id: first.id, input: [toolResult("call-1"), toolResult("call-1")] }),
        /duplicate tool result for call 'call-1'/,
    );
    // Missing result id.
    await assert.rejects(
        () => runtime.create({ previous_response_id: first.id, input: [toolResult("call-1")] }),
        /missing tool result for call 'call-2'/,
    );
    // Unknown tool call id.
    await assert.rejects(
        () => runtime.create({ previous_response_id: first.id, input: [toolResult("call-1"), toolResult("call-2"), toolResult("call-x")] }),
        /unknown tool call 'call-x'/,
    );
    assert.equal(requests.length, callsBefore, "rejected continuations must not reach the provider");

    const second = await runtime.create({ previous_response_id: first.id, input: [toolResult("call-1"), toolResult("call-2")] });
    assert.equal(requests.length, callsBefore + 1, "only the valid continuation reaches the provider");
    assert.equal(second.finishReason, "stop");
    console.log("  ok: continuation validation fails before any provider call");
}

async function testStaleAndCompletedResponseIdsFail(): Promise<void> {
    // A completed conversation cannot be continued.
    const completed = scriptedAdapter([stopResponse("complete")]);
    const completedRuntime = new MultiTurnLlmRuntime(completed.adapter, "fixture-model");
    const done = await completedRuntime.create({ input: "one" });
    await assert.rejects(
        () => completedRuntime.create({ previous_response_id: done.id, input: [] }),
        /stale previous_response_id.*completed/,
    );
    assert.equal(completed.requests.length, 1, "stale continuation never reaches the provider");

    // A conversation that has advanced to a newer pending response rejects an
    // older response id.
    const advanced = scriptedAdapter([
        toolResponse([{ id: "call-a", name: "Read" }]),
        toolResponse([{ id: "call-b", name: "Grep" }]),
        stopResponse("done"),
    ]);
    const advancedRuntime = new MultiTurnLlmRuntime(advanced.adapter, "fixture-model");
    const first = await advancedRuntime.create({ input: "start" });
    const second = await advancedRuntime.create({ previous_response_id: first.id, input: [toolResult("call-a")] });
    assert.deepEqual(advancedRuntime.conversationHandle(second.id)?.pendingCallIds, ["call-b"]);
    await assert.rejects(
        () => advancedRuntime.create({ previous_response_id: first.id, input: [toolResult("call-a")] }),
        /stale previous_response_id.*advanced/,
    );
    assert.equal(advanced.requests.length, 2, "advanced stale id never reaches the provider");
    const third = await advancedRuntime.create({ previous_response_id: second.id, input: [toolResult("call-b")] });
    assert.equal(third.finishReason, "stop");
    console.log("  ok: stale and completed response ids fail");
}

async function testActiveContinuationPreservesMemorySnapshot(): Promise<void> {
    const memory = new StubMemory({ text: "remembered: inspected repo layout", matchedContexts: [], hasMemory: true });
    const { adapter, requests } = scriptedAdapter([
        toolResponse([{ id: "call-1", name: "Read" }]),
        stopResponse("done"),
    ]);
    const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { memory, sessionId: "sess-mem" });
    const first = await runtime.create({ input: "continue the work" });
    const handle = runtime.conversationHandle(first.conversation_id!);
    assert.equal(handle?.state, "active", "a pending-call conversation stays active");
    assert.equal(handle?.scope, "default");
    assert.equal(handle?.purpose, "default");
    assert.ok(handle?.memorySnapshotRevision !== undefined, "the handle records the memory snapshot revision");
    assert.equal(handle?.messageCount, 2, "initial transcript has the user message and the assistant response");

    const snapshot = initialText(requests[0]);
    assert.ok(snapshot.includes("[SESSION MEMORY"), "initial prompt carries the memory suffix");
    assert.ok(snapshot.includes("remembered: inspected repo layout"));

    const second = await runtime.create({ previous_response_id: first.id, input: [toolResult("call-1")] });
    assert.equal(second.finishReason, "stop");
    assert.equal(initialText(requests[1]), snapshot, "the continuation reuses the exact initial memory snapshot");
    assert.equal(runtime.conversationHandle(first.conversation_id!)?.state, "completed");
    console.log("  ok: active continuations preserve their initial memory snapshot");
}

async function testReleaseDoesNotDisturbOtherConversationsOrMemory(): Promise<void> {
    const memory = new StubMemory({ text: "", matchedContexts: [], hasMemory: false });
    const { adapter, requests } = scriptedAdapter([
        toolResponse([{ id: "call-a", name: "Read" }]), // A: active
        stopResponse("b done"), // B: completed
        stopResponse("a done"), // A: continuation
    ]);
    const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { memory, sessionId: "sess-rel" });
    const a = await runtime.create({ input: "a", scope: "scope-a" });
    const b = await runtime.create({ input: "b", scope: "scope-b" });
    const contextCallsBefore = memory.contextCalls;

    assert.equal(runtime.releaseConversation(b.conversation_id!), true, "a completed conversation can be released");
    assert.equal(runtime.conversationHandle(b.conversation_id!), undefined, "released handles are no longer addressable");
    assert.equal(memory.contextCalls, contextCallsBefore, "releasing a conversation must not touch durable memory");

    assert.throws(
        () => runtime.releaseConversation(a.conversation_id!),
        /cannot release active conversation/,
    );

    const continued = await runtime.create({ previous_response_id: a.id, input: [toolResult("call-a")] });
    assert.equal(continued.finishReason, "stop", "releasing B must not affect the active conversation A");
    assert.equal(requests.length, 3);

    assert.equal(runtime.cancelConversation(a.conversation_id!), true, "an active conversation can be cancelled explicitly");
    assert.equal(runtime.conversationHandle(a.conversation_id!), undefined);
    console.log("  ok: releasing one conversation leaves other active conversations and memory untouched");
}

async function testCloseCancelsAndRejectsFurtherRequests(): Promise<void> {
    const { adapter } = scriptedAdapter([
        toolResponse([{ id: "call-1", name: "Read" }]),
        stopResponse("done"),
    ]);
    const runtime = new MultiTurnLlmRuntime(adapter, "fixture-model");
    const active = await runtime.create({ input: "active" });
    await runtime.create({ input: "completed" });
    assert.ok(runtime.conversationStats().retained >= 2);
    runtime.close();
    assert.equal(runtime.conversationStats().retained, 0, "close drops all retained transcripts");
    assert.equal(runtime.conversationHandle(active.conversation_id!), undefined);
    await assert.rejects(() => runtime.create({ input: "after close" }), /runtime is closed/);
    runtime.close(); // idempotent
    console.log("  ok: close cancels retained conversations and rejects further requests");
}

async function testRetentionLimitValidation(): Promise<void> {
    const { adapter } = constantAdapter(stopResponse("ok"));
    assert.throws(
        () => new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { maxRetainedConversations: -1 }),
        /non-negative integer/,
    );
    assert.throws(
        () => new MultiTurnLlmRuntime(adapter, "fixture-model", undefined, { maxRetainedConversations: 1.5 }),
        /non-negative integer/,
    );
    console.log("  ok: invalid retention ceilings are rejected at construction");
}

async function main(): Promise<void> {
    await testBoundedRetention();
    await testContinuationValidationBeforeProviderCall();
    await testStaleAndCompletedResponseIdsFail();
    await testActiveContinuationPreservesMemorySnapshot();
    await testReleaseDoesNotDisturbOtherConversationsOrMemory();
    await testCloseCancelsAndRejectsFurtherRequests();
    await testRetentionLimitValidation();
    console.log("Multi-turn conversation lifecycle tests passed");
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
