import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveToolSafetyConfig, startDirPathWarning } from "../tool-safety-config.js";

const sandbox = mkdtempSync(join(tmpdir(), "tool-safety-config-"));

try {
  // Defaults: classifier enabled, modifications disallowed, and both directory
  // paths resolve to the runtime working directory.
  const defaults = resolveToolSafetyConfig({}, sandbox);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.allowAgentSourceModifications, false);
  assert.equal(defaults.agentSourceDir, resolve(sandbox));
  assert.equal(defaults.startDir, resolve(sandbox));

  // Boolean flags map onto the resolved config. The modifications flag resolves
  // its agent-source root from a main.ts entry file, so point it at a real one
  // in the sandbox (the sandbox is the runtime cwd, matching the root).
  assert.equal(resolveToolSafetyConfig({ disableClassifier: true }, sandbox).enabled, false);
  assert.equal(resolveToolSafetyConfig({ disableClassifier: false }, sandbox).enabled, true);
  const rootMain = join(sandbox, "main.ts");
  writeFileSync(rootMain, "// entry\n");
  assert.equal(
    resolveToolSafetyConfig({ allowAgentSourceModifications: true }, sandbox, rootMain).allowAgentSourceModifications,
    true,
  );

  // --start-dir and --allow-agent-source-modifications are mutually exclusive:
  // combining them must fail with a clear usage error so the CLI can exit
  // non-zero instead of running with ambiguous filesystem boundaries.
  assert.throws(
    () =>
      resolveToolSafetyConfig({ startDir: ".", allowAgentSourceModifications: true }, sandbox),
    /--allow-agent-source-modifications and --start-dir cannot be used together/,
  );

  // The exclusion applies regardless of option order and is independent of the
  // classifier's enabled/disabled state.
  assert.throws(
    () =>
      resolveToolSafetyConfig(
        { allowAgentSourceModifications: true, startDir: ".", disableClassifier: true },
        sandbox,
      ),
    /--allow-agent-source-modifications and --start-dir cannot be used together/,
  );

  // Each flag alone remains valid: --start-dir without modifications, and
  // modifications without an explicit --start-dir.
  const startDirOnly = resolveToolSafetyConfig({ startDir: "." }, sandbox);
  assert.equal(startDirOnly.startDirConfigured, true);
  assert.equal(startDirOnly.allowAgentSourceModifications, false);
  const modsOnly = resolveToolSafetyConfig({ allowAgentSourceModifications: true }, sandbox, rootMain);
  assert.equal(modsOnly.startDirConfigured, false);
  assert.equal(modsOnly.allowAgentSourceModifications, true);

  // Relative directory values resolve to absolute paths under the runtime cwd.
  const child = join(sandbox, "child");
  mkdirSync(child);
  const resolved = resolveToolSafetyConfig({ agentSourceDir: "child", startDir: "./child" }, sandbox);
  assert.equal(resolved.agentSourceDir, resolve(sandbox, "child"));
  assert.equal(resolved.startDir, resolve(sandbox, "child"));

  // Missing directories produce a clear usage error naming the flag.
  assert.throws(
    () => resolveToolSafetyConfig({ agentSourceDir: "missing" }, sandbox),
    /--agent-source-dir 'missing' does not exist/,
  );

  // The --start-dir flag reports the same flag-specific usage error.
  assert.throws(
    () => resolveToolSafetyConfig({ startDir: "missing" }, sandbox),
    /--start-dir 'missing' does not exist/,
  );

  // Directory validation still runs even when the classifier is disabled.
  assert.throws(
    () => resolveToolSafetyConfig({ agentSourceDir: "missing", disableClassifier: true }, sandbox),
    /--agent-source-dir 'missing' does not exist/,
  );

  // Absolute directory values are normalized to resolved absolute paths.
  const absoluteResolved = resolveToolSafetyConfig({ agentSourceDir: child, startDir: child }, sandbox);
  assert.equal(absoluteResolved.agentSourceDir, resolve(child));
  assert.equal(absoluteResolved.startDir, resolve(child));

  // A file passed as a directory is rejected with a clear usage error.
  const file = join(sandbox, "file.txt");
  writeFileSync(file, "x");
  assert.throws(
    () => resolveToolSafetyConfig({ startDir: file }, sandbox),
    /--start-dir '.*file\.txt' is not a directory/,
  );

  // Blank values are rejected as non-empty path violations.
  assert.throws(
    () => resolveToolSafetyConfig({ startDir: "" }, sandbox),
    /--start-dir requires a non-empty directory path/,
  );
  assert.throws(
    () => resolveToolSafetyConfig({ agentSourceDir: "   " }, sandbox),
    /--agent-source-dir requires a non-empty directory path/,
  );

  // startDirPathWarning injects the exact required path line (with a blank-line
  // separator) only when --start-dir was explicitly configured.
  assert.equal(
    startDirPathWarning({ startDir: "/abs/start-dir", startDirConfigured: true }),
    "\n\nALL PATHS MUST BE ABSOLUTE OR RELATIVE TO /abs/start-dir.",
  );

  // The line is omitted entirely when the flag is absent (runtime-cwd default).
  assert.equal(
    startDirPathWarning({ startDir: resolve(sandbox), startDirConfigured: false }),
    "",
  );

  // Resolution + warning together: a relative --start-dir resolves to an
  // absolute path before the warning is rendered.
  const childConfig = resolveToolSafetyConfig({ startDir: "child" }, sandbox);
  assert.equal(childConfig.startDirConfigured, true);
  assert.equal(
    startDirPathWarning(childConfig),
    `\n\nALL PATHS MUST BE ABSOLUTE OR RELATIVE TO ${resolve(sandbox, "child")}.`,
  );

  // Docker mode keeps the required path line and appends a short Docker-only
  // note stating that outside-directory filesystem access is permitted for the
  // running container session.
  const dockerNote =
    "\nDocker/container detected: filesystem access outside this directory is permitted for this running container session.";
  assert.equal(
    startDirPathWarning({ startDir: "/abs/start-dir", startDirConfigured: true }, true),
    `\n\nALL PATHS MUST BE ABSOLUTE OR RELATIVE TO /abs/start-dir.${dockerNote}`,
  );

  // The Docker note is omitted in non-Docker mode and when --start-dir is
  // absent (the runtime-cwd default produces no warning at all).
  assert.equal(
    startDirPathWarning({ startDir: "/abs/start-dir", startDirConfigured: true }, false),
    "\n\nALL PATHS MUST BE ABSOLUTE OR RELATIVE TO /abs/start-dir.",
  );
  assert.equal(
    startDirPathWarning({ startDir: resolve(sandbox), startDirConfigured: false }, true),
    "",
  );

  // Directory values are canonicalized (symlink-resolved) so the classifier and
  // tool working-directory logic compare against the real location rather than
  // a lexical spelling that may alias it (for example /home -> /mnt). A
  // symlinked --start-dir/--agent-source-dir resolves to its canonical target,
  // which is the exact canonical workspace root / tool-cwd step 3b relies on.
  const canonTarget = join(sandbox, "canonical-target");
  mkdirSync(canonTarget);
  const aliasLink = join(sandbox, "alias");
  let aliasResolves = false;
  try {
    symlinkSync(canonTarget, aliasLink, "dir");
    aliasResolves = realpathSync(aliasLink) === realpathSync(canonTarget);
  } catch {
    // Symlinks unsupported on this platform: the alias-based assertions below
    // are skipped (the non-alias canonicalization checks still run).
    aliasResolves = false;
  }
  if (aliasResolves) {
    const canonicalResolved = resolveToolSafetyConfig({ startDir: aliasLink, agentSourceDir: aliasLink }, sandbox);
    assert.equal(canonicalResolved.startDirConfigured, true);
    // The resolved start dir / agent source dir is the canonical target, not
    // the symlink alias, which is the canonical workspace root / tool-cwd step
    // 3b relies on.
    assert.equal(canonicalResolved.startDir, realpathSync(canonTarget));
    assert.equal(canonicalResolved.agentSourceDir, canonicalResolved.startDir);
    // The start-dir path warning reflects the canonical directory, so the model
    // is told to prefix relative paths with the canonical workspace root.
    assert.equal(
      startDirPathWarning(canonicalResolved),
      `\n\nALL PATHS MUST BE ABSOLUTE OR RELATIVE TO ${canonicalResolved.startDir}.`,
    );
  }

  // The non-canonical (default) case still canonicalizes the runtime cwd. When
  // the sandbox is not itself a symlink these are equal; canonicalization never
  // breaks a real directory's own path.
  const defaultCanonical = resolveToolSafetyConfig({}, sandbox);
  assert.equal(defaultCanonical.startDir, realpathSync(sandbox));
  assert.equal(defaultCanonical.agentSourceDir, realpathSync(sandbox));

  // --allow-agent-source-modifications resolves the agent-source root from the
  // main entry module and enforces that the working directory matches it. With
  // a main.ts at the root and the cwd equal to that root (the happy path), both
  // the agent-source dir and the working/start dir become the canonical root,
  // and the classifier is told modifications are permitted there.
  const srcRoot = join(sandbox, "src-root");
  mkdirSync(srcRoot, { recursive: true });
  const mainEntry = join(srcRoot, "main.ts");
  writeFileSync(mainEntry, "// entry\n");
  const modsHappy = resolveToolSafetyConfig(
    { allowAgentSourceModifications: true },
    srcRoot,
    mainEntry,
  );
  assert.equal(modsHappy.allowAgentSourceModifications, true);
  assert.equal(modsHappy.agentSourceDir, realpathSync(srcRoot));
  assert.equal(modsHappy.startDir, realpathSync(srcRoot));
  assert.equal(modsHappy.startDirConfigured, false);

  // A working directory that does not resolve to the agent-source root fails
  // startup with a clear mismatch error so the CLI can exit non-zero instead of
  // running with an ambiguous filesystem boundary.
  const wrongCwd = join(sandbox, "wrong-cwd");
  mkdirSync(wrongCwd, { recursive: true });
  assert.throws(
    () => resolveToolSafetyConfig({ allowAgentSourceModifications: true }, wrongCwd, mainEntry),
    /--allow-agent-source-modifications requires the working directory to be the agent source root/,
  );

  // Without a main entry path the mods flag cannot resolve a root and fails
  // with a clear usage error rather than guessing.
  assert.throws(
    () => resolveToolSafetyConfig({ allowAgentSourceModifications: true }, srcRoot),
    /--allow-agent-source-modifications requires the main entry module path to resolve the agent source root/,
  );

  // --safe-dir resolves a comma-separated list of directories into canonical
  // absolute paths, independent of the edit/modifications flags.
  const safeA = join(sandbox, "safe-a");
  const safeB = join(sandbox, "safe-b");
  mkdirSync(safeA);
  mkdirSync(safeB);
  const withSafeDirs = resolveToolSafetyConfig({ safeDirs: `safe-a,${safeB}` }, sandbox);
  assert.deepEqual(
    withSafeDirs.safeDirs,
    [realpathSync(safeA), realpathSync(safeB)],
  );
  assert.equal(withSafeDirs.allowAgentSourceModifications, false);

  // Relative + absolute entries, whitespace trimming, and de-duplication are
  // handled by the resolver. Empty entries (trailing/doubled commas) are
  // skipped, never producing empty paths.
  const withManySafe = resolveToolSafetyConfig(
    { safeDirs: ` safe-a , ${safeB}, ,safe-a` },
    sandbox,
  );
  assert.deepEqual(
    withManySafe.safeDirs,
    [realpathSync(safeA), realpathSync(safeB)],
  );

  // A missing --safe-dir entry fails with a clear usage error naming the flag.
  assert.throws(
    () => resolveToolSafetyConfig({ safeDirs: `safe-a,missing-one` }, sandbox),
    /--safe-dir 'missing-one' does not exist/,
  );

  // safeDirs stays an empty array when the flag is absent.
  assert.deepEqual(resolveToolSafetyConfig({}, sandbox).safeDirs, []);

  // --safe-dir is threaded through the --allow-agent-source-modifications
  // branch as well, adding to the authoritative agent-source root.
  const modsWithSafe = resolveToolSafetyConfig(
    { allowAgentSourceModifications: true, safeDirs: safeA },
    srcRoot,
    mainEntry,
  );
  assert.equal(modsWithSafe.allowAgentSourceModifications, true);
  assert.deepEqual(modsWithSafe.safeDirs, [realpathSync(safeA)]);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("Tool-safety config resolution tests passed.");
