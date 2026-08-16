/**
 * Docker/container runtime detection.
 *
 * Detects whether the agent process is running inside a Docker (or
 * Docker-compatible) container using the two standard, widely deployed
 * signals:
 *
 * 1. The `/.dockerenv` marker file that Docker creates at the container root.
 * 2. Docker/containerd entries in `/proc/1/cgroup` (the cgroup hierarchy of
 *    PID 1), which Docker, containerd, and compatible runtimes expose.
 *
 * The detection is injectable: callers may supply a filesystem-access object so
 * tests can simulate both Docker and non-Docker hosts without touching the real
 * host. Production startup calls `detectDocker()` with no arguments and logs
 * the returned evidence.
 */

import { existsSync, readFileSync } from "node:fs";

/** Marker file Docker places at the root of a container filesystem. */
export const DOCKERENV_PATH = "/.dockerenv";

/** cgroup hierarchy file of PID 1 on Linux systems. */
export const PROC_1_CGROUP_PATH = "/proc/1/cgroup";

/**
 * Substrings of `/proc/1/cgroup` that indicate PID 1 belongs to a Docker or
 * containerd container. `docker` covers both `docker` and `docker-…` (and
 * `kubepods`-nested Docker entries that retain a docker scope), and
 * `containerd` covers containerd-managed containers.
 */
export const CONTAINER_CGROUP_MARKERS = ["docker", "containerd"] as const;

/** Result of a Docker/container detection pass. */
export interface DockerDetection {
  /** True when at least one Docker/container signal was observed. */
  readonly isDocker: boolean;
  /**
   * Human-readable evidence lines, one per observed signal. Empty when no
   * signal was observed (a non-Docker host).
   */
  readonly evidence: readonly string[];
}

/** Injectable filesystem access used by `detectDocker`. Tests supply fakes. */
export interface DockerDetectionSource {
  /** Returns true when `path` exists. Defaults to `fs.existsSync`. */
  readonly pathExists?: (path: string) => boolean;
  /** Returns the file contents, or null when unreadable. Defaults to `fs.readFileSync`. */
  readonly readTextFile?: (path: string) => string | null;
}

function defaultPathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function defaultReadTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Detect whether the current runtime is a Docker (or Docker-compatible)
 * container.
 *
 * Never throws: an unreadable cgroup file simply means that signal is absent,
 * matching the fail-safe behavior expected from startup detection.
 */
export function detectDocker(source: DockerDetectionSource = {}): DockerDetection {
  const pathExists = source.pathExists ?? defaultPathExists;
  const readTextFile = source.readTextFile ?? defaultReadTextFile;

  const evidence: string[] = [];

  if (pathExists(DOCKERENV_PATH)) {
    evidence.push(`marker file present: ${DOCKERENV_PATH}`);
  }

  const cgroup = readTextFile(PROC_1_CGROUP_PATH) ?? "";
  const markers = CONTAINER_CGROUP_MARKERS.filter((marker) => cgroup.includes(marker));
  if (markers.length > 0) {
    evidence.push(
      `cgroup entries match container markers (${markers.join(", ")}) in ${PROC_1_CGROUP_PATH}`,
    );
  }

  return { isDocker: evidence.length > 0, evidence };
}

/** One-line, human-readable description of a detection result for startup logs. */
export function describeDockerDetection(detection: DockerDetection): string {
  if (detection.isDocker) {
    return `Docker/container runtime detected: ${detection.evidence.join("; ")}.`;
  }
  return `Docker/container runtime not detected (no ${DOCKERENV_PATH} marker and no docker/containerd entries in ${PROC_1_CGROUP_PATH}).`;
}
