import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, readFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { renderPrompt } from "../prompt-builder.js";
import { classifyToolCall, enforceExecutionPolicy, canonicalAbsolutePath } from "../tool-safety-classifier.js";
import { requestHttp, selectHttpAddress, isPublicAddress, httpPolicyFromEnvironment } from "../tools/http-transport.js";
import Grep from "../tools/Grep.js";
import Http from "../tools/Http.js";
import { executeCommand } from "../tools/ExecuteCommand.js";
import { sandboxArguments, shellModeFromEnvironment, type ShellPolicy } from "../tools/shell-policy.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function main() {
  const root = mkdtempSync(join(tmpdir(), "elastic-security-"));
  const workspace = join(root, "workspace"); const outside = join(root, "outside");
  mkdirSync(workspace); mkdirSync(outside);
  writeFileSync(join(outside, "sentinel"), "outside sentinel");
  const config = { enabled: false, agentSourceDir: workspace, startDir: workspace, startDirConfigured: true, allowAgentSourceModifications: false };
  const policyOptions = { workspaceRoot: workspace, toolSafetyConfig: config, isDocker: true, logger: () => {} };
  try {
    // Template expressions cannot execute, and values are never reinterpreted.
    (globalThis as any).__securitySentinel = 0;
    for (const template of ["${globalThis.__securitySentinel = 1}", "${process.exit(1)}", "${value.x}", "${missing}", "${", "${constructor}"]) {
      assert.throws(() => renderPrompt(template, { value: "ok" }));
    }
    assert.equal((globalThis as any).__securitySentinel, 0);
    delete (globalThis as any).__securitySentinel;
    assert.equal(renderPrompt("`${value}`\\n", { value: "${process.exit(1)}" }), "`${process.exit(1)}`\\n");
    const getter = Object.defineProperty({}, "value", { get() { throw new Error("getter executed"); } });
    assert.throws(() => renderPrompt("${value}", getter), /Unknown prompt/);
    const step = readFileSync("prompts/step-execution-prompt.txt", "utf8");
    assert.match(renderPrompt(step, { claudeInstructions: "policy", executionFeedbackFormat: "format", toolsAvailable: "tools", commitInstruction: "review first", plan: "plan", stepNumber: 2, stepCount: 3, step: "test", executionContext: "context" }), /step 2 of 3/);

    // Neither Docker nor disabled LLM classification disables mandatory checks.
    assert.equal((await classifyToolCall("Read", { path: join(outside, "x") }, policyOptions)).safe, false);
    assert.equal((await classifyToolCall("Read", { path: join(workspace, "data.json") }, policyOptions)).safe, false);
    assert.equal((await classifyToolCall("ExecuteCommand", { command: "some-unknown-program" }, policyOptions)).safe, false);
    const alias = join(workspace, "alias"); symlinkSync(outside, alias, "dir");
    assert.equal(canonicalAbsolutePath(join(alias, "nested", "new.txt")), join(outside, "nested", "new.txt"));
    assert.throws(() => enforceExecutionPolicy("Write", { path: join(alias, "new.txt"), content: "safe" }, policyOptions), /denied/);
    unlinkSync(alias); symlinkSync(workspace, alias, "dir");
    const checked = enforceExecutionPolicy("Write", { path: join(alias, "new.txt"), content: "safe" }, policyOptions);
    assert.equal(checked.path, join(workspace, "new.txt"));
    unlinkSync(alias); symlinkSync(outside, alias, "dir");
    assert.throws(() => enforceExecutionPolicy("Write", { path: join(alias, "new.txt"), content: "safe" }, policyOptions), /denied/);
    symlinkSync(join(outside, "absent"), join(workspace, "dangling"));
    assert.throws(() => enforceExecutionPolicy("Write", { path: join(workspace, "dangling"), content: "safe" }, policyOptions), /Dangling/);
    symlinkSync("loop", join(workspace, "loop"));
    assert.throws(() => enforceExecutionPolicy("Read", { path: join(workspace, "loop") }, policyOptions));
    writeFileSync(join(workspace, ".env"), "synthetic sentinel");
    symlinkSync(join(workspace, ".env"), join(workspace, "innocent.txt"));
    assert.throws(() => enforceExecutionPolicy("Read", { path: join(workspace, "innocent.txt") }, policyOptions), /denied/);
    assert.throws(() => enforceExecutionPolicy("Read", [], policyOptions), /object/);
    assert.throws(() => enforceExecutionPolicy("Read", { path: join(workspace, ".spec-keeper", "account.json") }, policyOptions), /protected/);
    writeFileSync(join(workspace, "safe.txt"), "synthetic public");
    writeFileSync(join(workspace, "data.json"), "synthetic private");
    linkSync(join(workspace, ".env"), join(workspace, "hardlink.txt"));
    assert.throws(() => enforceExecutionPolicy("Read", { path: join(workspace, "hardlink.txt") }, policyOptions), /Hardlinked/);
    const search = await Grep({ path: workspace, pattern: "synthetic", literal: true },
      (path) => { enforceExecutionPolicy("Read", { path }, policyOptions); });
    assert.deepEqual(search.files, [join(workspace, "safe.txt")]);

    console.log("PASS security: non-executable prompts and execution-time filesystem policy");

    // Network tests use local fixtures only; no public connections are made.
    for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"]) assert.equal(isPublicAddress(ip), false, ip);
    assert.equal(isPublicAddress("8.8.8.8"), true);
    assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
    assert.deepEqual(httpPolicyFromEnvironment({}), { allowedOrigins: [], privateOrigins: [] });
    let deniedHits = 0;
    const deniedServer = createServer((_req, res) => { deniedHits++; res.end("must not reach"); });
    const deniedOrigin = await listen(deniedServer);
    const server = createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { location: deniedOrigin }); res.end(); }
      else if (req.url === "/large") res.end("x".repeat(4096));
      else if (req.url === "/hang") { /* deadline closes connection */ }
      else if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
      else { res.writeHead(201, { "x-fixture": "present" }); res.end("fixture"); }
    });
    const origin = await listen(server);
    const policy = { allowedOrigins: [origin, deniedOrigin], privateOrigins: [origin] };
    try {
      await assert.rejects(requestHttp(origin, {}, { policy: { allowedOrigins: [], privateOrigins: [] } }), /not allowed/);
      await assert.rejects(requestHttp(origin, {}, { policy: { allowedOrigins: [origin], privateOrigins: [] } }), /non-public/);
      const result = await Http({ url: origin }, { policy });
      assert.equal(result.status, 201); assert.equal(result.headers["x-fixture"], "present"); assert.equal(result.body, "fixture");
      await assert.rejects(requestHttp(origin + "/redirect", {}, { policy }), /non-public/);
      assert.equal(deniedHits, 0);
      await assert.rejects(requestHttp(origin + "/redirect", {}, { policy: { allowedOrigins: [origin], privateOrigins: [origin] } }), /not allowed/);
      await assert.rejects(requestHttp(origin + "/large", {}, { policy, maxBytes: 128 }), /byte limit/);
      await assert.rejects(requestHttp(origin + "/hang", {}, { policy, timeoutMs: 30 }), /deadline/);
      await assert.rejects(requestHttp(origin + "/loop", {}, { policy }), /redirect limit/);
      await assert.rejects(requestHttp(origin, { headers: { Host: "other-host" } }, { policy }), /cannot be overridden/);
      const controller = new AbortController();
      const pending = requestHttp(origin + "/hang", {}, { policy, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(pending, /aborted/);
      const fake = origin.replace("127.0.0.1", "fixture.invalid");
      let lookups = 0;
      const pinned = await requestHttp(fake, {}, {
        policy: { allowedOrigins: [fake], privateOrigins: [fake] },
        resolveAddresses: async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; },
      });
      await assert.rejects(requestHttp(fake, {}, {
        policy: { allowedOrigins: [fake], privateOrigins: [fake] }, timeoutMs: 20,
        resolveAddresses: () => new Promise(() => {}),
      }), /deadline/);
      assert.equal(pinned.body, "fixture"); assert.equal(lookups, 1, "socket uses vetted DNS answer without a second lookup");
      assert.throws(() => selectHttpAddress(new URL("https://fixture.invalid"), { allowedOrigins: ["https://fixture.invalid"], privateOrigins: [] }, [
        { address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 },
      ]), /non-public/);
    } finally { await close(server); await close(deniedServer); }
    console.log("PASS security: HTTP destinations, pinned DNS, redirects, limits, and cancellation");

    const trusted: ShellPolicy = { mode: "trusted-host", writableRoots: [workspace], readableRoots: [] };
    assert.equal(shellModeFromEnvironment({}), "sandbox");
    assert.throws(() => shellModeFromEnvironment({ AGENT_SHELL_MODE: "typo" }));
    const saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "synthetic-only";
    try {
      const result = await executeCommand('printf "%s|%s" "$1" "${OPENAI_API_KEY-unset}"', ['literal $(false)'], workspace, { policy: trusted });
      assert.equal(result.stdout, "literal $(false)|unset");
    } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
    await assert.rejects(executeCommand("while :; do printf xxxxxxxxxxxxxxxxx; done", [], workspace, { policy: trusted, maxOutputBytes: 64 }), /byte limit/);
    await assert.rejects(executeCommand("sleep 10 & wait", [], workspace, { policy: trusted, timeoutMs: 30 }), /deadline/);
    const controller = new AbortController();
    const pending = executeCommand("sleep 10 & wait", [], workspace, { policy: trusted, signal: controller.signal });
    setTimeout(() => controller.abort(), 20); await assert.rejects(pending, /aborted/);
    // Remove fixture symlinks before sandbox scan; protect a secret hardlink too.
    for (const file of ["alias", "dangling", "loop", "innocent.txt"]) unlinkSync(join(workspace, file));
    linkSync(join(workspace, ".env"), join(workspace, "alias-file"));
    const restricted = { ...trusted, mode: "sandbox" as const };
    const args = sandboxArguments(restricted, workspace, "true", []);
    assert.ok(args.includes("--unshare-all")); assert.ok(args.includes("--clearenv"));
    assert.ok(args.includes(join(workspace, ".env"))); assert.ok(args.includes(join(workspace, "alias-file")));
    assert.ok(!args.includes("--share-net"));
    // Exercise the real sandbox if namespaces are supported. Otherwise verify
    // explicit failure, with no host execution fallback, using a marker.
    const marker = join(workspace, "sandbox-marker");
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: {
      build: "node -e \"require('fs').writeFileSync('built.txt', 'built')\"",
    } }));
    try {
      const probe = await executeCommand(`printf ok > '${marker}'`, [], workspace, { policy: restricted });
      assert.equal(probe.exitCode, 0);
      assert.equal(readFileSync(marker, "utf8"), "ok");
      const denied = await executeCommand(`cat '${join(outside, "sentinel")}'`, [], workspace, { policy: restricted });
      assert.notEqual(denied.exitCode, 0);
      const secret = await executeCommand(`cat '${join(workspace, ".env")}' '${join(workspace, "alias-file")}'`, [], workspace, { policy: restricted });
      assert.equal(secret.stdout, "");
      const build = await executeCommand("npm run build", [], workspace, { policy: restricted });
      assert.equal(build.exitCode, 0, build.stderr);
      assert.equal(readFileSync(join(workspace, "built.txt"), "utf8"), "built");
      const readonly = await executeCommand("touch forbidden.txt", [], workspace, { policy: { mode: "sandbox", readableRoots: [workspace], writableRoots: [] } });
      assert.notEqual(readonly.exitCode, 0);
      let networkHits = 0;
      const networkServer = createServer((_req, res) => { networkHits++; res.end("denied"); });
      const networkOrigin = await listen(networkServer);
      try {
        const code = `require("http").get(${JSON.stringify(networkOrigin)}, () => process.exit(0)).on("error", () => process.exit(7))`;
        const network = await executeCommand('node -e "$1"', [code], workspace, { policy: restricted, timeoutMs: 3000 });
        assert.equal(network.exitCode, 7);
        assert.equal(networkHits, 0);
      } finally { await close(networkServer); }
      console.log("PASS security: real bubblewrap filesystem/network isolation and npm build");
    } catch (error) {
      if (!/sandbox failed|spawn \/usr\/bin\/bwrap ENOENT/.test(String(error))) throw error;
      assert.throws(() => readFileSync(marker), /ENOENT/);
      if (process.env.AGENT_REQUIRE_SANDBOX_TESTS === "1") throw error;
      console.log("SKIP real isolation smoke: host namespaces/bubblewrap unavailable; PASS no host fallback");
    }
    console.log("PASS security: shell environment, limits, abort, and sandbox policy");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
