// End-to-end test for the worktree staging helpers (worktree.ts) used by the
// review-commit workflow in main.ts. Uses a REAL temporary git repository and
// the actual worktree.ts helpers to verify:
//   1. execution steps stage changes in a dedicated worktree and never commit;
//   2. the worktree is reused across review attempts so staged work accumulates;
//   3. the review step commits only when happy (commitInWorktree + merge);
//   4. a failing review leaves the work uncommitted;
//   5. cleanupWorktree removes the worktree and its branch.
// Compiled and executed standalone by the `test:worktree` npm script.
import {
    createWorktree, ensureWorktree, stageAllInWorktree, commitInWorktree,
    mergeWorktreeIntoMain, cleanupWorktree, listWorktrees, stagedChangesSummary,
    committedChangesSummary,
} from "../worktree.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

function runGit(cwd: string, args: readonly string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
    assert.strictEqual(result.status, 0, `git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
    return (result.stdout ?? "").trim();
}

function head(cwd: string): string { return runGit(cwd, ["rev-parse", "HEAD"]); }

// A tiny in-memory tracker for the git operations the runner performs, so the
// test can assert the execution phase staged but never committed.
const gitOps = {
    stagingCount: 0,
    commits: [] as string[],
};

// Simulated runExecutionPhase: stage changes in the worktree, never commit.
function executionPhaseStages(worktreePath: string): void {
    stageAllInWorktree(worktreePath);
    gitOps.stagingCount += 1;
}

// Simulated happy review: stage once more, commit in the worktree, and merge
// the worktree branch into the main branch (as main.ts does).
function reviewHappyCommits(worktreePath: string, branch: string, repoRoot: string, summary: string): void {
    stageAllInWorktree(worktreePath);
    gitOps.stagingCount += 1;
    const message = `review happy: ${summary}`;
    commitInWorktree(worktreePath, message);
    gitOps.commits.push(message);
    mergeWorktreeIntoMain(branch, repoRoot);
}

let repoRoot = "";
const cleanupPaths: string[] = [];
try {
    // 1. Create a temporary git repository with an initial commit.
    repoRoot = mkdtempSync(join(tmpdir(), "worktree-test-"));
    cleanupPaths.push(repoRoot);
    runGit(repoRoot, ["init", "-b", "main"]);
    runGit(repoRoot, ["config", "user.email", "test@example.com"]);
    runGit(repoRoot, ["config", "user.name", "Test Agent"]);
    writeFileSync(join(repoRoot, "README.md"), "# repo\n");
    runGit(repoRoot, ["add", "README.md"]);
    runGit(repoRoot, ["commit", "-m", "initial"]);

    const mainHeadBefore = head(repoRoot);

    // 2. Create the execution worktree.
    const branch = "review-worktree";
    const worktreePath = createWorktree(branch, repoRoot);
    assert.ok(existsSync(worktreePath), "worktree directory must exist");
    assert.strictEqual(listWorktrees(repoRoot).get(branch), worktreePath, "worktree listed under its branch");

    // 3. Execution phase: write a file inside the worktree and stage it.
    writeFileSync(join(worktreePath, "feature.txt"), "execution produced this\n");
    executionPhaseStages(worktreePath);

    //  3a. Staged, not committed: worktree has staged changes but no commit yet.
    const stagedInWorktree = runGit(worktreePath, ["diff", "--cached", "--name-only"]);
    assert.ok(stagedInWorktree.includes("feature.txt"), "execution changes must be staged in the worktree");
    //  3b. Main branch HEAD is unchanged (no commit reached main).
    assert.strictEqual(head(repoRoot), mainHeadBefore, "execution must not commit onto main");
    //  3c. Main working tree has no tracked execution work (isolated in the
    //      worktree). Only the untracked .worktrees/ staging dir appears.
    const mainStatus = runGit(repoRoot, ["status", "--porcelain"]);
    assert.ok(!mainStatus.includes("feature.txt") && !mainStatus.includes("fix.txt"),
        "main working tree must not contain execution work (isolated in the worktree)");
    assert.strictEqual(gitOps.commits.length, 0, "no commit may occur during execution");

    // 4. Failing review: no commit, worktree reused; staged work accumulates.
    //   Simulate a second execution phase that adds more staged work.
    writeFileSync(join(worktreePath, "fix.txt"), "more execution work\n");
    executionPhaseStages(worktreePath);
    const stagedAgain = runGit(worktreePath, ["diff", "--cached", "--name-only"]);
    assert.ok(stagedAgain.includes("feature.txt") && stagedAgain.includes("fix.txt"),
        "staged work must accumulate across review attempts in the same worktree");
    assert.ok(gitOps.commits.length === 0, "failing review must not commit");

    // 4a. stagedChangesSummary surfaces the staged work (the review's change
    //     context): it must list both staged files and include a diff patch so
    //     the reviewer has concrete change data to assess (fixes "no changes
    //     detected" reviews that previously saw only prose).
    const summary = stagedChangesSummary(worktreePath);
    assert.ok(summary.includes("feature.txt") && summary.includes("fix.txt"),
        "stagedChangesSummary must list the staged changed files");
    assert.ok(summary.includes("DIFF PATCH") && summary.includes("+execution produced this"),
        "stagedChangesSummary must include the staged diff patch content");

    // 4b. With nothing staged against HEAD, the summary reports no changes
    //     rather than throwing or injecting a blank block. Create a fresh
    //     worktree with no changes for this check.
    const emptyBranch = "empty-summary-branch";
    const emptyPath = createWorktree(emptyBranch, repoRoot);
    cleanupPaths.push(emptyPath);
    const emptySummary = stagedChangesSummary(emptyPath);
    assert.ok(/no staged changes/.test(emptySummary), "empty staged summary must report no staged changes");
    cleanupWorktree(emptyBranch, repoRoot);

    // 5. Happy review: commit in the worktree and merge into main.
    reviewHappyCommits(worktreePath, branch, repoRoot, "all criteria passed");

    //  5a. Exactly one commit, with the review-happy message.
    assert.strictEqual(gitOps.commits.length, 1, "happy review commits exactly once");
    assert.ok(gitOps.commits[0].startsWith("review happy:"), "review commit message marks happy review");
    //  5b. The commit exists in the worktree branch.
    const worktreeHead = head(worktreePath);
    assert.ok(!/^0+$/.test(worktreeHead), "worktree branch HEAD must be a real commit");
    //  5c. The main branch now contains the committed work.
    assert.strictEqual(head(repoRoot), worktreeHead, "main must point at the merged review commit");
    const mergedFiles = runGit(repoRoot, ["show", "--name-only", "--format=", "HEAD"]);
    assert.ok(mergedFiles.includes("feature.txt") && mergedFiles.includes("fix.txt"),
        "main must contain the committed execution work after merge");

    //  5d. committedChangesSummary surfaces committed work when the staged diff
    //      is empty (the review phase fallback so committed execution work is
    //      still visible in the review prompt).
    const committed = committedChangesSummary(worktreePath);
    assert.ok(committed.includes("feature.txt") && committed.includes("fix.txt"),
        "committedChangesSummary must include the committed changed files");
    assert.ok(committed.includes("PATCH"), "committedChangesSummary must include the committed patch");

    // 6. cleanupWorktree removes the worktree and its branch.
    cleanupWorktree(branch, repoRoot);
    assert.ok(!existsSync(worktreePath), "worktree directory must be removed by cleanup");
    const branches = runGit(repoRoot, ["branch", "--list", branch]);
    assert.strictEqual(branches, "", "worktree branch must be deleted by cleanup");
    const ensureAfter = ensureWorktree(branch, repoRoot); // re-creates a fresh worktree
    cleanupWorktree(branch, repoRoot);
    assert.ok(!existsSync(ensureAfter), "re-created worktree must also be cleaned up");

    // 7. commitInWorktree requires a non-empty message (guard throws before git).
    let threw = "";
    try { commitInWorktree(join(repoRoot, ".worktrees", "nonexistent"), "   "); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    assert.ok(threw.length > 0, "commitInWorktree must reject an empty/whitespace message");

    console.log("Worktree staging/commit fixtures passed.");
} finally {
    for (const p of cleanupPaths) {
        try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
}
