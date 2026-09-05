// CLI parsing/help subprocess tests for --planner-model.
//
// These run the built CLI (`dist/main.js`) without performing any LLM work:
//   - `--help` prints the registered flag and exits 0.
//   - a blank `--planner-model` (both `--planner-model ""` and `--planner-model=`)
//     exits 1 with the actionable planner-model error.
//
// Requires the CLI to be built first:
//   npm run build && node test/planner-model-cli.test.js
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const distMain = resolve(__dirname, "..", "dist", "main.js");

let failures = 0;
function check(name, cond) {
    if (cond) {
        console.log(`PASS: ${name}`);
    } else {
        console.error(`FAIL: ${name}`);
        failures += 1;
    }
}

const help = spawnSync(process.execPath, [distMain, "--help"], { encoding: "utf-8" });
check("--help exits 0", help.status === 0);
check(
    "--help registers --planner-model",
    help.status === 0 && /--planner-model <model-id>/.test(help.stdout || ""),
);
check(
    "--help describes the planner-model override",
    help.status === 0 && /planner model/i.test(help.stdout || ""),
);

const blankSpace = spawnSync(process.execPath, [distMain, "--planner-model", ""], {
    encoding: "utf-8",
});
check("blank --planner-model exits 1", blankSpace.status === 1);
check(
    "blank --planner-model prints a clear error",
    /--planner-model requires a non-empty model ID/.test(blankSpace.stderr || ""),
);

const blankEquals = spawnSync(process.execPath, [distMain, "--planner-model="], {
    encoding: "utf-8",
});
check("blank --planner-model= exits 1", blankEquals.status === 1);
check(
    "blank --planner-model= prints a clear error",
    /--planner-model requires a non-empty model ID/.test(blankEquals.stderr || ""),
);

if (failures > 0) {
    console.error(`${failures} planner-model CLI test(s) failed.`);
    process.exit(1);
}
console.log("Planner model CLI help/parse tests passed.");
