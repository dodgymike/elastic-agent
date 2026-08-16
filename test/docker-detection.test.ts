// Unit tests for docker-detection.ts: the startup Docker/container detection
// helper. Detection is injectable through DockerDetectionSource, so tests can
// exercise both Docker and non-Docker hosts deterministically without touching
// the real host filesystem.
// Compiled and executed standalone by the `test:docker-detection` npm script.
import assert from "node:assert/strict";
import {
  CONTAINER_CGROUP_MARKERS,
  DOCKERENV_PATH,
  PROC_1_CGROUP_PATH,
  describeDockerDetection,
  detectDocker,
  type DockerDetection,
  type DockerDetectionSource,
} from "../docker-detection.js";

/** A host with neither the /.dockerenv marker nor container cgroup entries. */
const nonDockerSource: DockerDetectionSource = {
  pathExists: () => false,
  readTextFile: () => null,
};

/** A source that only reports the presence/absence of /.dockerenv. */
function dockerenvSource(present: boolean): DockerDetectionSource {
  return {
    pathExists: (path: string) => present && path === DOCKERENV_PATH,
    readTextFile: () => null,
  };
}

/** A source with a fixed PID-1 cgroup file and no /.dockerenv marker. */
function cgroupSource(cgroup: string): DockerDetectionSource {
  return {
    pathExists: () => false,
    readTextFile: (path: string) => (path === PROC_1_CGROUP_PATH ? cgroup : null),
  };
}

function containsEvidence(detection: DockerDetection, substring: string): boolean {
  return detection.evidence.some((line) => line.includes(substring));
}

// Path constants stay the standard, widely deployed Docker signals.
assert.equal(DOCKERENV_PATH, "/.dockerenv");
assert.equal(PROC_1_CGROUP_PATH, "/proc/1/cgroup");
assert.deepEqual(CONTAINER_CGROUP_MARKERS, ["docker", "containerd"]);

// Negative: no marker and no cgroup matches.
{
  const detection = detectDocker(nonDockerSource);
  assert.equal(detection.isDocker, false);
  assert.deepEqual(detection.evidence, []);
}

// Negative: a plain host cgroup without docker/containerd entries.
{
  const hostCgroup = [
    "0::/init.scope",
    "1:name=systemd:/system.slice/sshd.service",
    "2:cpu,cpuacct:/user.slice/user-1000.slice/session-1.scope",
  ].join("\n");
  const detection = detectDocker(cgroupSource(hostCgroup));
  assert.equal(detection.isDocker, false);
  assert.deepEqual(detection.evidence, []);
}

// Negative: a cgroup that merely mentions a host service named "dockerd"
// is still a match for the documented "docker" marker, so instead prove the
// false branch with a totally unrelated service list.
{
  const detection = detectDocker(cgroupSource("0::/init.scope\n1:name=systemd:/system.slice/nginx.service\n"));
  assert.equal(detection.isDocker, false);
}

// Positive: the /.dockerenv marker file alone triggers detection.
{
  const detection = detectDocker(dockerenvSource(true));
  assert.equal(detection.isDocker, true);
  assert.equal(detection.evidence.length, 1);
  assert.ok(containsEvidence(detection, "marker file present"));
  assert.ok(containsEvidence(detection, DOCKERENV_PATH));
}

// Positive: a Docker cgroup entry alone triggers detection.
{
  const detection = detectDocker(cgroupSource("0::/system.slice/docker-abc123.scope\n"));
  assert.equal(detection.isDocker, true);
  assert.equal(detection.evidence.length, 1);
  assert.ok(containsEvidence(detection, "cgroup entries match container markers"));
  assert.ok(containsEvidence(detection, "docker"));
}

// Positive: a containerd cgroup entry triggers the same detection.
{
  const detection = detectDocker(cgroupSource("1:name=systemd:/system.slice/containerd.service\n"));
  assert.equal(detection.isDocker, true);
  assert.ok(containsEvidence(detection, "containerd"));
}

// Positive: kubepods-nested Docker entries retain a docker scope.
{
  const detection = detectDocker(cgroupSource("0::/kubepods/burstable/pod-123/docker-456.scope\n"));
  assert.equal(detection.isDocker, true);
  assert.ok(containsEvidence(detection, "docker"));
}

// Positive: both signals produce two evidence lines.
{
  const detection = detectDocker({
    pathExists: (path: string) => path === DOCKERENV_PATH,
    readTextFile: (path: string) =>
      path === PROC_1_CGROUP_PATH ? "0::/system.slice/docker-abc123.scope\n" : null,
  });
  assert.equal(detection.isDocker, true);
  assert.equal(detection.evidence.length, 2);
}

// describeDockerDetection reports a clear positive line with the evidence.
assert.match(
  describeDockerDetection({ isDocker: true, evidence: ["marker file present: /.dockerenv"] }),
  /Docker\/container runtime detected/,
);
assert.match(
  describeDockerDetection({ isDocker: true, evidence: ["marker file present: /.dockerenv"] }),
  /marker file present/,
);

// describeDockerDetection reports a clear negative line for a non-Docker host.
const notDetected = describeDockerDetection({ isDocker: false, evidence: [] });
assert.match(notDetected, /not detected/);
assert.match(notDetected, /no \/\.dockerenv marker and no docker\/containerd entries/);

// Production smoke test: detectDocker() with the real host never throws and
// always returns a boolean plus an evidence array. The actual true/false value
// depends on the host, so only the shape is asserted.
{
  const real = detectDocker();
  assert.equal(typeof real.isDocker, "boolean");
  assert.ok(Array.isArray(real.evidence));
  assert.ok(describeDockerDetection(real).length > 0);
}

console.log("Docker detection tests passed.");
