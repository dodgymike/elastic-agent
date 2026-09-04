import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WORKTREES_DIR } from "../worktree.js";

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

/** Failure categories for a git process that did not complete normally. */
export type GitProcessErrorKind =
  | "spawn"
  | "stream"
  | "timeout"
  | "signal"
  | "output_overflow";

/**
 * Structured error for an abnormal git invocation: startup failure, stream
 * failure, timeout, signal termination, or output-limit overflow. A normal git
 * exit — including a nonzero `exitCode` — is never represented by this error;
 * those are returned as `GitCommandResult`, per ERROR_HANDLING.md. The
 * lower-level cause is preserved when available, and any captured stdout/stderr
 * is attached only when it is safe to keep (it is bounded by the stream limit).
 */
export class GitProcessError extends Error {
  readonly kind: GitProcessErrorKind;
  readonly command: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;

  constructor(
    kind: GitProcessErrorKind,
    command: readonly string[],
    message: string,
    options: { cause?: unknown; stdout?: string; stderr?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitProcessError";
    this.kind = kind;
    this.command = [...command];
    if (options.stdout !== undefined) this.stdout = options.stdout;
    if (options.stderr !== undefined) this.stderr = options.stderr;
  }
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

/**
 * `worktree` mode: inspect or manage linked worktrees through a strict
 * per-subcommand parameter allow-list. Only `list` is read-only; `add`,
 * `remove`, `move`, and `prune` are mutating and validated before any git
 * process runs.
 */
export interface GitWorktreeModeOptions extends GitBaseOptions {
  mode: "worktree";
  /** Worktree subcommand to run. Required when mode is "worktree". */
  subcommand: "list" | "add" | "remove" | "move" | "prune";
  /** `list`: append `--porcelain`. */
  porcelain?: boolean;
  /** `add` / `remove`: the worktree path. Required for add and remove. */
  path?: string;
  /** `add`: create a new branch with `-b <newBranch>`. */
  newBranch?: string;
  /** `add`: detach HEAD with `--detach`. */
  detach?: boolean;
  /** `add`: optional `<commit-ish>` positional to check out. */
  commitish?: string;
  /** `remove`: append `--force`. */
  force?: boolean;
  /** `move`: source worktree path. Required for move. */
  oldPath?: string;
  /** `move`: destination worktree path. Required for move. */
  newPath?: string;
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
  | GitWorktreeModeOptions
  | ListGitChangesOptions
  | StageGitChangesOptions
  | CommitGitChangesOptions;

type GitModeOptions =
  | GitStatusModeOptions
  | GitLogModeOptions
  | GitDiffModeOptions
  | GitLsFilesModeOptions
  | GitWorktreeModeOptions;

/**
 * Inspects a repository (status, log, diff, ls-files), manages linked
 * worktrees (list, add, remove, move, prune), stages selected changes, or
 * creates a commit.
 *
 * This tool invokes Git directly rather than through a shell. Consequently,
 * paths, revisions, and commit messages are passed as literal arguments and
 * cannot alter the command being run. The read-only modes build their
 * arguments from explicit, validated options so the exact command is always
 * visible in the returned `command` array. The `worktree` mode additionally
 * enforces a strict per-subcommand parameter allow-list and requires every
 * mutating worktree path to stay inside the workspace (and, for `add`, inside
 * the managed `.worktrees` root) before any git process runs.
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
      case "worktree":
        return runGit(buildWorktreeArgs(options), options.cwd);
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

const WORKTREE_SUBCOMMANDS = ["list", "add", "remove", "move", "prune"] as const;

type WorktreeSubcommand = (typeof WORKTREE_SUBCOMMANDS)[number];

/** Failure categories for invalid `mode: "worktree"` calls. */
export type GitWorktreeErrorKind =
  | "unknown_subcommand"
  | "unexpected_option"
  | "invalid_option_type"
  | "missing_required_field"
  | "invalid_path"
  | "path_traversal"
  | "path_option_like"
  | "protected_path"
  | "out_of_workspace"
  | "outside_worktrees_root"
  | "invalid_branch_name"
  | "invalid_commitish";

/**
 * Structured `TypeError` for invalid `mode: "worktree"` calls. Validation
 * failures are rejected synchronously at the tool boundary before any git
 * process runs, per ERROR_HANDLING.md. `kind` identifies the failure category
 * and `subcommand` identifies the worktree subcommand when one is known.
 */
export class GitWorktreeError extends TypeError {
  readonly kind: GitWorktreeErrorKind;
  readonly subcommand: WorktreeSubcommand | null;

  constructor(kind: GitWorktreeErrorKind, subcommand: WorktreeSubcommand | null, message: string) {
    super(message);
    this.name = "GitWorktreeError";
    this.kind = kind;
    this.subcommand = subcommand;
  }
}

/** Build a worktree validation error with a stable `Git worktree <subcommand>` prefix. */
function worktreeError(
  kind: GitWorktreeErrorKind,
  subcommand: WorktreeSubcommand | null,
  detail: string,
): GitWorktreeError {
  const operation = subcommand === null ? "Git worktree" : `Git worktree ${subcommand}`;
  return new GitWorktreeError(kind, subcommand, `${operation}: ${detail}.`);
}

/** Own enumerable option keys allowed for each worktree subcommand. */
const WORKTREE_PARAMETER_KEYS: Record<WorktreeSubcommand, readonly string[]> = {
  list: ["mode", "subcommand", "cwd", "porcelain"],
  add: ["mode", "subcommand", "cwd", "path", "newBranch", "detach", "commitish"],
  remove: ["mode", "subcommand", "cwd", "path", "force"],
  move: ["mode", "subcommand", "cwd", "oldPath", "newPath"],
  prune: ["mode", "subcommand", "cwd"],
};

/**
 * Protected basenames/stem mirrored from tool-safety-classifier.ts so the
 * worktree path policy rejects the same secret and credential files at the
 * tool boundary before any git process runs.
 */
const DATA_JSON_BASENAME = /^data\.json$/i;

const PROTECTED_WORKTREE_BASENAMES: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /^\.env(?:\..+)?$/i, label: "environment file" },
  { pattern: /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i, label: "SSH private key" },
  { pattern: /\.(pem|key|p12|pfx)$/i, label: "private key or certificate store" },
  { pattern: /^\.(netrc|npmrc|pypirc|git-credentials|htpasswd)$/i, label: "credential store" },
];

const PROTECTED_WORKTREE_STEM_PATTERN = /(^|[-_.])(token|tokens|api[_-]?key|apikey|password|passwd|secret|secrets|credential|credentials)$/i;

function buildWorktreeArgs(options: GitWorktreeModeOptions): string[] {
  const subcommand = validateWorktreeSubcommand(options.subcommand);
  validateWorktreeParameterKeys(subcommand, options);

  const args = ["worktree", subcommand];
  switch (subcommand) {
    case "list": {
      if (options.porcelain !== undefined && typeof options.porcelain !== "boolean") {
        throw worktreeError("invalid_option_type", subcommand, "porcelain must be a boolean when provided");
      }
      if (options.porcelain === true) args.push("--porcelain");
      return args;
    }

    case "add": {
      const path = requireWorktreeString(options.path, "path", subcommand);
      if (options.newBranch !== undefined && typeof options.newBranch !== "string") {
        throw worktreeError("invalid_option_type", subcommand, "newBranch must be a string when provided");
      }
      if (options.detach !== undefined && typeof options.detach !== "boolean") {
        throw worktreeError("invalid_option_type", subcommand, "detach must be a boolean when provided");
      }
      if (options.commitish !== undefined && typeof options.commitish !== "string") {
        throw worktreeError("invalid_option_type", subcommand, "commitish must be a string when provided");
      }

      validateWorktreePath(path, options.cwd, true, subcommand);
      if (options.newBranch !== undefined) validateWorktreeBranchName(options.newBranch, subcommand);
      if (options.commitish !== undefined) validateWorktreeCommitish(options.commitish, subcommand);

      if (options.detach === true) args.push("--detach");
      if (options.newBranch !== undefined) args.push("-b", options.newBranch);
      args.push(path);
      if (options.commitish !== undefined) args.push(options.commitish);
      return args;
    }

    case "remove": {
      const path = requireWorktreeString(options.path, "path", subcommand);
      if (options.force !== undefined && typeof options.force !== "boolean") {
        throw worktreeError("invalid_option_type", subcommand, "force must be a boolean when provided");
      }

      validateWorktreePath(path, options.cwd, false, subcommand);

      if (options.force === true) args.push("--force");
      args.push(path);
      return args;
    }

    case "move": {
      const oldPath = requireWorktreeString(options.oldPath, "oldPath", subcommand);
      const newPath = requireWorktreeString(options.newPath, "newPath", subcommand);

      validateWorktreePath(oldPath, options.cwd, false, subcommand);
      validateWorktreePath(newPath, options.cwd, false, subcommand);

      args.push(oldPath, newPath);
      return args;
    }

    case "prune":
      return args;
  }
}

function validateWorktreeSubcommand(value: unknown): WorktreeSubcommand {
  if (typeof value === "string" && (WORKTREE_SUBCOMMANDS as readonly string[]).includes(value)) {
    return value as WorktreeSubcommand;
  }
  throw worktreeError(
    "unknown_subcommand",
    null,
    `unknown subcommand '${String(value)}'; expected one of: ${WORKTREE_SUBCOMMANDS.join(", ")}`,
  );
}

function validateWorktreeParameterKeys(subcommand: WorktreeSubcommand, options: GitWorktreeModeOptions): void {
  const allowed = new Set<string>(WORKTREE_PARAMETER_KEYS[subcommand]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw worktreeError(
        "unexpected_option",
        subcommand,
        `unexpected option '${key}'; allowed options: ${WORKTREE_PARAMETER_KEYS[subcommand].join(", ")}`,
      );
    }
  }
}

