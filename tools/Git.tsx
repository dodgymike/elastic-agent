import { spawn } from "node:child_process";

/** A command result returned by the Git tool. */
export interface GitCommandResult {
  /** Arguments passed to git, excluding the `git` executable itself. */
  command: string[];
  /** Git's exit status. A zero exit status indicates success. */
  exitCode: number;
  /** Text written by Git to standard output. */
  stdout: string;
  /** Text written by Git to standard error. */
  stderr: string;
}

/** Options shared by every Git tool call. */
interface GitBaseOptions {
  /** Repository directory. Defaults to the current working directory. */
  cwd?: string;
}

/** Read-only `status` mode. */
export interface GitStatusModeOptions extends GitBaseOptions {
  mode: "status";
  /**
   * Output format: `short` (`--short`), `porcelain` (`--porcelain=v1`), or
   * `branch` (`--branch`). When omitted, the stable `--porcelain=v1` format
   * with the branch header is used.
   */
  format?: "short" | "porcelain" | "branch";
  /** Append `--branch` when `format` is `short` or `porcelain`. */
  branch?: boolean;
  /** Optional repo-relative path filters. */
  paths?: readonly string[];
}

/** Read-only `log` mode. */
export interface GitLogModeOptions extends GitBaseOptions {
  mode: "log";
  /** Use `--oneline`; defaults to true. */
  oneline?: boolean;
  /** Append `--stat` to include a per-commit diffstat. */
  stat?: boolean;
  /** Limit the number of commits (`-N`). Must be a positive integer. */
  maxCount?: number;
  /** Include commits reachable from all refs (`--all`). */
  all?: boolean;
  /** Revision or range to log (for example `HEAD` or `main..HEAD`). */
  revision?: string;
  /** Convenience single path filter. */
  path?: string;
  /** Optional repo-relative path filters. */
  paths?: readonly string[];
}

/** Read-only `diff` mode. */
export interface GitDiffModeOptions extends GitBaseOptions {
  mode: "diff";
  /** Diff the index against HEAD (`--cached`). */
  staged?: boolean;
  /** Show only a diffstat (`--stat`). */
  stat?: boolean;
  /** Check for whitespace errors (`--check`). */
  check?: boolean;
  /**
   * Revision or range to diff. When omitted, diffs the unstaged worktree;
   * pass `HEAD` to compare the worktree against HEAD.
   */
  revision?: string;
  /** Optional repo-relative path filters. */
  paths?: readonly string[];
}

/** Read-only `ls-files` mode. */
export interface GitLsFilesModeOptions extends GitBaseOptions {
  mode: "ls-files";
  /** List untracked files (`--others`). */
  others?: boolean;
  /** Honor standard ignore rules (`--exclude-standard`); implied by `others`. */
  excludeStandard?: boolean;
  /** Optional repo-relative path filters. */
  paths?: readonly string[];
}

/** Legacy `list` action retained for backward compatibility. */
export interface ListGitChangesOptions extends GitBaseOptions {
  action: "list";
}

/** `stage` action: add selected paths (or everything) to the index. */
export interface StageGitChangesOptions extends GitBaseOptions {
  action: "stage";
  /** Paths, relative to `cwd`, to add to the index. */
  paths?: readonly string[];
  /** Explicitly stage all tracked and untracked changes, including deletions. */
  all?: boolean;
}

/** `commit` action: commit staged changes. */
export interface CommitGitChangesOptions extends GitBaseOptions {
  action: "commit";
  /** The commit message passed to `git commit -m`. */
  message: string;
}

export type GitOptions =
  | GitStatusModeOptions
  | GitLogModeOptions
  | GitDiffModeOptions
  | GitLsFilesModeOptions
  | ListGitChangesOptions
  | StageGitChangesOptions
  | CommitGitChangesOptions;

type GitModeOptions =
  | GitStatusModeOptions
  | GitLogModeOptions
  | GitDiffModeOptions
  | GitLsFilesModeOptions;

/**
 * Inspects a repository (status, log, diff, ls-files), stages selected
 * changes, or creates a commit.
 *
 * This tool invokes Git directly rather than through a shell. Consequently,
 * paths, revisions, and commit messages are passed as literal arguments and
 * cannot alter the command being run. The four read-only modes build their
 * arguments from explicit, validated options so the exact command is always
 * visible in the returned `command` array.
 *
 * `stage` requires either one or more `paths`, or the explicit `all: true`
 * opt-in; it never stages the whole repository by accident.
 */
