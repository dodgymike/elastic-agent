// Unit tests for tools/Git.tsx: the dedicated Git tool that owns read-only
// repository inspection (status/log/diff/ls-files) plus the two mutating
// actions (stage/commit). Tests run against a real temp repository so the
// exact argument vector and real exit behavior are both verified.
// Compiled and executed standalone by the `test:git-tool` npm script.
import Git from "../tools/Git.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "git-tool-test-"));
const outsideDir = mkdtempSync(join(tmpdir(), "git-tool-outside-"));

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function throwsTypeError(name: string, call: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await call();
  } catch (error) {
    threw = error instanceof TypeError;
  }
  check(name, threw);
}

async function main(): Promise<void> {
  try {
    // ------------------------------------------------------------------
    // 0. Fixture: a real repository with one committed file.
    // ------------------------------------------------------------------
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    writeFileSync(join(dir, "tracked.txt"), "hello\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });

    // ------------------------------------------------------------------
    // 1. Read-only mode argument building.
    // ------------------------------------------------------------------
    const status = await Git({ mode: "status", cwd: dir });
    check(
      "status defaults to the stable porcelain+branch format",
      sameArgs(status.command, ["status", "--porcelain=v1", "--branch"]),
    );
    check("status succeeds inside a repository", status.exitCode === 0 && /^## /.test(status.stdout));

    const shortStatus = await Git({ mode: "status", cwd: dir, format: "short", branch: true });
    check(
      "status short+branch maps to --short --branch",
      sameArgs(shortStatus.command, ["status", "--short", "--branch"]),
    );

    const porcelainStatus = await Git({ mode: "status", cwd: dir, format: "porcelain" });
    check(
      "status porcelain maps to --porcelain=v1 without --branch",
      sameArgs(porcelainStatus.command, ["status", "--porcelain=v1"]),
    );

    const branchStatus = await Git({ mode: "status", cwd: dir, format: "branch" });
    check("status branch maps to --branch", sameArgs(branchStatus.command, ["status", "--branch"]));

    const scopedStatus = await Git({ mode: "status", cwd: dir, paths: ["tracked.txt"] });
    check(
      "status path filters use a -- separator",
      sameArgs(scopedStatus.command, ["status", "--porcelain=v1", "--branch", "--", "tracked.txt"]),
    );

    const optionShapedPath = await Git({ mode: "status", cwd: dir, paths: ["--intent-to-add"] });
    check(
      "status paths that look like options stay literal after --",
      sameArgs(
        optionShapedPath.command,
        ["status", "--porcelain=v1", "--branch", "--", "--intent-to-add"],
      ),
    );

    const log = await Git({ mode: "log", cwd: dir, maxCount: 5 });
    check("log defaults to oneline with maxCount mapped to -N", sameArgs(log.command, ["log", "--oneline", "-5"]));
    check("log returns the committed history", log.exitCode === 0 && /initial/.test(log.stdout));

    const fullLog = await Git({
      mode: "log",
      cwd: dir,
      maxCount: 3,
      stat: true,
      all: true,
      revision: "HEAD",
    });
    check(
      "log accepts stat, all, maxCount, and revision",
      sameArgs(fullLog.command, ["log", "--oneline", "--stat", "--all", "-3", "HEAD"]),
    );

    const pathLog = await Git({ mode: "log", cwd: dir, maxCount: 2, paths: ["tracked.txt"] });
    check(
      "log path filters use a -- separator",
      sameArgs(pathLog.command, ["log", "--oneline", "-2", "--", "tracked.txt"]),
    );

    const diff = await Git({ mode: "diff", cwd: dir });
    check("diff defaults to the unstaged worktree", sameArgs(diff.command, ["diff"]));
    check("diff succeeds inside a repository", diff.exitCode === 0);

    const fullDiff = await Git({
      mode: "diff",
      cwd: dir,
      staged: true,
      stat: true,
      check: true,
      revision: "HEAD",
    });
    check(
      "diff maps staged/stat/check/revision",
      sameArgs(fullDiff.command, ["diff", "--cached", "--stat", "--check", "HEAD"]),
    );

    const scopedDiff = await Git({ mode: "diff", cwd: dir, paths: ["tracked.txt"] });
    check(
      "diff path filters use a -- separator",
      sameArgs(scopedDiff.command, ["diff", "--", "tracked.txt"]),
    );

    const untrackedFiles = await Git({ mode: "ls-files", cwd: dir, others: true });
    check(
      "ls-files others implies --exclude-standard",
      sameArgs(untrackedFiles.command, ["ls-files", "--others", "--exclude-standard"]),
    );

    const trackedFiles = await Git({ mode: "ls-files", cwd: dir, paths: ["tracked.txt"] });
    check(
      "ls-files explicit paths use a -- separator",
      sameArgs(trackedFiles.command, ["ls-files", "--", "tracked.txt"]),
    );
    check("ls-files lists the tracked file", trackedFiles.exitCode === 0 && /tracked\.txt/.test(trackedFiles.stdout));

    // ------------------------------------------------------------------
    // 2. Legacy action alias and mutating actions.
    // ------------------------------------------------------------------
    const legacyList = await Git({ action: "list", cwd: dir });
    check(
      "legacy action:list stays an alias for the stable status mode",
      sameArgs(legacyList.command, ["status", "--porcelain=v1", "--branch"]),
    );

    writeFileSync(join(dir, "new.txt"), "new\n");
    const stage = await Git({ action: "stage", cwd: dir, paths: ["new.txt"] });
    check("stage maps to git add with literal paths", sameArgs(stage.command, ["add", "--", "new.txt"]));
    check("stage succeeds and stages the file", stage.exitCode === 0);
    const stagedStatus = await Git({ mode: "status", cwd: dir });
    check("staged file appears in status after stage", /new\.txt/.test(stagedStatus.stdout));

    const stageAll = await Git({ action: "stage", cwd: dir, all: true });
    check("stage all maps to git add --all", sameArgs(stageAll.command, ["add", "--all"]));
    check("stage all succeeds", stageAll.exitCode === 0);

    const commit = await Git({ action: "commit", cwd: dir, message: "Add new file" });
    check(
      "commit maps to git commit -m with the message",
      sameArgs(commit.command, ["commit", "-m", "Add new file"]),
    );
    check("commit succeeds", commit.exitCode === 0);
    const headLog = await Git({ mode: "log", cwd: dir, maxCount: 1 });
    check("commit appears in the recent history", /Add new file/.test(headLog.stdout));

    // ------------------------------------------------------------------
    // 3. Non-repository failure is returned, not thrown.
    // ------------------------------------------------------------------
    const outsideStatus = await Git({ mode: "status", cwd: outsideDir });
    check(
      "status outside a repository returns a non-zero exit code with stderr",
      outsideStatus.exitCode !== 0 && /not a git repository/i.test(outsideStatus.stderr),
    );

    // ------------------------------------------------------------------
    // 4. Validation errors are TypeErrors before any git process runs.
    // ------------------------------------------------------------------
    await throwsTypeError("null options are rejected", async () => Git(null as unknown as Parameters<typeof Git>[0]));
    await throwsTypeError("array options are rejected", async () => Git([] as unknown as Parameters<typeof Git>[0]));
    await throwsTypeError("non-string cwd is rejected", async () =>
      Git({ mode: "status", cwd: 123 as unknown as string }),
    );
    await throwsTypeError("empty cwd is rejected", async () => Git({ mode: "status", cwd: "" }));
    await throwsTypeError("unknown mode is rejected", async () =>
      Git({ mode: "rebase" as never, cwd: dir }),
    );
    await throwsTypeError("unknown action is rejected", async () =>
      Git({ action: "rebase" as never, cwd: dir }),
    );
    await throwsTypeError("invalid status format is rejected", async () =>
      Git({ mode: "status", cwd: dir, format: "json" as never }),
    );
    await throwsTypeError("non-integer maxCount is rejected", async () =>
      Git({ mode: "log", cwd: dir, maxCount: 1.5 }),
    );
    await throwsTypeError("zero maxCount is rejected", async () =>
      Git({ mode: "log", cwd: dir, maxCount: 0 }),
    );
    await throwsTypeError("negative maxCount is rejected", async () =>
      Git({ mode: "log", cwd: dir, maxCount: -1 }),
    );
    await throwsTypeError("empty revision is rejected", async () =>
      Git({ mode: "log", cwd: dir, revision: "" }),
    );
    await throwsTypeError("NUL in revision is rejected", async () =>
      Git({ mode: "diff", cwd: dir, revision: "\0" }),
    );
    await throwsTypeError("non-array paths is rejected", async () =>
      Git({ mode: "status", cwd: dir, paths: "tracked.txt" as never }),
    );
    await throwsTypeError("empty path is rejected", async () =>
      Git({ mode: "status", cwd: dir, paths: [""] }),
    );
    await throwsTypeError("NUL in path is rejected", async () =>
      Git({ mode: "status", cwd: dir, paths: ["\0"] }),
    );
    await throwsTypeError("stage with both paths and all is rejected", async () =>
      Git({ action: "stage", cwd: dir, paths: ["a.txt"], all: true }),
    );
    await throwsTypeError("stage with neither paths nor all is rejected", async () =>
      Git({ action: "stage", cwd: dir }),
    );
    await throwsTypeError("commit with an empty message is rejected", async () =>
      Git({ action: "commit", cwd: dir, message: "" }),
    );
    await throwsTypeError("commit with a whitespace-only message is rejected", async () =>
      Git({ action: "commit", cwd: dir, message: "   " }),
    );
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      rmSync(outsideDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (failures === 0) {
    console.log("\nAll Git tool tests passed.");
    process.exit(0);
  } else {
    console.error(`\n${failures} Git tool test(s) failed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Git tool test harness crashed:", error);
  process.exit(1);
});
