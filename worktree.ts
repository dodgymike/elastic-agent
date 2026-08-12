import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/**
 * Worktree staging helpers.
 *
 * The agent runtime uses a dedicated git worktree so that executing plan
 * steps never commit directly onto the main branch. File changes made by the
 * execution phase land inside the worktree and are staged with `git add --all`
 * but NOT committed there. Only the review step (see main.ts) is allowed to
 * commit, and only when the review result is happy. The worktree is kept alive
 * across review attempts so staged work accumulates and the review can inspect
 * the staged changes before deciding whether to commit.
 */

/** Directory (relative to the repository root) that holds the agent worktrees. */
export const WORKTREES_DIR = ".worktrees";

/** Worktree directory name for a given branch. */
export function worktreePathForBranch(branchName: string, repoRoot = process.cwd()): string {
  return resolve(repoRoot, join(WORKTREES_DIR, branchName));
}

/** Run git in a given working directory; returns stdout trimmed. Throws on failure. */
function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `git ${args.join(" ")} failed`;
    throw new Error(detail);
  }
  return (result.stdout ?? "").trim();
}

/** List existing worktrees as branch -> path pairs via `git worktree list --porcelain`. */
export function listWorktrees(repoRoot = process.cwd()): Map<string, string> {
  const map = new Map<string, string>();
  const output = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  let branch: string | null = null;
  let path = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch refs/heads/".length);
      if (branch && path) map.set(branch, path);
    }
  }
  return map;
}

/**
 * Create a new git branch and a dedicated worktree for it at
 * <.worktrees/<branchName>>. Throws if the branch or worktree already exists.
 */
export function createWorktree(branchName: string, repoRoot = process.cwd()): string {
  if (!branchName || /\s/.test(branchName)) {
    throw new Error(`Invalid worktree branch name: "${branchName}".`);
  }
  const worktree = worktreePathForBranch(branchName, repoRoot);
  runGit(repoRoot, ["worktree", "add", "-b", branchName, worktree]);
  return worktree;
}

/**
 * Return the path of the worktree for `branchName`, creating it (new branch)
 * the first time it is requested. The worktree is created once and reused
 * across execution/review attempts so staged changes accumulate. If a worktree
 * for the branch already exists, its existing path is returned.
 */
export function ensureWorktree(branchName: string, repoRoot = process.cwd()): string {
  const existing = listWorktrees(repoRoot).get(branchName);
  if (existing) return existing;
  return createWorktree(branchName, repoRoot);
}

/** Stage all changes (tracked, untracked, and deletions) inside the worktree. */
export function stageAllInWorktree(worktreePath: string): void {
  runGit(worktreePath, ["add", "--all"]);
}

/** Commit the staged changes inside the worktree with the given message. */
export function commitInWorktree(worktreePath: string, message: string): void {
  if (!message || typeof message !== "string") {
    throw new Error("commitInWorktree requires a non-empty commit message.");
  }
  runGit(worktreePath, ["commit", "-m", message]);
}

/**
 * Merge the worktree branch into another checkout (typically the main branch).
 * `branchName` is the branch that was created by createWorktree/ensureWorktree
 * for staging. The merge is run from `repoRoot` (the main checkout), bringing
 * the committed review work into the main branch. A fast-forward merge is
 * preferred when possible; otherwise a merge commit is created automatically.
 */
export function mergeWorktreeIntoMain(branchName: string, repoRoot = process.cwd()): void {
  runGit(repoRoot, ["merge", "--no-edit", branchName]);
}

/** Remove the worktree and delete its branch, cleaning up staged work. */
export function cleanupWorktree(branchName: string, repoRoot = process.cwd()): void {
  const worktree = worktreePathForBranch(branchName, repoRoot);
  // --force handles uncommitted/staged changes so cleanup always succeeds.
  runGit(repoRoot, ["worktree", "remove", "--force", worktree]);
  try {
    runGit(repoRoot, ["branch", "-D", branchName]);
  } catch {
    // The branch may already be gone; cleanup of the worktree is the key step.
  }
}
