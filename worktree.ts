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

/**
 * Build a human-readable summary of the staged changes in the worktree that are
 * not yet committed, i.e. the execution work the review step must assess.
 *
 * The summary lists the changed files (via `git diff --cached --stat`) and then
 * the actual patch (via `git diff --cached`) so a reviewer can see concretely
 * what changed rather than only prose about steps that were executed. The patch
 * is truncated to a generous cap to keep very large diffs from blowing up the
 * review prompt; the file/stat block always reflects the full change set.
 *
 * Returns a ready-to-embed string. When there is nothing staged against HEAD,
 * returns a short "(no staged changes)" marker so callers never inject a blank
 * or misleading block.
 */
export function stagedChangesSummary(worktreePath: string, maxPatchChars = 60000): string {
  const names = runGit(worktreePath, ["diff", "--cached", "--name-only"]);
  const stat = runGit(worktreePath, ["diff", "--cached", "--stat"]);
  const patch = runGit(worktreePath, ["diff", "--cached"]);
  const nameLines = names.length > 0 ? names.split("\n").map((n) => `  - ${n}`).join("\n") : "(none)";
  let statBlock = stat.length > 0 ? stat : "(no staged changes)";
  if (patch.length === 0) {
    return `CHANGED FILES (staged vs HEAD):\n${nameLines}\n\nDIFF:\n(no staged changes against HEAD)`;
  }
  const truncatedPatch = patch.length > maxPatchChars ? `${patch.slice(0, maxPatchChars)}\n…(diff truncated: ${patch.length} chars total)` : patch;
  return `CHANGED FILES (staged vs HEAD):\n${nameLines}\n\nDIFF STAT:\n${statBlock}\n\nDIFF PATCH:\n${truncatedPatch}`;
}

/**
 * Build a human-readable summary of committed work on the worktree branch for
 * the review phase's fallback when `git diff --cached` is empty (for example a
 * previous run already committed the execution work, so there is nothing
 * staged). The summary includes the latest commit hash + subject, a file stat,
 * and the commit patch so a reviewer still sees concrete changes instead of a
 * blank "(no staged changes)" block. The patch is truncated to the same
 * generous cap used by stagedChangesSummary.
 */
export function committedChangesSummary(worktreePath: string, maxPatchChars = 60000): string {
  const commit = runGit(worktreePath, ["show", "-s", "--format=%H %s", "HEAD"]);
  const stat = runGit(worktreePath, ["show", "--stat", "--format=", "HEAD"]);
  const patch = runGit(worktreePath, ["show", "--format=", "HEAD"]);
  if (!commit) return "(no committed changes available)";
  const truncatedPatch = patch.length > maxPatchChars ? `${patch.slice(0, maxPatchChars)}\n…(diff truncated: ${patch.length} chars total)` : patch;
  return `COMMITTED WORK (latest commit on the worktree branch, since nothing is staged):\n  - ${commit}\n\nSTAT:\n${stat || "(no stat available)"}\n\nPATCH:\n${truncatedPatch || "(no patch available)"}`;
}

/**
 * Return the latest commit hash and subject for a checkout, for attaching to a
 * task-mode proof as commit evidence. This is intentionally best-effort: it
 * returns a clear "(no commit evidence available)" marker instead of throwing
 * when the checkout has no commits or git cannot be run.
 */
export function latestCommitEvidence(repoRoot = process.cwd()): string {
  const result = spawnSync("git", ["log", "-1", "--format=%H %s"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (result.status !== 0) return "(no commit evidence available)";
  return (result.stdout ?? "").trim() || "(no commit evidence available)";
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