function requireWorktreeString(value: string | undefined, field: string, subcommand: WorktreeSubcommand): string {
  if (typeof value !== "string" || value.length === 0) {
    throw worktreeError("missing_required_field", subcommand, `${field} must be a non-empty string`);
  }
  return value;
}

function validateWorktreePath(
  value: string,
  cwd: string | undefined,
  requireUnderWorktreesRoot: boolean,
  subcommand: WorktreeSubcommand,
): void {
  if (typeof value !== "string" || value.length === 0) {
    throw worktreeError("invalid_path", subcommand, "worktree path must be a non-empty string");
  }
  if (value.includes("\0")) {
    throw worktreeError("invalid_path", subcommand, "worktree path cannot contain NUL characters");
  }

  if (normalizedPathSegments(value).includes("..")) {
    throw worktreeError("path_traversal", subcommand, `worktree path '${value}' must not contain '..' path traversal`);
  }
  if (value.startsWith("-")) {
    throw worktreeError("path_option_like", subcommand, `worktree path '${value}' must not start with '-'`);
  }

  const protectedReason = worktreeProtectedPathReason(value);
  if (protectedReason) throw worktreeError("protected_path", subcommand, protectedReason);

  const base = cwd !== undefined ? cwd : process.cwd();
  const canonicalBase = canonicalWorktreePath(base);
  if (!isWithinWorktreeRoot(value, base, canonicalBase)) {
    throw worktreeError("out_of_workspace", subcommand, `worktree path '${value}' resolves outside the workspace root '${base}'`);
  }
  if (requireUnderWorktreesRoot) {
    const worktreesRoot = resolve(canonicalBase, WORKTREES_DIR);
    if (!isWithinWorktreeRoot(value, base, worktreesRoot)) {
      throw worktreeError(
        "outside_worktrees_root",
        subcommand,
        `worktree add path '${value}' must be inside the managed worktrees root '${WORKTREES_DIR}'`,
      );
    }
  }
}

