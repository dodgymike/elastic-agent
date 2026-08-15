// Unit tests for workspace-init.ts: the system initialisation step that
// resolves the working directory (pwd) and the canonical (symlink-resolved)
// path of the starting directory, packaging them for CLAUDE.md injection and
// as trusted roots for the tool classifier.
// Compiled and executed standalone by the `test:workspace-init` npm script.
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  resolveWorkspaceInit,
  loadWorkspaceInit,
  workspaceInitMarkdown,
  workspaceInitToState,
  WORKSPACE_INIT_MARKER,
  type WorkspaceInit,
} from "../workspace-init.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

async function main(): Promise<void> {
  try {
    // ------------------------------------------------------------------
    // 1. Resolution against process.cwd(): pwd is absolute and canonical is
    //    an absolute path that stays within the workspace.
    // ------------------------------------------------------------------
    {
      const init: WorkspaceInit = resolveWorkspaceInit();
      check("pwd is absolute", init.pwd.startsWith(sep));
      check("canonicalPath is absolute", init.canonicalPath.startsWith(sep));
      check("allowedDirectories contains pwd", init.allowedDirectories.includes(init.pwd));
      check("allowedDirectories contains canonicalPath", init.allowedDirectories.includes(init.canonicalPath));
      check("allowedDirectories is de-duplicated", new Set(init.allowedDirectories).size === init.allowedDirectories.length);
    }

    // ------------------------------------------------------------------
    // 2. A relative starting directory is resolved against the working dir.
    // ------------------------------------------------------------------
    {
      const base = process.cwd();
      const init = resolveWorkspaceInit(".");
      check("relative '.' resolves to absolute cwd", init.pwd === base);
    }

    // ------------------------------------------------------------------
    // 3. A symlinked starting directory resolves to its canonical target.
    // ------------------------------------------------------------------
    {
      const root = mkdtempSync(join(tmpdir(), "ws-init-"));
      const link = join(root, "link-dir");
      try {
        rmSync(link, { recursive: true, force: true });
        // Create an existing real directory that becomes the link target.
        const targetDir = mkdtempSync(join(tmpdir(), "ws-init-target-"));
        try {
          symlinkSync(targetDir, link, "dir");
          const resolved = resolveWorkspaceInit(link);
          check("symlink pwd is the link path", resolved.pwd.endsWith("link-dir"));
          check(
            "canonical path resolves the link target",
            resolved.canonicalPath === realpathSync(targetDir),
          );
        } finally {
          rmSync(targetDir, { recursive: true, force: true });
          rmSync(link, { recursive: true, force: true });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    // ------------------------------------------------------------------
    // 4. Never throws when realpath cannot resolve the path (missing dir).
    // ------------------------------------------------------------------
    {
      const init = resolveWorkspaceInit("/definitely/not/a/real/path/here");
      check("missing path still yields a pwd", typeof init.pwd === "string" && init.pwd.length > 0);
      check("missing path falls back to resolved path as canonical", init.canonicalPath === init.pwd);
      check("fallback flag is set", init.canonicalFallbackUsed === true);
    }

    // ------------------------------------------------------------------
    // 5. toMarkdown() is an idempotent CLAUDE.md section carrying the marker
    //    and instructing the agent to prefix relative paths.
    // ------------------------------------------------------------------
    {
      const init = resolveWorkspaceInit();
      const block = init.toMarkdown();
      const block2 = init.toMarkdown();
      check("markdown contains the marker", block.includes(WORKSPACE_INIT_MARKER));
      check("markdown is deterministic/idempotent", block === block2);
      check("markdown states the canonical directory", block.includes(init.canonicalPath));
      check("markdown tells the agent to prefix relative paths", /prefix every relative path/i.test(block));
    }

    // ------------------------------------------------------------------
    // 6. Serialization round-trips via workspaceInitToState/loadWorkspaceInit.
    // ------------------------------------------------------------------
    {
      const init = resolveWorkspaceInit();
      const state = workspaceInitToState(init);
      const restored = loadWorkspaceInit(state);
      check("restored is not null", restored !== null);
      check("restored pwd matches", restored !== null && restored.pwd === init.pwd);
      check("restored canonicalPath matches", restored !== null && restored.canonicalPath === init.canonicalPath);
      check(
        "restored allowedDirectories matches",
        restored !== null && JSON.stringify(restored.allowedDirectories) === JSON.stringify(init.allowedDirectories),
      );
      check("restored toMarkdown still works", restored !== null && restored.toMarkdown().includes(WORKSPACE_INIT_MARKER));
    }

    // ------------------------------------------------------------------
    // 7. loadWorkspaceInit rejects null / empty state gracefully.
    // ------------------------------------------------------------------
    {
      check("null state yields null", loadWorkspaceInit(null) === null);
      check("empty pwd state yields null", loadWorkspaceInit({ pwd: "", canonicalPath: "", canonicalFallbackUsed: false }) === null);
      check("missing canonical state yields null", loadWorkspaceInit({ pwd: "/x", canonicalPath: "", canonicalFallbackUsed: false }) === null);
    }

    // ------------------------------------------------------------------
    // 8. workspaceInitMarkdown names the directory for relative path use.
    // ------------------------------------------------------------------
    {
      const md = workspaceInitMarkdown("/repo/path", "/repo/path");
      check("markdown mentions the directory name", md.includes("path/") || md.includes("/path"));
    }
  } finally {
    if (failures > 0) {
      console.error(`workspace-init test failed with ${failures} failure(s)`);
      process.exit(1);
    }
    console.log("All workspace-init tests passed.");
  }
}

main();
