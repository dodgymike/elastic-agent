import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecuteCommandError, executeCommand, type ShellPolicy } from "../../src/tools/ExecuteCommand.js";
import { HttpTransportError, requestHttp } from "../../src/tools/http-transport.js";

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "elastic-tool-lifecycle-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const trusted: ShellPolicy = { mode: "trusted-host", writableRoots: [workspace], readableRoots: [] };
    try {
        // 1. Endless shell output is capped and the capped prefix plus the
        //    truncation flag survive on the error for the caller/model.
        try {
            await executeCommand("while :; do printf xxxxxxxxxxxxxxxxx; done", [], workspace, { policy: trusted, maxOutputBytes: 64 });
            assert.fail("expected output-limit rejection");
        } catch (error) {
            assert.ok(error instanceof ExecuteCommandError, "error must be ExecuteCommandError");
            assert.match(error.message, /byte limit/);
            assert.equal(error.stdout.length, 64, "stdout must be capped at exactly maxOutputBytes");
            assert.equal(error.stdoutTruncated, true, "stdout must be flagged truncated");
            assert.equal(error.toToolPayload().stdout, error.stdout, "tool payload preserves partial stdout");
            assert.equal(typeof error.toToolPayload().reason, "string", "tool payload preserves cancellation reason");
        }

        // 2. A hanging process group terminates on deadline and the reason is
        //    returned as an error rather than hanging the run.
        const deadlineStarted = Date.now();
        try {
            await executeCommand("sleep 10 & wait", [], workspace, { policy: trusted, timeoutMs: 50 });
            assert.fail("expected deadline rejection");
        } catch (error) {
            assert.ok(error instanceof ExecuteCommandError, "deadline must produce ExecuteCommandError");
            assert.match(error.message, /deadline/);
            assert.ok(Date.now() - deadlineStarted < 5_000, "deadline must not wait for the sleep child");
        }

        // 3. An abort signal terminates the process group with an abort reason.
        const abortController = new AbortController();
        const aborted = executeCommand("sleep 10 & wait", [], workspace, { policy: trusted, signal: abortController.signal });
        setTimeout(() => abortController.abort(), 20);
        await assert.rejects(
            aborted,
            (error: unknown) => error instanceof ExecuteCommandError && /aborted/.test(error.message),
        );

        // 4. An already-aborted signal prevents any spawn from happening.
        const preAborted = new AbortController();
        preAborted.abort();
        await assert.rejects(
            executeCommand("touch marker.txt", [], workspace, { policy: trusted, signal: preAborted.signal }),
            (error: unknown) => error instanceof Error && /aborted/.test(error.message),
        );

        // 5. Successful shell runs report clean, non-truncated streams.
        const ok = await executeCommand('printf "hello"', [], workspace, { policy: trusted });
        assert.equal(ok.stdout, "hello");
        assert.equal(ok.exitCode, 0);
        assert.equal(ok.stdoutTruncated, false);
        assert.equal(ok.stderrTruncated, false);

        // 6. HTTP response reading stops at its byte limit and the capped body
        //    prefix plus the truncation flag survive on the error.
        const server = createServer((_req, res) => { res.end("y".repeat(4096)); });
        const origin = await listen(server);
        const policy = { allowedOrigins: [origin], privateOrigins: [origin] };
        try {
            await assert.rejects(
                requestHttp(origin, {}, { policy, maxBytes: 128 }),
                (error: unknown) => error instanceof HttpTransportError
                    && /byte limit/.test(error.message)
                    && error.truncated === true
                    && error.partialBody.length === 128
                    && error.reason === "output-limit",
            );
        } finally {
            await close(server);
        }

        console.log("PASS tool-lifecycle: shell/HTTP deadlines, cancellation, and output ceilings");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