function validateWorktreeBranchName(value: string, subcommand: WorktreeSubcommand): void {
  if (/[\u0000-\u0020\u007f]/.test(value)) {
    throw worktreeError("invalid_branch_name", subcommand, "newBranch must not contain whitespace or control characters");
  }
  if (value.startsWith("-")) {
    throw worktreeError("invalid_branch_name", subcommand, "newBranch must not start with '-'");
  }
  if (
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("\\") ||
    value.includes("~") ||
    value.includes("^") ||
    value.includes(":") ||
    value.includes("?") ||
    value.includes("*") ||
    value.includes("[")
  ) {
    throw worktreeError(
      "invalid_branch_name",
      subcommand,
      "newBranch must not contain any of: '..', '@{', '\\', '~', '^', ':', '?', '*', '['",
    );
  }
  if (value.startsWith("/") || value.endsWith("/")) {
    throw worktreeError("invalid_branch_name", subcommand, "newBranch must not start or end with '/'");
  }
}

function validateWorktreeCommitish(value: string, subcommand: WorktreeSubcommand): void {
  if (typeof value !== "string" || value.length === 0) {
    throw worktreeError("invalid_commitish", subcommand, "commitish must be a non-empty string when provided");
  }
  if (value.includes("\0")) {
    throw worktreeError("invalid_commitish", subcommand, "commitish cannot contain NUL characters");
  }
  if (value.startsWith("-")) {
    throw worktreeError("invalid_commitish", subcommand, "commitish must not start with '-'");
  }
}

function normalizedPathSegments(target: string): string[] {
  return target.replace(/\\/g, "/").split("/");
}

