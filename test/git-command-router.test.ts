// Unit tests for git-command-router.ts: the ExecuteCommand preflight that
// refuses supported git commands, routes unclear git commands to the LLM
// classifier, and fails closed when no safe decision can be produced.
// Compiled and executed standalone by the `test:git-command-router` npm script.
import {
  gitCommandSubcommand,
  routeGitExecuteCommand,
  tokenizeShellWords,
} from "../git-command-router.js";
import type { CompatibleResponse, MultiTurnLlmRuntime } from "../llm/multi-turn-runtime.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

const silentLogger = (): void => {};

function responseWithText(text: string): CompatibleResponse {
  return {
    id: "mock-response",
    output: [
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

function mockRuntime(handler: (input: string) => Promise<string>): MultiTurnLlmRuntime {
  return {
    async create(request: { input: string }) {
      return responseWithText(await handler(request.input));
    },
  } as unknown as MultiTurnLlmRuntime;
}

const tmpDir = mkdtempSync(join(tmpdir(), "git-command-router-test-"));
const tempPrompt = join(tmpDir, "git-command-router.md");
writeFileSync(
  tempPrompt,
  [
    "You are a git-command router. Respond in JSON only.",
    "Return { \"safe\": boolean, \"reason\": string }.",
    "GIT COMMAND:",
    "AVAILABLE GIT TOOL:",
  ].join("\n"),
  "utf8",
);

async function main(): Promise<void> {
  try {
    // ------------------------------------------------------------------
    // 1. Shell tokenization and subcommand detection.
    // ------------------------------------------------------------------
    check(
      "tokenizeShellWords honors single and double quotes",
      JSON.stringify(tokenizeShellWords('git -C "/path with spaces" status')) ===
        JSON.stringify(["git", "-C", "/path with spaces", "status"]),
    );
    check(
      "gitCommandSubcommand finds a plain subcommand",
      gitCommandSubcommand("git status --short") === "status",
    );
    check(
      "gitCommandSubcommand skips -C and its value",
      gitCommandSubcommand("git -C /repo status --short") === "status",
    );
    check(
      "gitCommandSubcommand skips --no-pager",
      gitCommandSubcommand("git --no-pager diff --stat") === "diff",
    );
    check(
      "gitCommandSubcommand skips -c and its value",
      gitCommandSubcommand("git -c core.pager=cat log --oneline") === "log",
    );
    check(
      "gitCommandSubcommand returns null for git --version",
      gitCommandSubcommand("git --version") === null,
    );
    check(
      "gitCommandSubcommand ignores non-git commands",
      gitCommandSubcommand("echo git status") === null,
    );

    // ------------------------------------------------------------------
    // 2. Clear mappings are refused with actionable Git tool suggestions
    //    and never call the classifier LLM.
    // ------------------------------------------------------------------
    let llmCalled = false;
    const throwingRuntime = mockRuntime(async () => {
      llmCalled = true;
      throw new Error("classifier must not run for a clear mapping");
    });
    const clearCases: Array<[string, string, RegExp]> = [
      ["git status", "router", /Git\(\{ mode: "status" \}\)/],
      ["git log --oneline -5", "router", /Git\(\{ mode: "log" \}\)/],
      ["git diff --check", "router", /Git\(\{ mode: "diff" \}\)/],
      ["git ls-files --others --exclude-standard", "router", /Git\(\{ mode: "ls-files" \}\)/],
      ["git add README.md", "router", /Git\(\{ action: "stage"/],
      ["git commit -m \"hello\"", "router", /Git\(\{ action: "commit"/],
    ];
    for (const [command, source, pattern] of clearCases) {
      const result = await routeGitExecuteCommand(command, { runtime: throwingRuntime, logger: silentLogger });
      check(
        `clear git command is refused: ${command}`,
        result.action === "refuse" && result.source === source && pattern.test(result.reason),
      );
    }
    check(
      "global git options still resolve to a clear refusal",
      (await routeGitExecuteCommand("git -C /repo status --short", { runtime: throwingRuntime, logger: silentLogger })).action === "refuse",
    );
    check(
      "a combined command starting with git status is refused",
      (await routeGitExecuteCommand("git status --short && git log --oneline -5", { runtime: throwingRuntime, logger: silentLogger })).action === "refuse",
    );
    check(
      "clear mappings never call the classifier LLM",
      llmCalled === false,
    );

    // ------------------------------------------------------------------
    // 3. Non-git commands pass through unchanged.
    // ------------------------------------------------------------------
    for (const command of ["ls -la", "echo hello", "cd /repo && git status", "", 42]) {
      const result = await routeGitExecuteCommand(command as unknown, { logger: silentLogger });
      check(
        `non-git or invalid command is ignored: ${String(command)}`,
        result.action === "none",
      );
    }

    // ------------------------------------------------------------------
    // 4. Unclear git commands fail closed when no LLM is available.
    // ------------------------------------------------------------------
    const noRuntime = await routeGitExecuteCommand("git show", { logger: silentLogger });
    check(
      "unclear git command fails closed without an LLM runtime",
      noRuntime.action === "refuse" && noRuntime.source === "fallback" && /git show/.test(noRuntime.reason),
    );
    const versionNoRuntime = await routeGitExecuteCommand("git --version", { logger: silentLogger });
    check(
      "git --version is routed to the classifier and fails closed without an LLM",
      versionNoRuntime.action === "refuse" && versionNoRuntime.source === "fallback",
    );

    // ------------------------------------------------------------------
    // 5. The LLM router can allow or refuse unclear git commands.
    // ------------------------------------------------------------------
    const allowRuntime = mockRuntime(async () => '{"safe":true,"reason":"read-only and outside Git modes"}');
    const allowed = await routeGitExecuteCommand("git show", {
      runtime: allowRuntime,
      promptPath: tempPrompt,
      logger: silentLogger,
    });
    check(
      "LLM router can allow a read-only unclear git command",
      allowed.action === "allow" && allowed.source === "llm",
    );

    const refuseRuntime = mockRuntime(async () => '{"safe":false,"reason":"use Git({ mode: \\"log\\" })"}');
    const refused = await routeGitExecuteCommand("git branch", {
      runtime: refuseRuntime,
      promptPath: tempPrompt,
      logger: silentLogger,
    });
    check(
      "LLM router refusal is respected",
      refused.action === "refuse" && refused.source === "llm" && /Git/.test(refused.reason),
    );

    const versionRuntime = mockRuntime(async () => '{"safe":true,"reason":"version is read-only"}');
    const versionAllowed = await routeGitExecuteCommand("git --version", {
      runtime: versionRuntime,
      promptPath: tempPrompt,
      logger: silentLogger,
    });
    check(
      "LLM router handles git --version",
      versionAllowed.action === "allow" && versionAllowed.source === "llm",
    );

    // ------------------------------------------------------------------
    // 6. Router prompt includes the command and Git tool list, redacted.
    // ------------------------------------------------------------------
    const secretValue = `sk-${"a".repeat(24)}`;
    let capturedPrompt = "";
    const captureRuntime = mockRuntime(async (input) => {
      capturedPrompt = input;
      return '{"safe":false,"reason":"do not configure credentials through ExecuteCommand"}';
    });
    await routeGitExecuteCommand(
      `git config --global user.password "${secretValue}"`,
      { runtime: captureRuntime, promptPath: tempPrompt, logger: silentLogger },
    );
    check(
      "router prompt contains the redacted git command",
      /git config/.test(capturedPrompt) && /<redacted/.test(capturedPrompt),
    );
    check(
      "router prompt never contains the raw credential",
      !capturedPrompt.includes(secretValue),
    );
    check(
      "router prompt lists the available Git tool modes/actions",
      /mode: "status"/.test(capturedPrompt) && /action: "commit"/.test(capturedPrompt),
    );

    // ------------------------------------------------------------------
    // 7. LLM failure modes fail closed.
    // ------------------------------------------------------------------
    let createCalls = 0;
    const invalidRuntime = mockRuntime(async () => {
      createCalls += 1;
      return "this is not json";
    });
    const invalid = await routeGitExecuteCommand("git show", {
      runtime: invalidRuntime,
      promptPath: tempPrompt,
      logger: silentLogger,
    });
    check(
      "router fails closed after invalid LLM output",
      invalid.action === "refuse" && invalid.source === "fallback",
    );
    check(
      "router retries invalid LLM output up to the configured limit",
      createCalls === 3,
    );

    const boomRuntime = mockRuntime(async () => {
      throw new Error("provider down");
    });
    const threw = await routeGitExecuteCommand("git show", {
      runtime: boomRuntime,
      promptPath: tempPrompt,
      logger: silentLogger,
    });
    check(
      "router fails closed when the LLM request throws",
      threw.action === "refuse" && threw.source === "fallback",
    );

    const missingPrompt = await routeGitExecuteCommand("git show", {
      runtime: allowRuntime,
      promptPath: join(tmpDir, "does-not-exist.md"),
      logger: silentLogger,
    });
    check(
      "router fails closed when the prompt file cannot be read",
      missingPrompt.action === "refuse" && missingPrompt.source === "fallback",
    );
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (failures === 0) {
    console.log("\nAll git command router tests passed.");
    process.exit(0);
  } else {
    console.error(`\n${failures} git command router test(s) failed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Git command router test harness crashed:", error);
  process.exit(1);
});
