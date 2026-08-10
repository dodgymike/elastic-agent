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

export interface ListGitChangesOptions {
  action: "list";
  /** Repository directory. Defaults to the current working directory. */
  cwd?: string;
}

export interface StageGitChangesOptions {
  action: "stage";
  /** Repository directory. Defaults to the current working directory. */
  cwd?: string;
  /** Paths, relative to `cwd`, to add to the index. */
  paths?: readonly string[];
  /** Explicitly stage all tracked and untracked changes, including deletions. */
  all?: boolean;
}

export interface CommitGitChangesOptions {
  action: "commit";
  /** Repository directory. Defaults to the current working directory. */
  cwd?: string;
  /** The commit message passed to `git commit -m`. */
  message: string;
}

export type GitOptions =
  | ListGitChangesOptions
  | StageGitChangesOptions
  | CommitGitChangesOptions;

/**
 * Lists working-tree changes, stages selected changes, or creates a commit.
 *
 * This tool invokes Git directly rather than through a shell. Consequently,
 * paths and commit messages are passed as literal arguments and cannot alter
 * the command being run. `stage` requires either one or more `paths`, or the
 * explicit `all: true` opt-in; it never stages the whole repository by
 * accident.
 *
 * `list` runs `git status --short --branch`, whose stdout is suitable for
 * displaying both staged and unstaged changes. `stage` runs either
 * `git add -- <paths...>` or `git add --all`; `commit` runs
 * `git commit -m <message>`.
 */
export default async function Git(options: GitOptions): Promise<GitCommandResult> {
  validateCwd(options.cwd);

  switch (options.action) {
    case "list":
      return runGit(["status", "--short", "--branch"], options.cwd);

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
