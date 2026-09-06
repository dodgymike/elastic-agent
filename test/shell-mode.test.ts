import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addShellOptions } from "../cli-shell-options.js";
import { resolveShellMode, shellSandboxFailureMessage } from "../tools/shell-policy.js";
import { executeCommand, ExecuteCommandError } from "../tools/ExecuteCommand.js";

function parse(args: string[]) {
  const program = addShellOptions(new Command()).exitOverride().configureOutput({ writeErr: () => {} });
  program.parse(args, { from: "user" });
  return program.opts().shellMode;
}
async function main() {
  assert.equal(resolveShellMode(parse([]), {}), "sandbox");
  assert.equal(resolveShellMode(parse([]), { AGENT_SHELL_MODE: "trusted-host" }), "trusted-host");
  assert.equal(resolveShellMode(parse(["--shell-mode", "trusted-host"]), { AGENT_SHELL_MODE: "sandbox" }), "trusted-host");
  assert.equal(resolveShellMode(parse(["--shell-mode=sandbox"]), { AGENT_SHELL_MODE: "trusted-host" }), "sandbox");
  assert.throws(() => parse(["--shell-mode", "auto"]));
  assert.throws(() => parse(["--shell-mode"]));
  assert.throws(() => resolveShellMode(undefined, { AGENT_SHELL_MODE: "typo" }));
  assert.match(shellSandboxFailureMessage(), /--shell-mode trusted-host/);
  assert.match(shellSandboxFailureMessage(), /AGENT_SHELL_MODE=trusted-host/);
  const cwd = mkdtempSync(join(tmpdir(), "shell-mode-"));
  const mode = resolveShellMode(parse(["--shell-mode", "trusted-host"]), {});
  const policy = { mode, readableRoots: [], writableRoots: [cwd] };
  try {
    const result = await executeCommand('printf "%s" "$1"', ["host shell works"], cwd, { policy });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "host shell works");
    assert.equal(result.stdoutTruncated, false);
    const failure = await executeCommand("printf visible; sleep 5", [], cwd, { policy, timeoutMs: 100 }).then(() => null, (error) => error);
    assert.ok(failure instanceof ExecuteCommandError);
    assert.match(failure.message, /deadline/);
    assert.equal(failure.stdout, "visible");
    assert.equal(failure.toToolPayload().stdout, "visible");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  console.log("Shell mode CLI precedence, host execution, and bounded-output regressions passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
