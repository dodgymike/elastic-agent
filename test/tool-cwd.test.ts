// Regression tests for the --start-dir tool working-directory switch
// (tool-cwd.ts). The central tool dispatcher runs every tool from the
// configured start directory and restores the previous process working
// directory afterwards, including when the tool rejects. These tests exercise
// the exact switch/restore helpers used by the dispatcher without booting the
// agent loop.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreStartDir, StartDirEntryError, switchToStartDir } from "../tool-cwd.js";

const sandbox = mkdtempSync(join(tmpdir(), "tool-cwd-"));
const startDir = join(sandbox, "start-dir");
mkdirSync(startDir);
const originalCwd = process.cwd();

async function run(): Promise<void> {
    try {
        // Switching into a configured start directory moves the process cwd
        // there and records how to restore the previous directory.
        {
            const state = switchToStartDir(startDir);
            assert.equal(state.switched, true);
            assert.equal(state.previousCwd, originalCwd);
            assert.equal(realpathSync(process.cwd()), realpathSync(startDir));
            restoreStartDir(state);
            assert.equal(process.cwd(), originalCwd);
        }

        // An absent startDir (--start-dir not provided) leaves cwd unchanged.
        {
            const state = switchToStartDir(undefined);
            assert.equal(state.switched, false);
            assert.equal(state.previousCwd, originalCwd);
            assert.equal(process.cwd(), originalCwd);
            restoreStartDir(state);
            assert.equal(process.cwd(), originalCwd);
        }

        // Switching into the already-current directory is a no-op.
        {
            process.chdir(startDir);
            const before = process.cwd();
            const state = switchToStartDir(startDir);
            assert.equal(state.switched, false);
            assert.equal(process.cwd(), before);
            restoreStartDir(state);
            assert.equal(process.cwd(), before);
            process.chdir(originalCwd);
        }

        // The dispatcher restores the previous cwd in a finally block even
        // when the tool rejects. Mirror the dispatcher sequence: switch, run,
        // restore in finally.
        {
            let observedCwd: string | undefined;
            const state = switchToStartDir(startDir);
            try {
                await (async () => {
                    observedCwd = process.cwd();
                    throw new Error("tool failed");
                })();
            } catch (error) {
                assert.match(String((error as Error).message), /tool failed/);
            } finally {
                restoreStartDir(state);
            }
            assert.ok(observedCwd !== undefined, "run callback must observe the switched cwd");
            assert.equal(realpathSync(observedCwd!), realpathSync(startDir));
            assert.equal(process.cwd(), originalCwd);
        }

        // A chdir failure produces a clear StartDirEntryError diagnostic and
        // leaves the process in its previous directory.
        {
            const missing = join(sandbox, "missing");
            const before = process.cwd();
            assert.throws(
                () => switchToStartDir(missing),
                (error: unknown) => {
                    assert.ok(error instanceof StartDirEntryError, "chdir failure must throw StartDirEntryError");
                    assert.match(error.message, /^Unable to enter --start-dir '/);
                    assert.ok(error.message.includes(missing), "diagnostic must name the failing directory");
                    return true;
                },
            );
            assert.equal(process.cwd(), before);
        }
    } finally {
        process.chdir(originalCwd);
        rmSync(sandbox, { recursive: true, force: true });
    }
}

run()
    .then(() => {
        console.log("Start-dir tool cwd regression tests passed.");
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