export default async function Git(options: GitOptions): Promise<GitCommandResult> {
  validateOptionsObject(options);
  validateCwd(options.cwd);

  if (isModeOptions(options)) {
    switch (options.mode) {
      case "status":
        return runGit(buildStatusArgs(options), options.cwd);
      case "log":
        return runGit(buildLogArgs(options), options.cwd);
      case "diff":
        return runGit(buildDiffArgs(options), options.cwd);
      case "ls-files":
        return runGit(buildLsFilesArgs(options), options.cwd);
      default:
        throw new TypeError(
          `Unknown Git mode: ${String((options as { mode: unknown }).mode)}.`,
        );
    }
  }

  switch (options.action) {
    case "list":
      // Legacy alias for `mode: "status"` using the stable machine-readable
      // format. Kept so existing callers and tests continue to work.
      return runGit(["status", "--porcelain=v1", "--branch"], options.cwd);

    case "stage": {
      const paths = options.paths ?? [];
      if (options.all && paths.length > 0) {
        throw new TypeError("Specify either paths or all: true, not both.");
      }
      if (options.all) {
        return runGit(["add", "--all"], options.cwd);
      }
      if (paths.length === 0) {
        throw new TypeError("stage requires at least one path or all: true.");
      }

      for (const path of paths) {
        validatePath(path);
      }
      // `--` prevents a path such as "--intent-to-add" from being interpreted
      // as a Git option.
      return runGit(["add", "--", ...paths], options.cwd);
    }

    case "commit":
      if (typeof options.message !== "string" || options.message.trim() === "") {
        throw new TypeError("commit requires a non-empty message.");
      }
      return runGit(["commit", "-m", options.message], options.cwd);

    default:
      throw new TypeError(
        `Unknown Git action: ${String((options as { action: unknown }).action)}.`,
      );
  }
}

function isModeOptions(options: GitOptions): options is GitModeOptions {
  return "mode" in options;
}

function buildStatusArgs(options: GitStatusModeOptions): string[] {
  const args = ["status"];
  const format = options.format;

  if (format === "short") args.push("--short");
  else if (format === "porcelain") args.push("--porcelain=v1");
  else if (format === "branch") args.push("--branch");
  else if (format !== undefined) {
    throw new TypeError('format must be "short", "porcelain", or "branch".');
  } else {
    args.push("--porcelain=v1");
  }

  // Default to the stable machine-readable branch header for a bare
  // `mode: "status"`. An explicit format opts out unless `branch: true` is
  // also requested, which is only meaningful for short/porcelain.
  const includeBranch =
    format === "branch"
      ? false
      : options.branch === true ||
        (options.branch === undefined && format === undefined);
  if (includeBranch) args.push("--branch");

  appendPaths(args, collectPaths(undefined, options.paths));
  return args;
}

function buildLogArgs(options: GitLogModeOptions): string[] {
  const args = ["log"];

  if (options.oneline !== false) args.push("--oneline");
  if (options.stat) args.push("--stat");
  if (options.all) args.push("--all");
  if (options.maxCount !== undefined) {
    if (!Number.isInteger(options.maxCount) || options.maxCount <= 0) {
      throw new TypeError("maxCount must be a positive integer.");
    }
    args.push(`-${options.maxCount}`);
  }
  if (options.revision !== undefined) {
    validateNonEmptyString(options.revision, "revision");
    args.push(options.revision);
  }

  appendPaths(args, collectPaths(options.path, options.paths));
  return args;
}

function buildDiffArgs(options: GitDiffModeOptions): string[] {
  const args = ["diff"];

  if (options.staged) args.push("--cached");
  if (options.stat) args.push("--stat");
  if (options.check) args.push("--check");
  if (options.revision !== undefined) {
    validateNonEmptyString(options.revision, "revision");
    args.push(options.revision);
  }

  appendPaths(args, collectPaths(undefined, options.paths));
  return args;
}

function buildLsFilesArgs(options: GitLsFilesModeOptions): string[] {
  const args = ["ls-files"];

  if (options.others) args.push("--others");
  if (options.others || options.excludeStandard === true) {
    args.push("--exclude-standard");
  }

  appendPaths(args, collectPaths(undefined, options.paths));
  return args;
}

function validateOptionsObject(options: GitOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Git options must be an object.");
  }
}

function validateCwd(cwd: string | undefined): void {
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    throw new TypeError("cwd must be a non-empty string when provided.");
  }
}

function validatePath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("Each path must be a non-empty string.");
  }
  if (path.includes("\0")) {
    throw new TypeError("Paths cannot contain NUL characters.");
  }
}

function validateNonEmptyString(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string when provided.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${field} cannot contain NUL characters.`);
  }
}

/** Collect `path` plus `paths` into one validated, non-empty path list. */
function collectPaths(
  path: string | undefined,
  paths: readonly string[] | undefined,
): string[] {
  const result: string[] = [];
  if (path !== undefined) {
    validatePath(path);
    result.push(path);
  }
  if (paths !== undefined) {
    if (!Array.isArray(paths)) {
      throw new TypeError("paths must be an array of strings when provided.");
    }
    for (const item of paths) {
      if (typeof item !== "string") {
        throw new TypeError("Each path must be a string.");
      }
      validatePath(item);
    }
    result.push(...paths);
  }
  return result;
}

/** Append a `--` separator and literal paths when any are present. */
function appendPaths(args: string[], paths: readonly string[]): void {
  if (paths.length === 0) return;
  args.push("--", ...paths);
}

function runGit(command: string[], cwd?: string): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", command, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (exitCode === null) {
        reject(new Error(`git was terminated by signal ${signal ?? "unknown"}`));
        return;
      }
      resolve({ command, exitCode, stdout, stderr });
    });
  });
}
