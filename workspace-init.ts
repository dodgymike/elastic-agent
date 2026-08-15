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
 * The resolution helpers are pure (no I/O beyond realpathSync) and
 * dependency-free so they can be unit tested in isolation and embedded into
 * main.ts's startup. The markdown-injection helpers that write the generated
 * section into a CLAUDE.md file live in `injectWorkspaceInitMarkdown` /
 * `writeWorkspaceInitMarkdown` and perform explicit, idempotent file I/O only
 * when the caller asks for it.
 */

import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

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

/** Result of injecting the starting-directory section into CLAUDE.md content. */
export interface InjectWorkspaceInitResult {
  /** The complete updated content (identical to the input when unchanged). */
  readonly content: string;
  /** True when the file content actually changed (section added or replaced). */
  readonly changed: boolean;
  /** True when an existing injected section was replaced rather than appended. */
  readonly replaced: boolean;
}

/**
 * Idempotently inject the starting-directory markdown block into an existing
 * CLAUDE.md document.
 *
 * - When no section carrying WORKSPACE_INIT_MARKER is present, the block is
 *   appended at the end of the document (preserving a trailing newline so the
 *   block is cleanly separated from the rest of the content).
 * - When a section carrying the marker already exists, the old block is
 *   replaced in place, keeping any content that followed it intact. If the
 *   existing block already matches the newly generated one, nothing changes
 *   (idempotent).
 *
 * Existing CLAUDE.md content is otherwise never modified, so other sections
 * and any prior user-authored content are preserved.
 */
export function injectWorkspaceInitMarkdown(claudeContent: string, init: WorkspaceInit): InjectWorkspaceInitResult {
  const block = init.toMarkdown();
  const marker = `<!-- ${WORKSPACE_INIT_MARKER}`;
  const markerIndex = claudeContent.indexOf(marker);
  if (markerIndex === -1) {
    // No section yet: append at the end, ensuring a single separating newline.
    let content = claudeContent;
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    content += block;
    return { content, changed: true, replaced: false };
  }
  // An injected section exists. The section is delimited by its own marker
  // comment at the start and runs to the start of the next `# ` heading that
  // follows the block's own "Starting directory" heading (or EOF when the
  // section is the last one). Replacing just that region keeps any content
  // before the marker and after a following heading intact. The `before`
  // slice already includes the separator newline that precedes the marker
  // (the block's own leading blank line), so the new block is appended here
  // without its leading newline to avoid doubling the separator on re-inject.
  const blockHeading = "\n# Starting directory";
  const blockHeadingAt = claudeContent.indexOf(blockHeading, markerIndex);
  let sectionEnd = claudeContent.length;
  if (blockHeadingAt !== -1) {
    const nextHeadingAt = claudeContent.indexOf("\n# ", blockHeadingAt + blockHeading.length);
    if (nextHeadingAt !== -1) sectionEnd = nextHeadingAt + 1; // keep the leading "\n"
  }
  const before = claudeContent.slice(0, markerIndex);
  const after = claudeContent.slice(sectionEnd);
  const blockWithoutLeadingNewline = block.startsWith("\n") ? block.slice(1) : block;
  const content = before + blockWithoutLeadingNewline + after;
  return { content, changed: content !== claudeContent, replaced: true };
}

/**
 * Read `filePath`, inject the starting-directory markdown block (see
 * `injectWorkspaceInitMarkdown`), and write the file back only when the content
 * actually changed. The file is written directly (no atomic rename) because the
 * target is the repo-root CLAUDE.md that is written once at startup; callers
 * that need atomic updates can use `injectWorkspaceInitMarkdown` directly.
 */
export function writeWorkspaceInitMarkdown(filePath: string, init: WorkspaceInit): InjectWorkspaceInitResult {
  const existing = readFileSync(filePath, "utf-8");
  const result = injectWorkspaceInitMarkdown(existing, init);
  if (result.changed) writeFileSync(filePath, result.content, "utf-8");
  return result;
}
