// Focused fixtures for the NEW-TOOLS-2026-09-06 dedicated tool suite.
// Compiled and executed standalone by the `test:new-tools` npm script.
//
// Process-spawning tools are exercised through a patched child_process.spawn
// so the exact argv can be asserted deterministically without depending on
// npm/go/tsc binaries or on the sandbox runtime. Non-process tools
// (GetWorkingDirectory, PathInfo, FileHash, FileOps, Help) run against real
// temporary filesystem fixtures.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import GetWorkingDirectory from "../tools/GetWorkingDirectory.js";
import FileHash from "../tools/FileHash.js";
import FileOps from "../tools/FileOps.js";
import GoToolchain from "../tools/GoToolchain.js";
import Help from "../tools/Help.js";
import PathInfo from "../tools/PathInfo.js";
import RunNodeTest from "../tools/RunNodeTest.js";
import RunPackageScript from "../tools/RunPackageScript.js";
import RunScript from "../tools/RunScript.js";
import TypeCheck from "../tools/TypeCheck.js";

// Use CommonJS require directly so the patched `spawn` is visible to
// process-runner.ts, which compiles to `const child_process_1 = require(...)`.
const childProcess = require("node:child_process") as typeof import("node:child_process");

interface SpawnCall {
    command: string;
    args: string[];
}

const spawnCalls: SpawnCall[] = [];
let originalSpawn: typeof childProcess.spawn | undefined;

function installFakeSpawn(stdout = "", stderr = "", exitCode = 0): void {
    spawnCalls.length = 0;
    originalSpawn = childProcess.spawn;
    (childProcess as unknown as {
        spawn: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
    }).spawn = (command: string, args: string[] = []) => {
        spawnCalls.push({ command, args: [...args] });
        const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            pid: undefined;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = undefined;
        setImmediate(() => {
            if (stdout) child.stdout.emit("data", Buffer.from(stdout));
            if (stderr) child.stderr.emit("data", Buffer.from(stderr));
            child.emit("close", exitCode, null);
        });
        return child;
    };
}

function restoreSpawn(): void {
    if (originalSpawn !== undefined) {
        (childProcess as unknown as { spawn: typeof childProcess.spawn }).spawn = originalSpawn;
        originalSpawn = undefined;
    }
}

let failures = 0;
function check(name: string, cond: boolean): void {
    if (cond) console.log(`PASS: ${name}`);
    else {
        failures += 1;
        console.error(`FAIL: ${name}`);
    }
}

function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

async function throwsTypeError(name: string, call: () => Promise<unknown>): Promise<void> {
    let threw = false;
    try {
        await call();
    } catch (error) {
        threw = error instanceof TypeError;
    }
    check(name, threw);
}

async function throwsMessage(name: string, pattern: RegExp, call: () => Promise<unknown>): Promise<void> {
    let threw = false;
    try {
        await call();
    } catch (error) {
        threw = error instanceof Error && pattern.test(error.message);
    }
    check(name, threw);
}

