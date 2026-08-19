/**
 * Agent-source root determination for `--allow-agent-source-modifications`.
 *
 * When the agent is allowed to modify its own source, the authoritative
 * modification root is the directory containing the agent's `main.ts` entry
 * file, not an arbitrary working directory. This module owns the single,
 * dependency-free resolution of that root plus the check that the process's
 * working directory actually lives there, so the CLI can enforce the invariant
 * at startup with a clear error and the agent can `chdir()` to the canonical
 * root before handling any tool calls.
 *
 * The runtime working directory must resolve (canonically, i.e. symlink-resolved)
 * to that same root: `--allow-agent-source-modifications` lets the agent rewrite
 * its own source, so running from anywhere else would be ambiguous and unsafe.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

/**
 * Error thrown when `--allow-agent-source-modifications` is set but the runtime
 * working directory does not resolve to the agent-source root (the directory
 * containing the main entry module). The message is the clear diagnostic
 * rendered to the user at startup.
 */
export class AgentSourceRootMismatchError extends Error {
    constructor(root: string, runtimeCwd: string) {
        super(
            `Usage: --allow-agent-source-modifications requires the working directory to be the agent source root '${root}', but the current working directory '${runtimeCwd}' does not resolve to it. Refusing to start.`,
        );
        this.name = "AgentSourceRootMismatchError";
    }
}

/** Result of resolving the agent-source root and verifying the working directory. */
export interface AgentSourceRootResolution {
    /** Canonical (symlink-resolved) absolute directory containing the main entry module. */
    readonly root: string;
    /** True when the runtime working directory resolves (canonically) to `root`. */
    readonly cwdMatchesRoot: boolean;
}

/**
 * Find the directory containing the agent's `main.ts` entry file, starting from
 * the directory of the running main entry module and walking upward to the
 * filesystem root. This handles both running the TypeScript source directly
 * (`main.ts`) and running the compiled entry (`dist/main.js`): in both cases the
 * agent-source root is the directory where `main.ts` lives.
 *
 * `mainPath` is resolved to an absolute path (relative values resolve against
 * `runtimeCwd`). When no ancestor contains `main.ts`, the directory of the
 * entry module itself is returned as a safe fallback so callers still get a
 * usable, non-empty root.
 */
export function findAgentSourceRoot(mainPath: string, runtimeCwd: string = process.cwd()): string {
    const base = isAbsolute(mainPath) ? resolve(mainPath) : resolve(runtimeCwd, mainPath);
    const filesystemRoot = parse(base).root;
    let dir = dirname(base);
    const seen = new Set<string>();
    while (dir && dir !== filesystemRoot && !seen.has(dir)) {
        seen.add(dir);
        if (existsSync(join(dir, "main.ts"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Also check the filesystem root itself before giving up.
    if (existsSync(join(filesystemRoot, "main.ts"))) return filesystemRoot;
    return dirname(base);
}

/**
 * Resolve the canonical agent-source root from the absolute path of the main
 * entry module and compare it against the runtime working directory.
 *
 * The root is the directory containing `main.ts` (see `findAgentSourceRoot`),
 * and both that root and `runtimeCwd` are symlink-resolved (canonicalized) so
 * the comparison compares real locations rather than lexical spellings that may
 * alias them (for example /home -> /mnt). When realpath fails (a virtual or
 * overlay mount) the resolved absolute path is used as a fallback so startup is
 * not blocked, just as the directory resolver in tool-safety-config does.
 *
 * Never throws: the mismatch is reported as the `cwdMatchesRoot` flag so the
 * caller can choose the clear diagnostic (the CLI fails startup with
 * `AgentSourceRootMismatchError`).
 */
export function resolveAgentSourceRoot(
    mainPath: string,
    runtimeCwd: string = process.cwd(),
): AgentSourceRootResolution {
    const rootFromSource = findAgentSourceRoot(mainPath, runtimeCwd);
    let canonicalRoot = rootFromSource;
    try {
        canonicalRoot = realpathSync(rootFromSource);
    } catch {
        canonicalRoot = rootFromSource;
    }
    let canonicalCwd = resolve(runtimeCwd);
    try {
        canonicalCwd = realpathSync(runtimeCwd);
    } catch {
        canonicalCwd = resolve(runtimeCwd);
    }
    return { root: canonicalRoot, cwdMatchesRoot: canonicalRoot === canonicalCwd };
}
