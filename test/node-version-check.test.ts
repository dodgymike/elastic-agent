import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSupportedNodeVersion,
  compareNodeVersions,
  parseMinimumNodeVersion,
  parseNodeVersion,
  resolveMinimumNodeVersion,
  satisfiesMinimumNodeVersion,
  unsupportedNodeVersionMessage,
} from "../node-version-check.js";

function testParseNodeVersion(): void {
  assert.deepEqual(parseNodeVersion("v22.9.0"), { major: 22, minor: 9, patch: 0, prerelease: [] });
  assert.deepEqual(parseNodeVersion("22.9.0"), { major: 22, minor: 9, patch: 0, prerelease: [] });
  assert.deepEqual(parseNodeVersion("v18.19.1"), { major: 18, minor: 19, patch: 1, prerelease: [] });
  assert.deepEqual(parseNodeVersion("v22.9.0-rc.1"), { major: 22, minor: 9, patch: 0, prerelease: ["rc", "1"] });
  assert.throws(() => parseNodeVersion(""), /Unrecognized Node.js version/);
  assert.throws(() => parseNodeVersion("node"), /Unrecognized Node.js version/);
  assert.throws(() => parseNodeVersion("v22.9"), /Unrecognized Node.js version/);
}

function testCompareNodeVersions(): void {
  assert.equal(compareNodeVersions("v22.9.0", "v22.9.0"), 0);
  assert.ok(compareNodeVersions("v22.10.0", "v22.9.0") > 0);
  assert.ok(compareNodeVersions("v18.19.1", "v22.9.0") < 0);
  assert.ok(compareNodeVersions("v22.9.0", "v22.9.0-rc.1") > 0, "release sorts after prerelease");
  assert.ok(compareNodeVersions("v22.9.0-rc.1", "v22.9.0-rc.2") < 0);
}

function testSatisfiesMinimumNodeVersion(): void {
  assert.equal(satisfiesMinimumNodeVersion("v22.9.0", "22.9.0"), true);
  assert.equal(satisfiesMinimumNodeVersion("v22.10.1", "22.9.0"), true);
  assert.equal(satisfiesMinimumNodeVersion("v22.8.9", "22.9.0"), false);
  assert.equal(satisfiesMinimumNodeVersion("v18.19.1", "22.9.0"), false);
  assert.equal(satisfiesMinimumNodeVersion("v22.9.0-rc.1", "22.9.0"), false, "prerelease is below the same release");
}

function testParseMinimumNodeVersion(): void {
  assert.equal(parseMinimumNodeVersion(">=22.9.0"), "22.9.0");
  assert.equal(parseMinimumNodeVersion("22.9.0"), "22.9.0");
  assert.throws(() => parseMinimumNodeVersion(""), /engines\.node/);
  assert.throws(() => parseMinimumNodeVersion(">="), /has no version/);
  assert.throws(() => parseMinimumNodeVersion("^22.0.0"), /Unrecognized Node.js version/);
}

function testResolveMinimumNodeVersion(): void {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-node-version-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ engines: { node: ">=22.9.0" } }), { mode: 0o600 });
    assert.equal(resolveMinimumNodeVersion(directory), "22.9.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const missing = mkdtempSync(join(tmpdir(), "elastic-agent-node-version-missing-"));
  try {
    writeFileSync(join(missing, "package.json"), JSON.stringify({}), { mode: 0o600 });
    assert.throws(() => resolveMinimumNodeVersion(missing), /has no "engines\.node"/);
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
}

function testUnsupportedNodeVersionMessage(): void {
  const message = unsupportedNodeVersionMessage("v18.19.1", "22.9.0");
  assert.match(message, /22\.9\.0/);
  assert.match(message, /v18\.19\.1/);
  assert.match(message, /nvm install 22/);
  assert.match(message, /Requirements/);
}

function testAssertSupportedNodeVersion(): void {
  const directory = mkdtempSync(join(tmpdir(), "elastic-agent-node-version-assert-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ engines: { node: ">=22.9.0" } }), { mode: 0o600 });
    assert.doesNotThrow(() => assertSupportedNodeVersion("v22.9.0", directory));
    assert.doesNotThrow(() => assertSupportedNodeVersion("v23.0.0", directory));
    assert.throws(() => assertSupportedNodeVersion("v18.19.1", directory), /requires Node.js >= 22\.9\.0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  testParseNodeVersion();
  testCompareNodeVersions();
  testSatisfiesMinimumNodeVersion();
  testParseMinimumNodeVersion();
  testResolveMinimumNodeVersion();
  testUnsupportedNodeVersionMessage();
  testAssertSupportedNodeVersion();
  console.log("Node version check fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
