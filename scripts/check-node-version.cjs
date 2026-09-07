#!/usr/bin/env node
"use strict";

/**
 * Prestart guard for `npm start`. It reads the same `engines.node` declaration
 * as src/cli/node-version-check.ts (the single source of truth in package.json) and
 * exits with an actionable message before `npm run build` or provider
 * initialization on an unsupported Node.js runtime.
 */

const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, parse } = require("node:path");

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim());
  if (!match) throw new Error(`Unrecognized Node.js version "${value}".`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function parseMinimum(engineRange) {
  const range = String(engineRange ?? "").trim();
  if (!range) throw new Error('package.json "engines.node" is empty. Declare a minimum such as ">=22.9.0".');
  const version = range.startsWith(">=") ? range.slice(2).trim() : range;
  if (!version) throw new Error(`package.json "engines.node" range "${range}" has no version.`);
  parseVersion(version);
  return version;
}

function atLeast(current, minimum) {
  const a = parseVersion(current);
  const b = parseVersion(minimum);
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

function findPackageJson(startDir) {
  const filesystemRoot = parse(startDir).root;
  let dir = startDir;
  const seen = new Set();
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    if (dir === filesystemRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate package.json.");
}

const packageJsonPath = findPackageJson(__dirname);
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const minimum = parseMinimum(pkg.engines && pkg.engines.node);

if (!atLeast(process.version, minimum)) {
  console.error(
    `Elastic Agent requires Node.js >= ${minimum} (found ${process.version}). ` +
      `Install a supported Node.js runtime (for example: nvm install ${parseVersion(minimum).major}) and re-run. ` +
      'See README.md "Requirements" for setup instructions.',
  );
  process.exit(1);
}
