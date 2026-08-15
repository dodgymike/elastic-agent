/**
 * Start-directory tool working-directory switch.
 *
 * The central tool dispatcher runs every tool from the configured `--start-dir`
 * and restores the previous process working directory afterwards, including
 * when the tool rejects. This module owns that switch so the enter/restore
 * sequence is a single, dependency-free unit that can be regression tested
 * without booting the agent loop.
 *
 * The directory is validated when the CLI flags are resolved (see
 * `tool-safety-config.ts`), so callers pass the already-normalized absolute
 * path here. A chdir failure is still possible (for example the directory was
 * removed after startup), and it is reported with a clear diagnostic while the
 * process stays in its previous working directory.
 */

/**
 * Error thrown when the process cannot change into the configured start
 * directory. The message is the clear diagnostic rendered to the user.
 */
export class StartDirEntryError extends Error {
    constructor(startDir: string, cause: unknown) {
        super(
            `Unable to enter --start-dir '${startDir}': ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.name = "StartDirEntryError";
    }
}

/** State captured when the process working directory was switched. */
export interface StartDirSwitch {
    /** The working directory captured before the switch. */
    readonly previousCwd: string;
    /** True when the process working directory was actually changed. */
    readonly switched: boolean;
}

/**
 * Switch the process working directory into `startDir` when it is configured
 * and different from the current directory, and return the state needed to
 * restore the previous directory. When `startDir` is undefined (the
 * `--start-dir` flag was not provided) or already matches the current
 * directory, the process working directory is left unchanged.
 *
 * Throws `StartDirEntryError` with a clear diagnostic when the switch fails;
 * on failure the process remains in its previous working directory.
 */
export function switchToStartDir(startDir: string | undefined): StartDirSwitch {
    const previousCwd = process.cwd();
    if (startDir !== undefined && previousCwd !== startDir) {
        try {
            process.chdir(startDir);
        } catch (error) {
            throw new StartDirEntryError(startDir, error);
        }
        return { previousCwd, switched: true };
    }
    return { previousCwd, switched: false };
}

/**
 * Restore the working directory captured by `switchToStartDir`. Safe to call
 * with the state from a no-op switch (the previous directory is not changed).
 */
export function restoreStartDir(state: StartDirSwitch | undefined): void {
    if (state?.switched) {
        process.chdir(state.previousCwd);
    }
}
