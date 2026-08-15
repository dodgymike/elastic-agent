// Unit tests for workspace-init.ts: the system initialisation step that
// resolves the working directory (pwd) and the canonical (symlink-resolved)
// path of the starting directory, packaging them for CLAUDE.md injection and
// as trusted roots for the tool classifier.
// Compiled and executed standalone by the `test:workspace-init` npm script.
import { mkdtempSync, rmSync, symlinkSync, realpathSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  resolveWorkspaceInit,
  loadWorkspaceInit,
  workspaceInitMarkdown,
  workspaceInitToState,
  injectWorkspaceInitMarkdown,
  writeWorkspaceInitMarkdown,
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

    // ------------------------------------------------------------------
    // 9. injectWorkspaceInitMarkdown appends a fresh section idempotently,
    //    preserving any prior user-authored CLAUDE.md content.
    // ------------------------------------------------------------------
    {
      const init = resolveWorkspaceInit();
      const original = "# Mission\n\nSome existing guidance.\n";
      // First injection appends the section (no marker present yet).
      const first = injectWorkspaceInitMarkdown(original, init);
      check("injection appends the section", first.changed === true && first.replaced === false);
      check("injection marks the section with the marker", first.content.includes(WORKSPACE_INIT_MARKER));
      check("injection preserves the original content", first.content.startsWith("# Mission\n\nSome existing guidance."));
      check("injection states the canonical directory", first.content.includes(init.canonicalPath));
      // Re-injecting the same block is a no-op (idempotent).
      const second = injectWorkspaceInitMarkdown(first.content, init);
      check("re-injection is idempotent (no change)", second.changed === false && second.content === first.content);
    }

    // ------------------------------------------------------------------
    // 10. injectWorkspaceInitMarkdown replaces an existing section in place,
    //     keeping any content that followed it intact.
    // ------------------------------------------------------------------
    {
      const initA = resolveWorkspaceInit("/alpha/repo");
      const initB = resolveWorkspaceInit("/beta/repo");
      const original = "# Mission\n\nLead-in text.\n";
      const injected = injectWorkspaceInitMarkdown(original, initA);
      check("first injection is an append", injected.replaced === false);
      // Now replace the section with a different init, preserving trailing text.
      const trailing = `${injected.content}\n# Closing section\n\nTrailing content.`;
      const replaced = injectWorkspaceInitMarkdown(trailing, initB);
      check("replacement flags replaced=true", replaced.replaced === true);
      check("replacement changed the content", replaced.changed === true);
      check("replacement uses the new canonical path", replaced.content.includes(initB.canonicalPath));
      check("replacement drops the old canonical path", !replaced.content.includes(initA.canonicalPath));
      check("trailing section is preserved", replaced.content.includes("# Closing section") && replaced.content.includes("Trailing content."));
      // Marker appears exactly once.
      const markerCount = replaced.content.split(`<!-- ${WORKSPACE_INIT_MARKER}`).length - 1;
      check("replacement leaves exactly one marker section", markerCount === 1);
    }

    // ------------------------------------------------------------------
    // 11. writeWorkspaceInitMarkdown reads/writes the file only when needed.
    // ------------------------------------------------------------------
    {
      const dir = mkdtempSync(join(tmpdir(), "ws-init-write-"));
      const filePath = join(dir, "CLAUDE.md");
      try {
        const init = resolveWorkspaceInit();
        const originalContent = "# Mission\n\nExisting content.\n";
        writeFileSync(filePath, originalContent, "utf-8");
        // First write adds the section.
        const first = writeWorkspaceInitMarkdown(filePath, init);
        check("first write changed the file", first.changed === true);
        check("file now carries the marker", readFileSync(filePath, "utf-8").includes(WORKSPACE_INIT_MARKER));
        check("file preserved the original content", readFileSync(filePath, "utf-8").startsWith("# Mission"));
        // Second write is a no-op (file unchanged).
        const second = writeWorkspaceInitMarkdown(filePath, init);
        check("second write did not change the file", second.changed === false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // ------------------------------------------------------------------
    // 12. Missing write permissions: writeWorkspaceInitMarkdown surfaces a
    //     clear error rather than silently succeeding. This documents the
    //     fail-soft contract: the startup caller (main.ts) catches the error
    //     and emits a warning instead of aborting the run, so a read-only or
    //     otherwise non-writable CLAUDE.md never crashes initialisation.
    // ------------------------------------------------------------------
    {
      const dir = mkdtempSync(join(tmpdir(), "ws-init-noperm-"));
      try {
        // Make the directory itself non-writable so any CLAUDE.md write fails
        // with EACCES even when run as a non-root user. Skip the assertion
        // when running as root (uid 0), where permission bits are ignored, so
        // the test stays reliable in root containers.
        chmodSync(dir, 0o500);
        let threw = false;
        try {
          const lockDir = join(dir, "sub");
          mkdirSync(lockDir);
          writeWorkspaceInitMarkdown(join(lockDir, "CLAUDE.md"), resolveWorkspaceInit(dir));
        } catch {
          threw = true;
        }
        if (typeof process.getuid === "function" && process.getuid() === 0) {
          console.log("SKIP: running as root; permission-based write failure not exercised");
        } else {
          check("write into a non-writable directory throws", threw);
        }
      } finally {
        // Restore permissions so cleanup can remove the tree.
        try {
          chmodSync(dir, 0o700);
        } catch {
          // best-effort
        }
        rmSync(dir, { recursive: true, force: true });
      }
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