function trusted(cwd: string): { mode: "trusted-host"; writableRoots: string[]; readableRoots: string[] } {
    return { mode: "trusted-host", writableRoots: [cwd], readableRoots: [] };
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "new-tools-test-"));
    try {
        const pkgDir = join(dir, "pkg");
        await mkdir(pkgDir);
        await writeFile(
            join(pkgDir, "package.json"),
            JSON.stringify({ scripts: { ok: 'node -e ""', "with-args": 'node -e ""' } }),
            "utf8",
        );
        const file = join(dir, "sample.txt");
        await writeFile(file, "hello\n", "utf8");
        const srcFile = join(dir, "src.txt");
        await writeFile(srcFile, "data", "utf8");

        // ------------------------------------------------------------------
        // RunPackageScript: validation and literal npm argv construction.
        // ------------------------------------------------------------------
        await throwsTypeError(
            "RunPackageScript rejects an undeclared script",
            () => RunPackageScript({ script: "missing", cwd: pkgDir, policy: trusted(pkgDir) }),
        );
        await throwsTypeError(
            "RunPackageScript rejects a dash-prefixed script",
            () => RunPackageScript({ script: "--version", cwd: pkgDir, policy: trusted(pkgDir) }),
        );

        installFakeSpawn("", "", 0);
        const pkg = await RunPackageScript({ script: "ok", cwd: pkgDir, policy: trusted(pkgDir) });
        check("RunPackageScript returns the declared script", pkg.script === "ok");
        check(
            "RunPackageScript builds npm run <script>",
            sameArgs(pkg.command, ["npm", "run", "ok"]),
        );
        check(
            "RunPackageScript spawns npm with literal argv",
            spawnCalls.length === 1 &&
                spawnCalls[0].command === "npm" &&
                sameArgs(spawnCalls[0].args, ["run", "ok"]),
        );
        restoreSpawn();

        installFakeSpawn("", "", 0);
        const pkgArgs = await RunPackageScript({
            script: "with-args",
            args: ["a", "b"],
            cwd: pkgDir,
            policy: trusted(pkgDir),
        });
        check(
            "RunPackageScript appends -- before positional args",
            sameArgs(pkgArgs.command, ["npm", "run", "with-args", "--", "a", "b"]),
        );
        check(
            "RunPackageScript passes args as literal spawn argv",
            spawnCalls.length === 1 &&
                spawnCalls[0].command === "npm" &&
                sameArgs(spawnCalls[0].args, ["run", "with-args", "--", "a", "b"]),
        );
        restoreSpawn();

        // ------------------------------------------------------------------
        // TypeCheck: validation and fixed tsc argv construction.
        // ------------------------------------------------------------------
        await throwsTypeError(
            "TypeCheck rejects files and tsconfig together",
            () => TypeCheck({ files: ["a.ts"], tsconfig: "tsconfig.json", cwd: dir, policy: trusted(dir) }),
        );
        await throwsTypeError(
            "TypeCheck rejects leading-dash files",
            () => TypeCheck({ files: ["-a.ts"], cwd: dir, policy: trusted(dir) }),
        );

        installFakeSpawn("", "", 0);
        const tsc = await TypeCheck({ files: ["a.ts", "b.ts"], cwd: dir, policy: trusted(dir) });
        check("TypeCheck returns the compiled files", sameArgs(tsc.files, ["a.ts", "b.ts"]));
        check(
            "TypeCheck defaults to --noEmit with the fixed tsc flag set",
            spawnCalls.length === 1 &&
                spawnCalls[0].command === "tsc" &&
                sameArgs(spawnCalls[0].args, [
                    "--noEmit",
                    "--target",
                    "es2022",
                    "--module",
                    "nodenext",
                    "--moduleResolution",
                    "nodenext",
                    "--skipLibCheck",
                    "--types",
                    "node",
                    "a.ts",
                    "b.ts",
                ]),
        );
        restoreSpawn();

        // ------------------------------------------------------------------
        // GoToolchain: whitelist and literal go argv construction.
        // ------------------------------------------------------------------
        await throwsTypeError(
            "GoToolchain rejects an invalid action",
            () =>
                GoToolchain({
                    action: "run" as unknown as Parameters<typeof GoToolchain>[0]["action"],
                    cwd: dir,
                    policy: trusted(dir),
                }),
        );
        await throwsTypeError(
            "GoToolchain rejects race outside test",
            () => GoToolchain({ action: "build", race: true, cwd: dir, policy: trusted(dir) }),
        );
        await throwsTypeError(
            "GoToolchain rejects run outside test",
            () => GoToolchain({ action: "vet", run: "x", cwd: dir, policy: trusted(dir) }),
        );
        await throwsTypeError(
            "GoToolchain rejects unsafe package patterns",
            () =>
                GoToolchain({
                    action: "build",
                    packages: ["./x|y"],
                    cwd: dir,
                    policy: trusted(dir),
                }),
        );

        installFakeSpawn("", "", 0);
        const goBuild = await GoToolchain({
            action: "build",
            packages: ["./internal/..."],
            cwd: dir,
            policy: trusted(dir),
        });
        check(
            "GoToolchain accepts build and builds go argv",
            goBuild.action === "build" &&
                spawnCalls.length === 1 &&
                spawnCalls[0].command === "go" &&
                sameArgs(spawnCalls[0].args, ["build", "./internal/..."]),
        );
        restoreSpawn();

        installFakeSpawn("", "", 0);
        const goTest = await GoToolchain({
            action: "test",
            packages: ["./..."],
            race: true,
            run: "TestFoo",
            cwd: dir,
            policy: trusted(dir),
        });
        check(
            "GoToolchain maps race and run only for test",
            goTest.action === "test" &&
                spawnCalls.length === 1 &&
                spawnCalls[0].command === "go" &&
                sameArgs(spawnCalls[0].args, ["test", "-race", "-run", "TestFoo", "./..."]),
        );
        restoreSpawn();

        installFakeSpawn("", "", 0);
        const goFmt = await GoToolchain({
            action: "fmt",
            packages: ["./..."],
            cwd: dir,
            policy: trusted(dir),
        });
        check(
            "GoToolchain builds go fmt argv",
            goFmt.action === "fmt" &&
                spawnCalls.length === 1 &&
                spawnCalls[0].command === "go" &&
                sameArgs(spawnCalls[0].args, ["fmt", "./..."]),
        );
        restoreSpawn();

        installFakeSpawn("", "", 0);
        const goVersion = await GoToolchain({ action: "version", cwd: dir, policy: trusted(dir) });
        check(
            "GoToolchain builds go version argv",
            goVersion.action === "version" &&
                spawnCalls.length === 1 &&
                spawnCalls[0].command === "go" &&
                sameArgs(spawnCalls[0].args, ["version"]),
        );
        restoreSpawn();

        // ------------------------------------------------------------------
        // GetWorkingDirectory: cwd/realCwd reporting.
        // ------------------------------------------------------------------
        const gwd = await GetWorkingDirectory({});
        check("GetWorkingDirectory returns cwd", gwd.cwd === process.cwd());
        check(
            "GetWorkingDirectory resolves realCwd",
            gwd.realCwd === (await realpath(process.cwd())),
        );
        const gwdRaw = await GetWorkingDirectory({ resolve: false });
        check(
            "GetWorkingDirectory skips realpath when resolve is false",
            gwdRaw.cwd === process.cwd() && gwdRaw.realCwd === process.cwd(),
        );
        await throwsTypeError(
            "GetWorkingDirectory rejects a non-boolean resolve",
            () => GetWorkingDirectory({ resolve: "yes" as unknown as boolean }),
        );

        // ------------------------------------------------------------------
        // PathInfo: metadata reporting and action validation.
        // ------------------------------------------------------------------
        const sampleStats = await stat(file);
        const info = await PathInfo({ path: file });
        check(
            "PathInfo stat reports a file",
            info.exists === true && info.type === "file",
        );
        check("PathInfo stat reports size", info.size === sampleStats.size);
        check("PathInfo stat reports octal mode", info.mode === sampleStats.mode.toString(8));
        check(
            "PathInfo stat reports an ISO mtime",
            typeof info.mtime === "string" && !Number.isNaN(Date.parse(info.mtime)),
        );
        const missingInfo = await PathInfo({ path: join(dir, "missing.txt") });
        check("PathInfo reports exists false for a missing path", missingInfo.exists === false);
        await throwsTypeError(
            "PathInfo rejects an invalid action",
            () =>
                PathInfo({
                    path: file,
                    action: "chmod" as unknown as Parameters<typeof PathInfo>[0]["action"],
                }),
        );

        // ------------------------------------------------------------------
        // FileHash: digest reporting and algorithm validation.
        // ------------------------------------------------------------------
        const sha256Expected = createHash("sha256").update("hello\n").digest("hex");
        const hash = await FileHash({ path: file });
        check("FileHash defaults to sha256", hash.algorithm === "sha256");
        check("FileHash returns the correct digest", hash.hash === sha256Expected);
        check("FileHash returns the file size", hash.size === 6);
        const sha1Expected = createHash("sha1").update("hello\n").digest("hex");
        const sha1 = await FileHash({ path: file, algorithm: "sha1" });
        check(
            "FileHash honors the requested algorithm",
            sha1.algorithm === "sha1" && sha1.hash === sha1Expected,
        );
        await throwsTypeError(
            "FileHash rejects an unsupported algorithm",
            () => FileHash({ path: file, algorithm: "md5" }),
        );

        // ------------------------------------------------------------------
        // FileOps: action/path/mode validation and symlink-destination rules.
        // ------------------------------------------------------------------
        const touchPath = join(dir, "touched.txt");
        const touch = await FileOps({ action: "touch", path: touchPath });
        check(
            "FileOps touch returns the action and path",
            touch.action === "touch" && touch.path === touchPath,
        );
        check("FileOps touch creates the file", (await stat(touchPath)).isFile());

        const copyDest = join(dir, "copy.txt");
        const copied = await FileOps({ action: "copy", source: srcFile, destination: copyDest });
        check(
            "FileOps copy returns source and destination",
            copied.action === "copy" && copied.source === srcFile && copied.destination === copyDest,
        );
        check(
            "FileOps copy writes the destination",
            (await readFile(copyDest, "utf8")) === "data",
        );

        const moveDest = join(dir, "moved.txt");
        const moved = await FileOps({ action: "move", source: copyDest, destination: moveDest });
        check(
            "FileOps move returns source and destination",
            moved.action === "move" && moved.source === copyDest && moved.destination === moveDest,
        );
        check("FileOps move removes the source", !(await exists(copyDest)));
        check(
            "FileOps move writes the destination",
            (await readFile(moveDest, "utf8")) === "data",
        );

        const chmodResult = await FileOps({ action: "chmod", path: touchPath, mode: "600" });
        check(
            "FileOps chmod returns the mode",
            chmodResult.action === "chmod" && chmodResult.mode === "600",
        );
        check(
            "FileOps chmod applies the mode",
            ((await stat(touchPath)).mode & 0o777) === 0o600,
        );

        const symlinkPath = join(dir, "link.txt");
        const symlinkResult = await FileOps({
            action: "symlink",
            source: srcFile,
            destination: symlinkPath,
        });
        check(
            "FileOps symlink returns source and destination",
            symlinkResult.action === "symlink" &&
                symlinkResult.source === srcFile &&
                symlinkResult.destination === symlinkPath,
        );
        check("FileOps symlink creates a symlink", (await lstat(symlinkPath)).isSymbolicLink());

        await throwsTypeError(
            "FileOps rejects an invalid action",
            () => FileOps({ action: "rm" as unknown as Parameters<typeof FileOps>[0]["action"] }),
        );
        await throwsTypeError(
            "FileOps copy requires source",
            () => FileOps({ action: "copy", destination: copyDest }),
        );
        await throwsTypeError(
            "FileOps chmod rejects an invalid mode",
            () => FileOps({ action: "chmod", path: touchPath, mode: "rwx" }),
        );

        const symlinkDest = join(dir, "symlink-dest.txt");
        await symlink(srcFile, symlinkDest);
        await throwsMessage(
            "FileOps copy rejects a symlink destination",
            /symlink destination/,
            () => FileOps({ action: "copy", source: srcFile, destination: symlinkDest }),
        );
        await throwsMessage(
            "FileOps touch rejects a symlink destination",
            /symlink destination/,
            () => FileOps({ action: "touch", path: symlinkDest }),
        );

        // ------------------------------------------------------------------
        // Help: kebab-case usage-file resolution and agent-busctl reference.
        // ------------------------------------------------------------------
        const help = await Help({ subject: "RunPackageScript" });
        check(
            "Help resolves PascalCase to a kebab-case usage file",
            help.source === "tools/run-package-script-usage.md",
        );
        check(
            "Help returns usage content",
            help.content.includes("# RunPackageScript tool usage"),
        );
        const typeHelp = await Help({ subject: "TypeCheck" });
        check(
            "Help resolves TypeCheck usage file",
            typeHelp.source === "tools/type-check-usage.md" &&
                typeHelp.content.includes("# TypeCheck tool usage"),
        );
        const bus = await Help({ subject: "agent-busctl" });
        check(
            "Help returns the built-in agent-busctl reference",
            bus.source === undefined &&
                bus.content.includes("agent-busctl reference") &&
                bus.content.includes("AgentBusEnrol"),
        );
        const busSub = await Help({ subject: "agent-busctl:whoami" });
        check(
            "Help returns the agent-busctl reference for subcommands",
            busSub.source === undefined &&
                busSub.subject === "agent-busctl:whoami" &&
                busSub.content.includes("agent-busctl reference"),
        );
        await throwsTypeError(
            "Help rejects an empty subject",
            () => Help({ subject: "   " }),
        );

        // ------------------------------------------------------------------
        // RunScript: file validation and node argv construction.
        // ------------------------------------------------------------------
        await throwsTypeError(
            "RunScript rejects a non-js extension",
            () => RunScript({ file: "script.txt", cwd: dir, policy: trusted(dir) }),
        );
        await throwsTypeError(
            "RunScript rejects a leading-dash file",
            () => RunScript({ file: "-script.js", cwd: dir, policy: trusted(dir) }),
        );

        installFakeSpawn("", "", 0);
        const run = await RunScript({
            file: "script.js",
            args: ["a", "b"],
            cwd: dir,
            policy: trusted(dir),
        });
        check("RunScript returns the script file", run.file === "script.js");
        check(
            "RunScript builds node argv",
            spawnCalls.length === 1 &&
                spawnCalls[0].command === "node" &&
                sameArgs(spawnCalls[0].args, ["script.js", "a", "b"]),
        );
        restoreSpawn();

        // ------------------------------------------------------------------
        // RunNodeTest: file validation and node --test argv construction.
        // ------------------------------------------------------------------
        await throwsTypeError(
            "RunNodeTest rejects empty files",
            () => RunNodeTest({ files: [], cwd: dir, policy: trusted(dir) }),
        );
        await throwsTypeError(
            "RunNodeTest rejects leading-dash files",
            () => RunNodeTest({ files: ["-a.test.js"], cwd: dir, policy: trusted(dir) }),
        );

        installFakeSpawn("", "", 0);
        const nodeTest = await RunNodeTest({
            files: ["a.test.js", "b.test.js"],
            cwd: dir,
            policy: trusted(dir),
        });
        check(
            "RunNodeTest returns the test files",
            sameArgs(nodeTest.files, ["a.test.js", "b.test.js"]),
        );
        check(
            "RunNodeTest builds node --test argv",
            spawnCalls.length === 1 &&
                spawnCalls[0].command === "node" &&
                sameArgs(spawnCalls[0].args, ["--test", "a.test.js", "b.test.js"]),
        );
        restoreSpawn();
    } finally {
        restoreSpawn();
        await rm(dir, { recursive: true, force: true });
    }

    if (failures === 0) {
        console.log("\nAll new-tools tests passed.");
        process.exit(0);
    } else {
        console.error(`\n${failures} new-tools test(s) failed.`);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("new-tools test harness crashed:", error);
    process.exit(1);
});
