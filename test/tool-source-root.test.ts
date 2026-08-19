import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    AgentSourceRootMismatchError,
    findAgentSourceRoot,
    resolveAgentSourceRoot,
} from "../tool-source-root.js";

const sandbox = mkdtempSync(join(tmpdir(), "tool-source-root-"));

try {
    // A repository root with the agent's main.ts entry file.
    const repoRoot = join(sandbox, "repo");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, "main.ts"), "// entry\n");

    // Happy path: the entry module is main.ts and the working directory is the
    // repo root, so the root resolves and the cwd matches it.
    const happy = resolveAgentSourceRoot(join(repoRoot, "main.ts"), repoRoot);
    assert.equal(happy.root, resolve(repoRoot));
    assert.equal(happy.cwdMatchesRoot, true);

    // Compiled-entry path: running dist/main.js still resolves the agent-source
    // root upward to the directory containing main.ts, and the cwd (the repo
    // root, which is where the compiled artifact is launched from) matches.
    const compiledDir = join(repoRoot, "dist");
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(compiledDir, "main.js"), "// compiled\n");
    const compiled = resolveAgentSourceRoot(join(compiledDir, "main.js"), repoRoot);
    assert.equal(compiled.root, resolve(repoRoot));
    assert.equal(compiled.cwdMatchesRoot, true);

    // findAgentSourceRoot directly: starting from the compiled entry it climbs
    // to the ancestor that owns main.ts (the repo root).
    assert.equal(findAgentSourceRoot(join(compiledDir, "main.js"), repoRoot), resolve(repoRoot));

    // Mismatch path: a working directory that is NOT the agent-source root is
    // reported as a mismatch (cwdMatchesRoot=false) so the CLI can fail
    // startup with a clear error instead of running with an ambiguous boundary.
    const elsewhere = join(sandbox, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const mismatch = resolveAgentSourceRoot(join(repoRoot, "main.ts"), elsewhere);
    assert.equal(mismatch.root, resolve(repoRoot));
    assert.equal(mismatch.cwdMatchesRoot, false);
    // The mismatch has a dedicated error class whose message names the root and
    // the working directory clearly so startup can print it and exit non-zero.
    const mismatchError = new AgentSourceRootMismatchError(mismatch.root, elsewhere);
    assert.match(mismatchError.message, /--allow-agent-source-modifications requires the working directory to be the agent source root/);
    assert.match(mismatchError.message, /does not resolve to it/);
    assert.equal(mismatchError.name, "AgentSourceRootMismatchError");

    // A missing-entry fallback: when no ancestor contains main.ts, the
    // directory of the entry module itself is returned (safe, non-empty root)
    // rather than throwing.
    const bare = join(sandbox, "bare");
    mkdirSync(bare, { recursive: true });
    assert.equal(findAgentSourceRoot(join(bare, "main.js"), bare), resolve(bare));
    assert.ok(existsSync(resolve(bare)));
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}

console.log("Tool-source-root resolution tests passed.");
