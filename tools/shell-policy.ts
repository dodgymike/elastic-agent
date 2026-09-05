import { protectedPathComponent as protectedName } from "./path-privacy.js";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface ShellPolicy {
  readonly mode: "sandbox" | "trusted-host";
  readonly writableRoots: readonly string[];
  readonly readableRoots: readonly string[];
}
export function shellModeFromEnvironment(env: NodeJS.ProcessEnv = process.env): ShellPolicy["mode"] {
  const mode = env.AGENT_SHELL_MODE ?? "sandbox";
  if (mode !== "sandbox" && mode !== "trusted-host") throw new Error("AGENT_SHELL_MODE must be sandbox or trusted-host.");
  return mode;
}
export function shellEnvironment(): NodeJS.ProcessEnv {
  // Never inherit provider credentials, proxy settings, NODE_OPTIONS, BASH_ENV,
  // loader overrides, or tools/configuration from the user's home directory.
  return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8" };
}

function under(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/** Build a minimal Linux mount namespace. No host /home, /run, /proc or /tmp
 * is mounted. Workspace secrets and git/agent configuration are masked.
 * Mounts are operator-authorized roots, not paths selected by the model.
 */
export function sandboxArguments(policy: ShellPolicy, cwd: string, command: string, parameters: readonly string[]): string[] {
  if (process.platform !== "linux") throw new Error("Shell sandbox requires Linux bubblewrap; no host fallback is performed.");
  const roots = [...new Set([...policy.readableRoots, ...policy.writableRoots].map((root) => realpathSync(root)))];
  const writes = policy.writableRoots.map((root) => realpathSync(root));
  const actualCwd = realpathSync(cwd);
  if (!roots.some((root) => under(actualCwd, root))) throw new Error("Shell cwd is outside configured roots.");
  const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];
  for (const dir of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    if (existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc");
  for (const file of ["/etc/ld.so.cache", "/etc/alternatives"]) {
    if (existsSync(file)) args.push("--ro-bind", file, file);
  }
  const masked: { path: string; directory: boolean }[] = [];
  const files: { path: string; inode: string }[] = [];
  const protectedInodes = new Set<string>();
  let visited = 0;
  const scan = (path: string) => {
    if (++visited > 200_000) throw new Error("Workspace is too large to inspect safely for shell mounts.");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (protectedName.test(path.slice(path.lastIndexOf(sep) + 1))) {
        const target = realpathSync(path);
        if (roots.some((root) => under(target, root))) {
          const targetStat = lstatSync(target);
          masked.push({ path: target, directory: targetStat.isDirectory() });
          scanProtected(target);
        }
      }
      return; // Other external targets are unavailable unless separately mounted.
    }
    const inode = `${stat.dev}:${stat.ino}`;
    if (protectedName.test(path.slice(path.lastIndexOf(sep) + 1))) {
      masked.push({ path, directory: stat.isDirectory() });
      if (stat.isFile()) protectedInodes.add(inode);
      // Inspect protected directory files too, to identify hardlink aliases.
      if (stat.isDirectory()) for (const name of readdirSync(path)) scanProtected(join(path, name));
      return;
    }
    if (stat.isDirectory()) for (const name of readdirSync(path)) scan(join(path, name));
    else if (stat.isFile()) files.push({ path, inode });
    else throw new Error("Shell workspace contains an unsupported special file.");
  };
  const scanProtected = (path: string) => {
    if (++visited > 200_000) throw new Error("Workspace is too large to inspect safely for shell mounts.");
    const stat = lstatSync(path);
    if (stat.isFile()) protectedInodes.add(`${stat.dev}:${stat.ino}`);
    else if (stat.isDirectory()) for (const name of readdirSync(path)) scanProtected(join(path, name));
  };
  // Parent mounts first. A nested read-only root can narrow an outer write mount.
  for (const root of roots.sort((a, b) => a.length - b.length)) {
    if (root === "/" || ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/proc", "/dev", "/etc", "/tmp"].some((system) => root === system || under(system, root))) {
      throw new Error("Shell workspace cannot expose a host/system root.");
    }
    args.push(writes.includes(root) ? "--bind" : "--ro-bind", root, root);
    scan(root);
  }
  for (const file of files) if (protectedInodes.has(file.inode)) masked.push({ path: file.path, directory: false });
  const hidden = new Set<string>();
  for (const entry of masked.sort((a, b) => a.path.length - b.path.length)) {
    if ([...hidden].some((root) => under(entry.path, root))) continue;
    if (entry.directory) args.push("--tmpfs", entry.path, "--remount-ro", entry.path);
    else args.push("--ro-bind", "/dev/null", entry.path);
    hidden.add(entry.path);
  }
  for (const [name, value] of Object.entries(shellEnvironment())) args.push("--setenv", name, value!);
  args.push("--chdir", actualCwd, "--", "/bin/bash", "--noprofile", "--norc", "-c", command, "--", ...parameters);
  return args;
}
