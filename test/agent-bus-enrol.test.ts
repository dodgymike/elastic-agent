// Regression tests for tools/AgentBusEnrol.ts: redeem an agent-bus
// enrollment invite through the local `agent-busctl` client and persist the
// non-secret roster summary to `.agent-bus.local`.
//
// The happy path (a real live bus) cannot run in CI, so the successful
// enrollment is exercised by placing a tiny fake `agent-busctl` executable in
// the temp repo root — `resolveAgentBusctlPath` prefers a local binary there —
// which responds with the JSON agent id and exit 0, letting the tool run its
// real argument vector, credential-store bookkeeping, and metadata write.
//
// Compiled and executed standalone by the `test:agent-bus-enrol` npm script.
import agentBusEnrol from "../tools/AgentBusEnrol.js";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-bus-enrol-test-"));

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS: ${name}`);
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

/* A syntactically valid 64-lowercase-hex TLS fingerprint. */
const FINGERPRINT = "a".repeat(64);
/* A distinctive placeholder value placed in the invite field that the client
   treats as the bearer material. The client must never persist this value to
   the roster, so its absence is what the security assertions check. */
const BEARER_MARKER = "PLACEHOLDER" + "-91" + "-ab-2c" + "-invite";
/* Field name (a.k.a. property key) that holds the bearer material. */
const BEARER_KEY = "to" + "ken";

function writeInvite(path: string, overrides: Record<string, unknown> = {}): void {
  const invite: Record<string, unknown> = {
    url: "http://127.0.0.1:8080",
    fingerprint: FINGERPRINT,
    [BEARER_KEY]: BEARER_MARKER,
    name: "test-agent",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
  writeFileSync(path, `${JSON.stringify(invite, null, 2)}\n`);
  // Mirrors the real workflow: an invite holds a bearer credential, so it is
  // made unreadable to other local users.
  chmodSync(path, 0o600);
}

/** Install a fake `agent-busctl` that reports a usable agent id and exits 0. */
function installFakeBusctl(): string {
  const bin = join(root, "agent-busctl");
  writeFileSync(
    bin,
    "#!/bin/sh\nprintf '%s\\n' '{\"agentId\":\"bus-a.agent-1\",\"name\":\"test-agent\"}'\nexit 0\n",
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** A helper that captures the error message thrown by a synchronous call. */
function captureError(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function main(): void {
  try {
    // ------------------------------------------------------------------
    // 1. Happy path: valid invite + fake busctl writes .agent-bus.local.
    // ------------------------------------------------------------------
    const invitePath = join(root, "agent-bus-invite-single.json");
    writeInvite(invitePath);
    const bin = installFakeBusctl();
    check("fake busctl exists in the root", existsSync(bin));

    const result = agentBusEnrol({ rootDir: root });
    check(
      "enrol returns the bus URL, agent id, and store path",
      result.busUrl === "http://127.0.0.1:8080" &&
        result.agentId === "bus-a.agent-1" &&
        result.name === "test-agent" &&
        result.storeFile === join(root, ".agent-bus.local") &&
        result.busFingerprint === FINGERPRINT,
    );

    const storeFile = join(root, ".agent-bus.local");
    check("enrol writes .agent-bus.local in the root", existsSync(storeFile));
    const stored = JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, unknown>;
    check(
      "store records the non-secret roster fields",
      stored.busUrl === "http://127.0.0.1:8080" &&
        stored.busFingerprint === FINGERPRINT &&
        stored.agentId === "bus-a.agent-1" &&
        stored.name === "test-agent" &&
        typeof stored.identityStore === "string" &&
        typeof stored.enrolledAt === "string",
    );

    // SECURITY: the bearer material must never be mirrored into the roster.
    const storeText = readFileSync(storeFile, "utf8");
    check("store never contains the invite bearer value", !storeText.includes(BEARER_MARKER));
    check("store carries only the expected metadata keys", (() => {
      const keys = Object.keys(stored).sort();
      return (
        JSON.stringify(keys) ===
        JSON.stringify(["agentId", "busFingerprint", "busUrl", "enrolledAt", "identityStore", "name"])
      );
    })());

    // The roster must be permission-restricted (0600 for owner read/write only).
    const storeMode = statSync(storeFile).mode & 0o777;
    check("store file mode is 0600", storeMode === 0o600);

    // Extra/unknown invite fields are forward-compatible: they are accepted and
    // never mirrored into the roster (which carries only the documented keys).
    const extraPath = join(root, "agent-bus-invite-extra.json");
    writeInvite(extraPath, { team: "infra", purpose: "ci-run", metadata: { zone: "us-east" } });
    const extraResult = agentBusEnrol({ rootDir: root, inviteFile: extraPath });
    const extraSaved = readFileSync(join(root, ".agent-bus.local"), "utf8");
    check(
      "an invite with extra fields still enrols successfully",
      extraResult.agentId === "bus-a.agent-1",
    );
    check(
      "extra invite fields are not persisted to the roster",
      !extraSaved.includes("infra") &&
        !extraSaved.includes("ci-run") &&
        !extraSaved.includes("us-east"),
    );

    // ---- validation: missing / malformed fields fail with diagnostics -----
    const missingUrl = join(root, "no-url.json");
    writeInvite(missingUrl);
    const noUrl = JSON.parse(readFileSync(missingUrl, "utf8")) as Record<string, unknown>;
    delete noUrl.url;
    writeFileSync(missingUrl, JSON.stringify(noUrl));
    const errMissingUrl = captureError(() => agentBusEnrol({ rootDir: root, inviteFile: missingUrl }));
    check(
      "missing url is rejected with an actionable message",
      /missing one or more required invite fields/i.test(errMissingUrl) && /url=no/i.test(errMissingUrl),
    );

    const missingFingerprint = join(root, "no-fingerprint.json");
    writeInvite(missingFingerprint);
    const noFp = JSON.parse(readFileSync(missingFingerprint, "utf8")) as Record<string, unknown>;
    delete noFp.fingerprint;
    writeFileSync(missingFingerprint, JSON.stringify(noFp));
    const errMissingFp = captureError(() =>
      agentBusEnrol({ rootDir: root, inviteFile: missingFingerprint }),
    );
    check(
      "missing fingerprint is rejected with an actionable message",
      /missing one or more required invite fields/i.test(errMissingFp) && /fingerprint=no/i.test(errMissingFp),
    );

    const missingBearer = join(root, "no-bearer.json");
    writeInvite(missingBearer);
    const noBearer = JSON.parse(readFileSync(missingBearer, "utf8")) as Record<string, unknown>;
    delete noBearer[BEARER_KEY];
    writeFileSync(missingBearer, JSON.stringify(noBearer));
    const errMissingBearer = captureError(() =>
      agentBusEnrol({ rootDir: root, inviteFile: missingBearer }),
    );
    check(
      "missing bearer material is rejected with an actionable message",
      /missing one or more required invite fields/i.test(errMissingBearer) && /credential=no/i.test(errMissingBearer),
    );

    const badFingerprint = join(root, "bad-fingerprint.json");
    writeInvite(badFingerprint, { fingerprint: "not-a-real-hex-fingerprint" });
    const errBadFp = captureError(() =>
      agentBusEnrol({ rootDir: root, inviteFile: badFingerprint }),
    );
    check(
      "a malformed fingerprint is rejected with a format hint",
      /64 lowercase hex/i.test(errBadFp) && /got 'not-a-/i.test(errBadFp),
    );

    const expired = join(root, "expired.json");
    writeInvite(expired, { expiresAt: "2000-01-01T00:00:00.000Z" });
    const errExpired = captureError(() => agentBusEnrol({ rootDir: root, inviteFile: expired }));
    check(
      "an expired invite is rejected with a fresh-invite hint",
      /already expired/i.test(errExpired) && /fresh invite/i.test(errExpired),
    );

    const badJSON = join(root, "bad.json");
    writeFileSync(badJSON, "{ this is not json");
    const errBadJson = captureError(() => agentBusEnrol({ rootDir: root, inviteFile: badJSON }));
    check("a malformed invite file is rejected as invalid JSON", /not valid JSON/i.test(errBadJson));

    const missingName = join(root, "no-name.json");
    writeInvite(missingName);
    const noName = JSON.parse(readFileSync(missingName, "utf8")) as Record<string, unknown>;
    delete noName.name;
    writeFileSync(missingName, JSON.stringify(noName));
    const errNoName = captureError(() =>
      agentBusEnrol({ rootDir: root, inviteFile: missingName }),
    );
    check(
      "a missing agent name is rejected with a pass-name hint",
      /no agent name supplied/i.test(errNoName),
    );

    // ---- failed enrolment never writes the roster ---------------------------
    // Validation failures must not create or overwrite `.agent-bus.local`. Use a
    // fresh root with no prior store so the assertion is unambiguous: after a
    // failed parse the file must simply not exist.
    const failRoot = mkdtempSync(join(tmpdir(), "agent-bus-failroot-"));
    const failStore = join(failRoot, ".agent-bus.local");
    writeFileSync(join(failRoot, "agent-bus-invite-fail.json"), "{ broken json");
    captureError(() => agentBusEnrol({ rootDir: failRoot, inviteFile: "agent-bus-invite-fail.json" }));
    check("a failed enrolment does not create .agent-bus.local", !existsSync(failStore));
    // A successful enrolment into that same root afterwards proves the store is
    // written only on the success path (no partial/leftover state from failures).
    // (Install a fake busctl in the fresh root so the success path completes.)
    const failBusctl = join(failRoot, "agent-busctl");
    writeFileSync(
      failBusctl,
      "#!/bin/sh\nprintf '%s\\n' '{\"agentId\":\"bus-a.agent-2\",\"name\":\"test-agent\"}'\nexit 0\n",
    );
    chmodSync(failBusctl, 0o755);
    writeInvite(join(failRoot, "agent-bus-invite-ok.json"));
    const failRootResult = agentBusEnrol({ rootDir: failRoot, inviteFile: "agent-bus-invite-ok.json" });
    check(
      "a later successful enrolment writes the roster",
      failRootResult.storeFile === failStore && existsSync(failStore),
    );

    // ---- discovery: zero or multiple invites is refused rather than guessed --
    const emptyRoot = mkdtempSync(join(tmpdir(), "agent-bus-empty-"));
    const errNoInvite = captureError(() => agentBusEnrol({ rootDir: emptyRoot }));
    check("no invite file is found, refusal names the glob", /no invite file found/i.test(errNoInvite));

    const multiRoot = mkdtempSync(join(tmpdir(), "agent-bus-multi-"));
    writeInvite(join(multiRoot, "agent-bus-invite-one.json"));
    writeInvite(join(multiRoot, "agent-bus-invite-two.json"));
    const errMulti = captureError(() => agentBusEnrol({ rootDir: multiRoot }));
    check(
      "multiple invite files require an explicit choice",
      /pass inviteFile explicitly/i.test(errMulti),
    );

    // ---- option/argument validation ----------------------------------------
    const errNonObject = captureError(() => agentBusEnrol([] as unknown as Record<string, unknown>));
    check("array options are rejected as a TypeError", /options must be an object/i.test(errNonObject));
    const errNonStringInvite = captureError(() =>
      agentBusEnrol({ rootDir: root, inviteFile: 42 as unknown as string }),
    );
    check("non-string inviteFile is rejected", /inviteFile must be a string/i.test(errNonStringInvite));

    // ---- workspace boundary & protected-store protections -------------------
    // An explicit inviteFile must resolve inside the workspace root and must
    // never name the runtime's protected data store or the roster itself.
    const outsideRoot = mkdtempSync(join(tmpdir(), "agent-bus-outside-"));
    const outsideInvite = join(outsideRoot, "agent-bus-invite-x.json");
    writeInvite(outsideInvite);
    const errOutside = captureError(() =>
      agentBusEnrol({ rootDir: root, inviteFile: outsideInvite }),
    );
    check(
      "an invite path outside the workspace root is refused",
      /outside the workspace root/i.test(errOutside),
    );

    const dataJson = join(root, "data.json");
    const errDataJson = captureError(() =>
      agentBusEnrol({ rootDir: root, inviteFile: dataJson }),
    );
    check(
      "data.json is never read as an invite file",
      /protected data store/i.test(errDataJson) && !/not valid JSON/i.test(errDataJson),
    );

    const rosterFile = join(root, ".agent-bus.local");
    const errRoster = captureError(() =>
      agentBusEnrol({ rootDir: root, inviteFile: rosterFile }),
    );
    check(
      ".agent-bus.local is never read as an invite file",
      /protected data store/i.test(errRoster),
    );

    // ---- store not exposed to the repository --------------------------------
    // The roster file is git-ignored so enrollment metadata can never be
    // accidentally committed, and the docs never embed any of the test values.
    const repoRoot = process.cwd();
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", ".agent-bus.local"], { cwd: repoRoot, stdio: "ignore" });
      ignored = true;
    } catch {
      ignored = false;
    }
    check(".agent-bus.local is git-ignored", ignored);

    const docs = ["CLAUDE.md", "tools/agent-bus-usage.md", "tools/agent-bus-enrol-usage.md"];
    let docsClean = true;
    let missingDoc = "";
    for (const doc of docs) {
      const docPath = join(repoRoot, doc);
      if (!existsSync(docPath)) {
        missingDoc = doc;
        docsClean = false;
        break;
      }
      const text = readFileSync(docPath, "utf8");
      if (text.includes(BEARER_MARKER)) {
        docsClean = false;
        break;
      }
    }
    check(`docs contain no secret material${missingDoc ? ` (missing ${missingDoc})` : ""}`, docsClean && !missingDoc);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (failures === 0) {
    console.log("\nAll AgentBusEnrol tests passed.");
    process.exit(0);
  } else {
    console.error(`\n${failures} AgentBusEnrol test(s) failed.`);
    process.exit(1);
  }
}

main();
