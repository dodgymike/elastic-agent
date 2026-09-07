import { constants } from "node:fs";
import { chmod, copyFile, lstat, open, rename, symlink } from "node:fs/promises";

export type FileOpsAction = "copy" | "move" | "touch" | "chmod" | "symlink";

export interface FileOpsOptions {
  action: FileOpsAction;
  /** Source path for copy, move, and symlink (link target). */
  source?: string;
  /** Destination path for copy, move, and symlink (link path). */
  destination?: string;
  /** Target path for touch and chmod. */
  path?: string;
  /** Octal string (e.g. "755") or executable-bit symbolic mode (e.g. "+x"). */
  mode?: string;
}

export interface FileOpsResult {
  action: FileOpsAction;
  source?: string;
  destination?: string;
  path?: string;
  mode?: string;
}

const ACTIONS: readonly FileOpsAction[] = ["copy", "move", "touch", "chmod", "symlink"];
const OCTAL_MODE = /^[0-7]{3,4}$/;
const SYMBOLIC_MODE = /^([ugoa]*)([+-])x$/;

function validatePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${field} cannot contain NUL characters.`);
  }
  return value;
}

function requirePath(value: string | undefined, field: string, action: FileOpsAction): string {
  if (value === undefined) {
    throw new TypeError(`FileOps ${action} requires '${field}'.`);
  }
  return validatePath(value, field);
}

/** Reject destination symlinks so copy/move/touch never follow them. */
async function rejectSymlinkDestination(target: string, action: FileOpsAction): Promise<void> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`FileOps ${action} refuses symlink destination '${target}'.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Resolve a validated octal or executable-bit symbolic mode to a numeric mode. */
async function resolveMode(target: string, mode: string): Promise<number> {
  if (OCTAL_MODE.test(mode)) {
    return parseInt(mode, 8);
  }
  const symbolic = SYMBOLIC_MODE.exec(mode);
  if (!symbolic) {
    throw new TypeError("mode must be an octal string (e.g. '755') or an executable-bit symbolic mode (e.g. '+x', 'u+x', 'a-x').");
  }
  const [, who, op] = symbolic;
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) {
    throw new Error(`FileOps chmod refuses symlink target '${target}'.`);
  }
  const current = stats.mode & 0o777;
  const classes = who === "" || who === "a" ? ["u", "g", "o"] : who.split("");
  let delta = 0;
  for (const entry of classes) {
    if (entry === "u") delta |= 0o100;
    else if (entry === "g") delta |= 0o010;
    else if (entry === "o") delta |= 0o001;
  }
  return op === "+" ? current | delta : current & ~delta;
}

/**
 * Perform simple, validated file operations without a shell. Every path goes
 * through the same boundary and protected-path checks as Write/Delete (the
 * safety classifier enforces those), and mutating actions require
 * `--allow-agent-source-modifications` or a declared `--safe-dir`.
 */
export default async function FileOps(options: FileOpsOptions): Promise<FileOpsResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("FileOps options must be an object.");
  }
  const action = options.action;
  if (!ACTIONS.includes(action)) {
    throw new TypeError(`FileOps action must be one of: ${ACTIONS.join(", ")}.`);
  }

  if (action === "copy") {
    const source = requirePath(options.source, "source", action);
    const destination = requirePath(options.destination, "destination", action);
    await rejectSymlinkDestination(destination, action);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    return { action, source, destination };
  }

  if (action === "move") {
    const source = requirePath(options.source, "source", action);
    const destination = requirePath(options.destination, "destination", action);
    await rejectSymlinkDestination(destination, action);
    await rename(source, destination);
    return { action, source, destination };
  }

  if (action === "touch") {
    const path = requirePath(options.path, "path", action);
    await rejectSymlinkDestination(path, action);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW);
    await handle.close();
    return { action, path };
  }

  if (action === "chmod") {
    const path = requirePath(options.path, "path", action);
    const mode = requirePath(options.mode, "mode", action);
    const numericMode = await resolveMode(path, mode);
    await chmod(path, numericMode);
    return { action, path, mode };
  }

  // symlink
  const source = requirePath(options.source, "source", action);
  const destination = requirePath(options.destination, "destination", action);
  await symlink(source, destination);
  return { action, source, destination };
}
