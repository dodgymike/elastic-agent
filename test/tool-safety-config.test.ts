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

  // Boolean flags map onto the resolved config.
  assert.equal(resolveToolSafetyConfig({ disableClassifier: true }, sandbox).enabled, false);
  assert.equal(resolveToolSafetyConfig({ disableClassifier: false }, sandbox).enabled, true);
  assert.equal(
    resolveToolSafetyConfig({ allowAgentSourceModifications: true }, sandbox).allowAgentSourceModifications,
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
  const modsOnly = resolveToolSafetyConfig({ allowAgentSourceModifications: true }, sandbox);
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
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("Tool-safety config resolution tests passed.");
