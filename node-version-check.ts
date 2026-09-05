/**
 * Supported Node.js toolchain enforcement.
 *
 * The single source of truth for the supported runtime is `engines.node` in
 * the repository `package.json`. This module reads that declaration at startup
 * and compares it against the running `process.version` so an unsupported
 * runtime fails with an actionable message before any LLM provider is
 * initialized. The module is intentionally dependency-free (only
 * `node:fs`/`node:path`) so it can be compiled and imported ahead of the LLM
 * adapter composition.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export interface ParsedNodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseNodeVersion(value: string): ParsedNodeVersion {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Unrecognized Node.js version string "${value}". Expected a version such as v22.9.0.`);
  }
  const prerelease = match[4] ?? "";
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

function isNumericIdentifier(part: string): boolean {
  return /^\d+$/.test(part);
}

/** Compare two Node.js version strings (with optional leading "v"). */
export function compareNodeVersions(left: string, right: string): number {
  const a = parseNodeVersion(left);
  const b = parseNodeVersion(right);
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A release (no prerelease) sorts after any prerelease of the same triplet.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const aPart = a.prerelease[i];
    const bPart = b.prerelease[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const aNumeric = isNumericIdentifier(aPart);
    const bNumeric = isNumericIdentifier(bPart);
    if (aNumeric && bNumeric) {
      const diff = Number(aPart) - Number(bPart);
      if (diff !== 0) return diff;
    } else if (aNumeric) {
      return -1; // Numeric identifiers sort before alphanumeric identifiers.
    } else if (bNumeric) {
      return 1;
    } else if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }
  return 0;
}

export function satisfiesMinimumNodeVersion(current: string, minimum: string): boolean {
  return compareNodeVersions(current, minimum) >= 0;
}

/**
 * Parse the project's `engines.node` declaration. A `>=x.y.z` range or a bare
 * `x.y.z` (treated as a minimum) is supported; anything else fails closed so a
 * future edit of package.json cannot silently change enforcement semantics.
 */
export function parseMinimumNodeVersion(engineRange: string): string {
  const range = engineRange.trim();
  if (!range) {
    throw new Error('package.json "engines.node" is empty. Declare a minimum such as ">=22.9.0".');
  }
  const version = range.startsWith(">=") ? range.slice(2).trim() : range;
  if (!version) {
    throw new Error(`package.json "engines.node" range "${range}" has no version. Declare a minimum such as ">=22.9.0".`);
  }
  parseNodeVersion(version);
  return version;
}

/** Walk upward from `startDir` to the nearest ancestor containing package.json. */
function findPackageRoot(startDir: string): string {
  const filesystemRoot = parse(startDir).root;
  let dir = startDir;
  const seen = new Set<string>();
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dir === filesystemRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate package.json (with "engines.node") above "${startDir}".`);
}

export function resolveMinimumNodeVersion(startDir: string = __dirname): string {
  const root = findPackageRoot(startDir);
  const packageJsonPath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    engines?: { node?: string };
  };
  const range = packageJson.engines?.node;
  if (range === undefined) {
    throw new Error(`package.json at "${packageJsonPath}" has no "engines.node" declaration. Add one such as ">=22.9.0".`);
  }
  return parseMinimumNodeVersion(range);
}

function majorOfVersion(value: string): number {
  return parseNodeVersion(value).major;
}

export function unsupportedNodeVersionMessage(current: string, minimum: string): string {
  return (
    `Elastic Agent requires Node.js >= ${minimum} (found ${current}). ` +
    `Install a supported Node.js runtime (for example: nvm install ${majorOfVersion(minimum)}) and re-run. ` +
    'See README.md "Requirements" for setup instructions.'
  );
}

/** Throw when the running Node.js does not satisfy the declared minimum. */
export function assertSupportedNodeVersion(current: string = process.version, startDir: string = __dirname): void {
  const minimum = resolveMinimumNodeVersion(startDir);
  if (!satisfiesMinimumNodeVersion(current, minimum)) {
    throw new Error(unsupportedNodeVersionMessage(current, minimum));
  }
}