function worktreeBaseNameOf(target: string): string {
  const segments = normalizedPathSegments(target).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

function worktreeStemOf(base: string): string {
  return base.replace(/\.[^./]+$/, "");
}

function worktreeProtectedPathReason(value: string): string | null {
  const base = worktreeBaseNameOf(value);
  if (DATA_JSON_BASENAME.test(base)) {
    return `worktree path '${value}' targets the protected file data.json; data.json is never a valid worktree target`;
  }
  if (!base) return null;
  for (const entry of PROTECTED_WORKTREE_BASENAMES) {
    if (entry.pattern.test(base)) {
      return `worktree path '${value}' targets protected ${entry.label} '${base}'`;
    }
  }
  if (PROTECTED_WORKTREE_STEM_PATTERN.test(worktreeStemOf(base))) {
    return `worktree path '${value}' targets protected credential or secret file '${base}'`;
  }
  return null;
}

/** Canonical absolute path with a fail-closed fallback for not-yet-created paths. */
function canonicalWorktreePath(target: string, base = process.cwd()): string {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(base, target);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isWithinWorktreeRoot(value: string, base: string, root: string): boolean {
  const candidate = isAbsolute(value) ? resolve(value) : resolve(base, value);
  const canonicalCandidate = canonicalWorktreePath(candidate);
  const canonicalRoot = canonicalWorktreePath(root);
  const rel = relative(canonicalRoot, canonicalCandidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
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

/** Default process timeout for a git invocation, per ERROR_HANDLING.md §6. */
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/**
 * Per-stream capture limit for git stdout/stderr. Exceeding it is an abnormal
 * execution that rejects with a structured `GitProcessError` of kind
 * `output_overflow`, per ERROR_HANDLING.md §6, instead of accumulating
 * unbounded output in memory.
 */
const MAX_GIT_STREAM_BYTES = 1_048_576;

function runGit(command: string[], cwd?: string): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", command, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let timedOut = false;
    let settled = false;

    const fail = (
      kind: GitProcessErrorKind,
      message: string,
      cause?: unknown,
      capturedStdout?: string,
      capturedStderr?: string,
    ): void => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new GitProcessError(kind, command, message, { cause, stdout: capturedStdout, stderr: capturedStderr }));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, DEFAULT_GIT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes + chunkBytes > MAX_GIT_STREAM_BYTES) {
        outputOverflow = true;
      } else {
        stdout += chunk;
        stdoutBytes += chunkBytes;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (stderrBytes + chunkBytes > MAX_GIT_STREAM_BYTES) {
        outputOverflow = true;
      } else {
        stderr += chunk;
        stderrBytes += chunkBytes;
      }
    });

    child.stdout.on("error", (error) => {
      fail("stream", "git stdout stream failed.", error);
    });
    child.stderr.on("error", (error) => {
      fail("stream", "git stderr stream failed.", error);
    });
    child.once("error", (error) => {
      fail("spawn", "git could not be started.", error);
    });

    child.once("close", (exitCode, signal) => {
      if (outputOverflow) {
        fail(
          "output_overflow",
          `git output exceeded the ${MAX_GIT_STREAM_BYTES}-byte per-stream limit.`,
          undefined,
          stdout,
          stderr,
        );
        return;
      }
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) {
        reject(new GitProcessError(
          "timeout",
          command,
          `git timed out after ${DEFAULT_GIT_TIMEOUT_MS / 1000} seconds.`,
          { stdout, stderr },
        ));
        return;
      }
      if (exitCode === null) {
        reject(new GitProcessError(
          "signal",
          command,
          `git was terminated by signal ${signal ?? "unknown"}`,
          { stdout, stderr },
        ));
        return;
      }
      resolve({ command, exitCode, stdout, stderr });
    });
  });
}

/**
 * The input schema the Git tool advertises to the model. This is the single
 * source of truth that main.ts wires into the native tool definition and that
 * the schema-vs-handler consistency test checks against the modes/actions the
 * handler actually branches on. Keeping the schema next to the handler means
 * the advertised parameters cannot drift from implementation. The `action`
 * enum intentionally includes the legacy `list` alias retained for backward
 * compatibility (see `ListGitChangesOptions` and the `action === "list"`
 * handler branch).
 */
export const GitParameters: Record<string, unknown> = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["status", "log", "diff", "ls-files", "worktree"] },
    action: { type: "string", enum: ["list", "stage", "commit"] },
    subcommand: { type: "string", enum: ["list", "add", "remove", "move", "prune"] },
    cwd: { type: "string" },
    format: { type: "string", enum: ["short", "porcelain", "branch"] },
    branch: { type: "boolean" },
    oneline: { type: "boolean" },
    stat: { type: "boolean" },
    maxCount: { type: "integer" },
    all: { type: "boolean" },
    revision: { type: "string" },
    path: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    staged: { type: "boolean" },
    check: { type: "boolean" },
    others: { type: "boolean" },
    excludeStandard: { type: "boolean" },
    porcelain: { type: "boolean" },
    newBranch: { type: "string" },
    detach: { type: "boolean" },
    commitish: { type: "string" },
    force: { type: "boolean" },
    oldPath: { type: "string" },
    newPath: { type: "string" },
    message: { type: "string" },
  },
  anyOf: [{ required: ["mode"] }, { required: ["action"] }],
};
