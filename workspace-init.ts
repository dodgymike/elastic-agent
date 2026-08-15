/**
 * System initialisation: resolve the working directory (pwd) and the canonical
 * path of the starting directory once at startup, and package them into a
 * structure that can be injected into CLAUDE.md (as trusted starting-directory
 * guidance) and provided to the tool classifier as allowed/trusted roots.
 *
 * Why this exists
 * ---------------
 * The agent operates relative to a repository root, and several subsystems need
 * to agree on what that root is:
 *   - CLAUDE.md generation wants to tell the model the canonical starting
 *     directory so relative paths can be prefixed with the right directory name.
 *   - The tool-safety classifier wants pwd/canonical path as trusted roots
 *     ("local" / allowed directories) so calls that legitimately stay within
 *     the workspace are not blocked.
 *
 * This module captures those values exactly once at start, before any agent
 * action that depends on file paths, so a later `process.chdir()` (e.g. into a
 * review worktree during execution) does not shift what the runtime treats as
 * the authoritative starting directory.
 *
 * Semantics
 * ---------
 * - `pwd` is the initial working directory, normalized to an absolute path via
 *   `path.resolve`.
 * - `canonicalPath` is the canonical (symlink-resolved) form of the same path
 *   via `fs.realpathSync`, falling back to the resolved `pwd` when realpath
 *   fails (for example a virtual/overlay filesystem, or a directory that has
 *   been removed since startup). Falling back keeps init from crashing while
 *   still producing a usable root.
 * - `allowedDirectories` is the de-duplicated set of `[pwd, canonicalPath]`;
 *   when the two are identical there is just one entry. This is the value to
 *   hand to the classifier so it treats both forms as trusted roots.
 * - `toMarkdown()` renders an idempotent CLAUDE.md section that states the
 *   starting directory and instructs the agent to prefix relative paths with
 *   the canonical directory name.
 *
 * The module is pure (no I/O beyond realpathSync) and dependency-free so it can
 * be unit tested in isolation and embedded into main.ts's startup.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve, relative, sep } from "node:path";

/** Stable snapshot of the resolver's starting-directory knowledge. */
export interface WorkspaceInit {
  /** Initial working directory, normalized to an absolute path. */
  readonly pwd: string;
  /** Symlink-resolved canonical path of the starting directory. */
  readonly canonicalPath: string;
  /** De-duplicated trusted roots: [pwd, canonicalPath] (1 or 2 entries). */
  readonly allowedDirectories: readonly string[];
  /** True when realpath failed and canonicalPath equals pwd. */
  readonly canonicalFallbackUsed: boolean;
  /** Idempotent CLAUDE.md section; see WorkspaceInitMarkdown below. */
  toMarkdown(): string;
}

/**
 * Serialized, JSON-safe form that can be persisted into configData so later
 * steps (and test harnesses) can reconstruct a WorkspaceInit without re-running
 * realpath. All fields are plain strings/booleans; the function-shaped
 * `toMarkdown` is rebuilt on load.
 */
export interface WorkspaceInitState {
  readonly pwd: string;
  readonly canonicalPath: string;
  readonly canonicalFallbackUsed: boolean;
}

/** Marker used by toMarkdown() so an injected section can be found/replaced. */
export const WORKSPACE_INIT_MARKER = "WORKSPACE-START-DIRECTORY";

/**
 * Resolve pwd + canonical path for `startingDir`. Defaults to process.cwd().
 * Never throws: realpath failures degrade to the resolved path so startup is
 * not blocked by an unresolvable directory.
 */
export function resolveWorkspaceInit(startingDir: string = process.cwd()): WorkspaceInit {
  const pwd = isAbsolute(startingDir) ? resolve(startingDir) : resolve(process.cwd(), startingDir);
  let canonicalPath = pwd;
  let canonicalFallbackUsed = false;
  try {
    canonicalPath = realpathSync(pwd);
  } catch {
    // Fall back to the resolved path; the directory may be a virtual/overlay
    // mount or may not exist yet at startup. Still produce a usable root.
    canonicalFallbackUsed = true;
  }
  const allowedDirectories = Array.from(new Set([pwd, canonicalPath]));
  return {
    pwd,
    canonicalPath,
    allowedDirectories,
    canonicalFallbackUsed,
    toMarkdown() {
      return workspaceInitMarkdown(pwd, canonicalPath);
    },
  };
}

/** Reconstruct a WorkspaceInit (including toMarkdown) from a stored state. */
export function loadWorkspaceInit(state: WorkspaceInitState | null | undefined): WorkspaceInit | null {
  if (!state || !state.pwd || !state.canonicalPath) return null;
  return {
    pwd: state.pwd,
    canonicalPath: state.canonicalPath,
    allowedDirectories: Array.from(new Set([state.pwd, state.canonicalPath])),
    canonicalFallbackUsed: state.canonicalFallbackUsed === true,
    toMarkdown() {
      return workspaceInitMarkdown(state.pwd, state.canonicalPath);
    },
  };
}

/** Serialize for persistence (e.g. into configData.workspaceInit). */
export function workspaceInitToState(init: WorkspaceInit): WorkspaceInitState {
  return {
    pwd: init.pwd,
    canonicalPath: init.canonicalPath,
    canonicalFallbackUsed: init.canonicalFallbackUsed,
  };
}

/**
 * Markdown block used to tell the model the canonical starting directory and to
 * prefix relative paths with that directory name. Kept as a pure string helper
 * (no object dependency) so it can be tested directly and reused by CLAUDE.md
 * generation in a later step.
 */
export function workspaceInitMarkdown(pwd: string, canonicalPath: string): string {
  const directoryName = canonicalPath.split(sep).filter((segment) => segment.length > 0).slice(-1)[0] ?? canonicalPath;
  return [
    "",
    `<!-- ${WORKSPACE_INIT_MARKER} (system-injected; do not remove) -->`,
    "",
    "# Starting directory",
    "",
    `The runtime started in the canonical directory \`${canonicalPath}\``,
    `(initial working directory \`${pwd}\`).`,
    "",
    `Prefix every relative path in your tool calls and reasoning with the `,
    `starting directory name \`${directoryName}/\` (for example \`${directoryName}/main.ts\`)`,
    `so file references are unambiguous and stay within the trusted workspace root.`,
    "",
  ].join("\n");
}
