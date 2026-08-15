import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("Tool-safety config resolution tests passed.");
