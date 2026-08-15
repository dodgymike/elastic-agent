import { createRuntimeLlmAdapter, resolveRuntimeLlmModel } from "./llm/application.js";
import { selectCliProvider } from "./llm/cli-provider-selection.js";
import { resolveCliRunMode } from "./cli-task-mode.js";
import { MultiTurnLlmRuntime } from "./llm/multi-turn-runtime.js";
import { determinePlanningNecessity, selectExecutionMode } from "./llm/planning-necessity.js";
import { buildPrettyStepLines } from "./step-renderer.js";
import { responseDisplayText, wrapResponseText } from "./response-format.js";
import { extractPlanJson, indent, planStepsFromObject, printPlan } from "./plan-printer.js";
import { ensureWorktree, stageAllInWorktree, cleanupWorktree, commitInWorktree, mergeWorktreeIntoMain, stagedChangesSummary, committedChangesSummary } from "./worktree.js";
import chalk from "chalk";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import Write from "./tools/Write.ts";
import Read from "./tools/Read.ts";
import FileSize from "./tools/FileSize.ts";
import Edit from "./tools/Edit.ts";
import ListDirectory from "./tools/ListDirectory.ts";
import Http from "./tools/Http.ts";
import HttpRequest from "./tools/HttpRequest.ts";
import Git from "./tools/Git.tsx";
import { executeCommand as ExecuteCommand } from "./tools/ExecuteCommand.ts";
import AgentBus from "./tools/AgentBus.ts";
import SpecKeeper from "./tools/SpecKeeper.ts";
import SpecKeeperEnroll from "./tools/SpecKeeperEnroll.ts";
import {
  syncSpecKeeperEpic,
  updateEpicWithPlan,
  syncSpecKeeperTask,
  updateSpecKeeperTask,
  updateTaskStatus,
  updateEpicStatus,
  syncPlanStepTasks,
  epicIdentifier,
} from "./specKeeperFlow.ts";
import { resolveSpecKeeperDefaults, describeSpecKeeperDefaults } from "./specKeeperConfig.ts";
import { Command } from "commander";

const program = new Command();
program
    .name("elastic-agent")
    .description("Plan and execute a prompt with the selected LLM provider.")
    .argument("[prompt]", "task or request to plan and execute (omit when using --task-id)")
    .option("--task-id <task-id>", "run task mode for an existing Spec Keeper task ID (task key or public_id); cannot be combined with <prompt>")
    .option("--provider <provider-id>", "LLM provider: openai, bedrock-claude, or deepseek-v4 (overrides LLM_PROVIDER)")
    .option("--review", "Run the review stage after execution (default: false)", false)
    .addHelpText("after", `
Provider selection:
  --provider <provider-id> takes precedence over LLM_PROVIDER.
  Set one of them to openai, bedrock-claude, or deepseek-v4.

Selected-provider configuration:
  openai          OPENAI_API_KEY [OPENAI_MODEL]
  bedrock-claude  AWS_REGION or AWS_DEFAULT_REGION plus AWS credentials [BEDROCK_CLAUDE_MODEL]
  deepseek-v4     DEEPSEEK_API_KEY [DEEPSEEK_MODEL]

Credentials must be supplied through the runtime environment or secret manager, never command-line arguments or source control.
`);
program.parse(process.argv);
const options = program.opts();
const commandLinePrompt = program.args[0];
let runMode: ReturnType<typeof resolveCliRunMode>;
try {
    runMode = resolveCliRunMode(options.taskId, commandLinePrompt);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
if (runMode.mode === "task") {
    // Task mode argument rules are enforced here. Task fetching, claiming, and
    // execution are wired in later plan steps; until then, reject task mode
    // explicitly instead of falling through to prompt mode with no prompt.
    console.error("Spec Keeper task mode is not implemented yet. --task-id is recognized, but task execution is wired in a later step.");
    process.exit(1);
}
const commitInstruction = options.review ? "do not commit" : "commit all of your work";
const providerSelection = selectCliProvider(process.argv.slice(2));

const modelConfiguration = resolveRuntimeLlmModel({ configuration: providerSelection.configuration });
let client: MultiTurnLlmRuntime;
const claudeInstructions = readFileSync("CLAUDE.md", "utf-8");
const dataFilename = "/tmp/data.json";
const memoryFilename = process.env.ELASTIC_AGENT_MEMORY_PATH ?? "/tmp/elastic-agent-memory.json";
const historyLimit = 10;
const maxReplanAttempts = 3;
const maxReviewAttempts = 3;
const maxRevisedPlanSteps = 50;
// Execution worktree: plan steps stage their changes in a dedicated worktree
// (git add --all) and never commit. The worktree is kept alive across review
// attempts so the review step can inspect the staged changes before committing.
const executionWorktreeBranch = "review-worktree";
const mainCwd = process.cwd();
let executionWorktreePath: string | null = null;
let inExecutionPhase = false;
// Prompts are loaded from external files under /elastic-agent/prompts/
// (relative to the process working directory, which is the repository root).
const planningSuffix = readFileSync("prompts/planning-suffix.txt", "utf-8");
const executionFeedbackFormat = readFileSync("prompts/execution-feedback-format.txt", "utf-8");
const buildPromptTemplate = readFileSync("prompts/build-prompt-skeleton.txt", "utf-8");
const stepExecutionPromptTemplate = readFileSync("prompts/step-execution-prompt.txt", "utf-8");
const replanPromptTemplate = readFileSync("prompts/replan-prompt.txt", "utf-8");
const reviewPromptTemplate = readFileSync("prompts/review-prompt.txt", "utf-8");

/**
 * Print one status line through `write`, applying `prefix` before the chalk
 * label on the first line and before every continuation line. This keeps
 * multi-line messages (for example RESPONSE summaries containing several text
 * responses) aligned under their label without changing the message text.
 */
function printStatusLine(write: (line: string) => void, label: string, message: string, prefix = ""): void {
    const lines = String(message).split("\n");
    write(lines[0].length > 0 ? `${prefix}${label} ${lines[0]}` : `${prefix}${label}`);
    for (let index = 1; index < lines.length; index += 1) write(`${prefix}${lines[index]}`);
}

const status = {
    planning: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.cyan.bold("[PLAN]"), message, prefix),
    step: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.yellow.bold("[STEP]"), message, prefix),
    tool: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.blue.bold("[TOOL]"), message, prefix),
    response: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.gray("[RESPONSE]"), message, prefix),
    success: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.green.bold("[SUCCESS]"), message, prefix),
    feedback: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.magenta.bold("[FEEDBACK]"), message, prefix),
    change: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.cyan.bold("[PLAN CHANGE]"), message, prefix),
    replan: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.magenta.bold("[REPLAN]"), message, prefix),
    warning: (message: string, prefix = "") => printStatusLine((line) => console.warn(line), chalk.yellow.bold("[WARNING]"), message, prefix),
    error: (message: string, prefix = "") => printStatusLine((line) => console.error(line), chalk.red.bold("[ERROR]"), message, prefix),
    classification: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.cyan.bold("[PLANNING NECESSITY]"), message, prefix),
    specKeeper: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.magenta.bold("[SPEC KEEPER]"), message, prefix),
};

/**
 * Console hierarchy levels shared by the agent loop and plan-printer.ts.
 * Numeric depth: phase=0, plan=1, plan step=2, line content=3, tool result=4.
 * The actual indentation widths (0/2/4/6/8 spaces) are owned by
 * plan-printer.ts indent(), which remains the single source of truth for the
 * console indent scheme.
 */
type ConsoleHierarchyLevel = "phase" | "plan" | "planStep" | "contentInStep" | "toolResult";

const CONSOLE_HIERARCHY_LEVELS: Readonly<Record<ConsoleHierarchyLevel, number>> = {
    phase: 0,
    plan: 1,
    planStep: 2,
    contentInStep: 3,
    toolResult: 4,
} as const;

/**
 * Return the indentation prefix for a console hierarchy level. The prefix is
 * resolved through plan-printer.ts indent() so main.ts and printPlan share the
 * exact same space widths; chalk styling is applied by the status helpers and
 * is not altered here.
 */
function hierarchyIndent(level: ConsoleHierarchyLevel): string {
    return indent(level);
}

/**
 * Print a multi-line message at a console hierarchy level, indenting every
 * line with the level prefix. Callers apply any chalk styling to the message
 * before calling this helper.
 */
function logWithHierarchy(message: string, level: ConsoleHierarchyLevel): void {
    const prefix = hierarchyIndent(level);
    const lines = String(message).split("\n");
    for (const line of lines) console.log(`${prefix}${line}`);
}

/**
 * Indentation prefix for child tool-call feedback lines (SUCCESS/ERROR/RESPONSE)
 * emitted below a [TOOL] pending line. The [TOOL] pending line uses the
 * content-in-step indent of 6 spaces, and these result lines sit one hierarchy
 * level below it at the tool-result indent of 8 spaces, sourced from
 * plan-printer.ts through hierarchyIndent().
 */
const toolChildIndent = hierarchyIndent("toolResult");

const tools = [
    {
        type: "function", name: "Write",
        usage_prompt: "tools/write-usage.md",
        parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" }, read_hash: { type: "string" } },
            required: ["path", "content", "read_hash"],
        },
        exec_handler: ({ path, content, overwrite, read_hash }) => Write({ path, content, overwrite, read_hash }),
    },
    {
        type: "function", name: "Read",
        usage_prompt: "tools/read-usage.md",
        description: "Read a page of a UTF-8 file after first obtaining its size with FileSize. Requires path, file_size, read_length, and read_offset. Refuses files larger than 500k.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                file_size: { type: "number", description: "Size of the file in bytes. Obtain this from the FileSize tool before calling Read." },
                read_length: { type: "number", description: "Maximum number of bytes to return in this page." },
                read_offset: { type: "number", description: "Zero-based byte offset at which to start reading." },
            },
            required: ["path", "file_size", "read_length", "read_offset"],
        },
        exec_handler: ({ path, file_size, read_length, read_offset }) => Read({ path, file_size, read_length, read_offset }),
    },
    {
        type: "function", name: "FileSize",
        usage_prompt: "tools/file-size-usage.md",
        description: "Return the size of a file in bytes. Call FileSize before Read so you can pass the required file_size value.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        exec_handler: ({ path }) => FileSize({ path }),
    },
    {
        type: "function", name: "Edit",
        usage_prompt: "tools/edit-usage.md",
        description: "Edit a file in place using replacement operations. Provide the read_hash returned by the last Read (or Write/Edit) of this file so an edit only applies when the file is unchanged. Pass either a single { old_string, new_string } replacement or an ordered edits array; each old_string must appear exactly once.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" }, read_hash: { type: "string" },
                old_string: { type: "string" }, new_string: { type: "string" },
                edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" } }, required: ["old_string", "new_string"] } },
            }, required: ["path", "read_hash"],
        },
        exec_handler: ({ path, read_hash, old_string, new_string, edits }) => Edit({ path, read_hash, old_string, new_string, edits }),
    },
    {
        type: "function", name: "Http",
        usage_prompt: "tools/http-usage.md",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        exec_handler: ({ url }) => Http({ url }),
    },
    {
        type: "function", name: "HttpRequest",
        usage_prompt: "tools/http-request-usage.md",
        description: "Send an HTTP request, including authenticated or mutating requests when required.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
                headers: { type: "object", additionalProperties: { type: "string" } }, body: { type: "string" },
            }, required: ["url"],
        },
        exec_handler: (options) => HttpRequest(options),
    },
    {
        type: "function", name: "ListDirectory",
        usage_prompt: "tools/list-directory-usage.md",
        parameters: { type: "object", properties: { directory: { type: "string" } }, required: ["directory"] },
        exec_handler: ({ directory }) => ListDirectory({ directory }),
    },
    {
        type: "function", name: "ExecuteCommand",
        usage_prompt: "tools/execute-command-usage.md",
        description: "Run a Bash command and return its exit code, standard output, and standard error. Parameters are safely supplied as positional arguments.",
        parameters: {
            type: "object",
            properties: { command: { type: "string" }, parameters: { type: "array", items: { type: "string" } } },
            required: ["command"],
        },
        exec_handler: ({ command, parameters }) => ExecuteCommand(command, parameters),
    },
    {
        type: "function", name: "Git",
        usage_prompt: "tools/git-usage.md",
        description: "List repository changes, stage selected changes, or commit staged changes.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "stage", "commit"] }, cwd: { type: "string" },
                paths: { type: "array", items: { type: "string" } }, all: { type: "boolean" }, message: { type: "string" },
            }, required: ["action"],
        },
        exec_handler: (options) => {
            // In review mode, execution steps stage changes in the worktree and
            // never commit; committing is performed only by the review step when
            // it is happy. Without review mode, inExecutionPhase stays false and
            // the Git tool may commit normally.
            if (options.action === "commit" && inExecutionPhase) {
                const message = executionWorktreePath
                    ? "The Git tool cannot commit during the execution phase. Changes are staged in the execution worktree; only the review step commits when it is satisfied."
                    : "The Git tool cannot commit during the execution phase; the --review flag requires the work to remain uncommitted.";
                return Promise.resolve({ error: message });
            }
            return Git(options);
        },
    },
    {
        type: "function", name: "AgentBus",
        usage_prompt: "tools/agent-bus-usage.md",
        description: "Send coordination messages or retrieve Agent Bus status and handoff feeds.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, body: {}, baseUrl: { type: "string" }, accessToken: { type: "string" }, userAgent: { type: "string" },
            }, required: ["path"],
        },
        exec_handler: (options) => AgentBus(options),
    },
    {
        type: "function", name: "SpecKeeper",
        usage_prompt: "tools/spec-keeper-usage.md",
        description: "Query and update Spec Keeper goals, epics, tasks, decisions, plans, procedures, and task state.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, body: {},
                accessToken: { type: "string" }, refreshToken: { type: "string" }, username: { type: "string" }, password: { type: "string" },
                clientId: { type: "string" }, region: { type: "string" }, apiBase: { type: "string" }, projectSlug: { type: "string" }, userAgent: { type: "string" },
            }, required: ["path"],
        },
        exec_handler: (options) => SpecKeeper(options),
    },
    {
        type: "function", name: "SpecKeeperEnroll",
        usage_prompt: "tools/spec-keeper-enroll-usage.md",
        description: "Redeem a one-time Spec Keeper enrollment token and return its enrollment recipe. The recipe contains secrets and must not be written to the repository.",
        parameters: {
            type: "object", properties: { token: { type: "string", description: "Token from the #token= fragment of a Spec Keeper enrollment URL." } }, required: ["token"],
        },
        exec_handler: ({ token }) => SpecKeeperEnroll({ token }),
    },
];

/**
 * Render the tools-available prompt section. Each tool is listed together with
 * its repository-relative usage prompt filename (for example
 * tools/read-usage.md) so the model can load that file through the ordinary
 * Read tool. The section is injected into prompts whose LLM request also
 * carries the native tool definitions.
 */
function buildToolsAvailablePrompt(tools) {
    const lines = tools
        .map((tool) => `${tool.name} - usage prompt: ${tool.usage_prompt ?? "(none)"}`)
        .join("\n");
    return `Tools available:\n${lines}`;
}

const toolsAvailable = buildToolsAvailablePrompt(tools);

function truncate(value, maxLength = 240) {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
function stringify(value) { try { return JSON.stringify(value); } catch { return String(value); } }
function toolCallArgumentSummary(argumentsText) {
    if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
    try { return truncate(stringify(JSON.parse(argumentsText)), 160); }
    catch { return truncate(argumentsText, 160); }
}
function renderToolCallPending(toolCall) {
    const argumentsSummary = toolCallArgumentSummary(toolCall.arguments);
    status.tool(`Pending: ${toolCall.name}${argumentsSummary ? ` ${argumentsSummary}` : ""}`, hierarchyIndent("contentInStep"));
}
function renderToolCallSucceeded(toolCall, result) {
    status.success(`Succeeded: ${toolCall.name}${result === undefined ? "" : ` → ${truncate(stringify(result), 160)}`}`, toolChildIndent);
}
function renderToolCallFailed(toolCall, error) {
    status.error(`Failed: ${toolCall.name}: ${error}`, toolChildIndent);
}
function appendHistory(history, value) { history.push(value); if (history.length > historyLimit) history.splice(0, history.length - historyLimit); }
/**
 * Render a prompt template by evaluating its `${...}` interpolation expressions
 * against the supplied variable map. The template text comes from the external
 * prompt files under /elastic-agent/prompts/; all `${...}` occurrences are
 * interpolation points resolved at call time. Backticks in the template are
 * escaped so JSON fence markers in prompt text cannot break the evaluation.
 */
function renderPrompt(template, variables) {
    const names = Object.keys(variables);
    const values = names.map((name) => variables[name]);
    const evaluator = new Function(...names, `return \`${template.replace(/`/g, "\\`")}\`;`);
    return evaluator(...values);
}
function buildPrompt(commandPrompts, toolCallTldrs) {
    const promptHistory = commandPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n") || "(none)";
    const toolHistory = toolCallTldrs.map((tldr, index) => `${index + 1}. ${tldr}`).join("\n") || "(none)";
    return renderPrompt(buildPromptTemplate, { claudeInstructions, historyLimit, promptHistory, toolHistory, commandLinePrompt });
}
function summarizeToolCall(name, toolArguments, toolResponse) { return truncate(`${name}(${truncate(stringify(toolArguments), 160)}) → ${truncate(stringify(toolResponse), 240)}`, 480); }

function tokenCount(value) { return Number.isFinite(value) ? value : 0; }
function getCachedTokens(usage) { return tokenCount(usage?.input_tokens_details?.cached_tokens); }
function usageSummary(usage) { const total = tokenCount(usage?.total_tokens); const cached = getCachedTokens(usage); return { total, cached, totalMinusCache: total - cached }; }
function totalUsage(tokenUsage) {
    return tokenUsage.reduce((sum, usage) => ({ total: sum.total + tokenCount(usage.total_tokens), cached: sum.cached + tokenCount(usage.cached_tokens), totalMinusCache: sum.totalMinusCache + tokenCount(usage.total_minus_cache) }), { total: 0, cached: 0, totalMinusCache: 0 });
}
class CompatibleResponseWrapper {
    response: any;
    constructor(response) { this.response = response; }
    print(prefix = "") {
        const text = responseDisplayText(this.response);
        if (!text) return; // Suppress the empty "[RESPONSE] No text response or tool calls." line.
        status.response("", prefix);
        for (const line of wrapResponseText(text, prefix)) console.log(line.length > 0 ? `${prefix}${line}` : "");
    }
}
function writeFileAtomically(filename, content) {
    const directory = dirname(filename);
    const temporaryFilename = join(directory, `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor;
    try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        descriptor = openSync(temporaryFilename, "wx", 0o600);
        writeFileSync(descriptor, content, "utf-8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporaryFilename, filename);
        return true;
    } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        try { rmSync(temporaryFilename, { force: true }); } catch { /* Preserve the original write error. */ }
        throw error;
    }
}
function saveData(data, filename = dataFilename) {
    try { return writeFileAtomically(filename, JSON.stringify(data, null, 2)); }
    catch (error) { status.error(`Failed to save data: ${error instanceof Error ? error.message : String(error)}`); return false; }
}
function saveMemory(memory, filename = memoryFilename) {
    try { return writeFileAtomically(filename, JSON.stringify(memory, null, 2)); }
    catch (error) { status.error(`Failed to save distilled memory: ${error instanceof Error ? error.message : String(error)}`); return false; }
}
function readData(filename = dataFilename) { try { return JSON.parse(readFileSync(filename, "utf-8")); } catch (error) { status.warning(`Failed to read saved data; starting with a new configuration: ${error instanceof Error ? error.message : String(error)}`); return null; } }

/** Operational Spec Keeper options derived from resolved defaults (no secrets). */
function specKeeperClientOptions(defaults: any) {
    return { projectSlug: defaults?.projectSlug, apiBase: defaults?.apiBase };
}

/**
 * Run a best-effort Spec Keeper sync operation, logging success under the
 * dedicated [SPEC KEEPER] label and failures as clear, actionable warnings.
 * Operation names and statuses are logged; request/response bodies never are.
 */
async function specKeeperSync(action: string, run: () => Promise<any>): Promise<any> {
    try {
        const value = await run();
        status.specKeeper(`${action}.`);
        return value;
    } catch (error) {
        status.warning(`Spec Keeper ${action} skipped: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/**
 * Render the epic-first Spec Keeper context (selected epic + its tasks) into a
 * short prompt block so the plan generated by the LLM can incorporate the
 * epic's existing tasks. Returns an empty string when no context is available.
 */
function buildEpicPlanContext(epicSync: { epic?: Record<string, unknown> | null; tasks?: unknown[]; selection?: string } | null | undefined) {
    if (!epicSync) return "";
    const epic: any = epicSync.epic ?? {};
    const epicLabel = epic.key ?? epic.public_id ?? epic.title ?? "(epic)";
    const tasks = Array.isArray(epicSync.tasks) ? epicSync.tasks : [];
    const taskLines = tasks.map((task, index) => {
        const t: any = task ?? {};
        return "  " + (index + 1) + ". " + (t.key ?? t.public_id ?? "task") + ": " + (t.title ?? t.description ?? "(no title)");
    }).join("\n");
    const taskBlock = tasks.length > 0
        ? "Existing tasks under epic " + epicLabel + ":\n" + taskLines
        : "Epic " + epicLabel + " currently has no tasks.";
    return "\n\nSPEC KEEPER EPIC CONTEXT (" + epicSync.selection + "):\n" + taskBlock;
}

function isFinalAnswer(output) { return output.type === "message" && output.status === "completed" && output.phase === "final_answer"; }

function responseText(response) {
    return (response.output ?? []).filter((output) => output.type === "message").flatMap((output) => output.content ?? [])
        .filter((item) => item.type === "output_text" || item.type === "text").map((item) => item.text).filter(Boolean).join("\n").trim();
}
function validateExecutionFeedback(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, reason: "Feedback must be a JSON object." };
    const requiredFields = ["stepStatus", "summary", "findings", "suggestedStepUpdate", "suggestedPlanUpdates", "replanRequired", "replanReason"];
    const missingFields = requiredFields.filter((field) => !(field in value));
    if (missingFields.length > 0) return { valid: false, reason: `Missing required field${missingFields.length === 1 ? "" : "s"}: ${missingFields.join(", ")}.` };
    if (!new Set(["completed", "partial", "blocked", "failed"]).has(value.stepStatus)) return { valid: false, reason: "stepStatus is invalid." };
    if (typeof value.summary !== "string") return { valid: false, reason: "summary must be a string." };
    if (!Array.isArray(value.findings) || value.findings.some((finding) => typeof finding !== "string")) return { valid: false, reason: "findings must be an array of strings." };
    if (value.suggestedStepUpdate !== null && typeof value.suggestedStepUpdate !== "string") return { valid: false, reason: "suggestedStepUpdate must be null or a string." };
    if (!Array.isArray(value.suggestedPlanUpdates) || value.suggestedPlanUpdates.some((update) => !update || typeof update !== "object" || Array.isArray(update) || !Number.isInteger(update.step) || update.step < 1 || typeof update.update !== "string")) return { valid: false, reason: "suggestedPlanUpdates must contain objects with a positive integer step and string update." };
    if (typeof value.replanRequired !== "boolean") return { valid: false, reason: "replanRequired must be a boolean." };
    if ((value.replanRequired && (typeof value.replanReason !== "string" || !value.replanReason.trim())) || (!value.replanRequired && value.replanReason !== null)) return { valid: false, reason: "replanReason must be a non-empty string only when replanning is required, and null otherwise." };
    return { valid: true, feedback: value };
}
function parseExecutionFeedback(text) {
    const blocks = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
    if (blocks.length !== 1) return { valid: false, reason: `Expected exactly one fenced JSON feedback block; found ${blocks.length}.` };
    try {
        return validateExecutionFeedback(JSON.parse(blocks[0][1]));
    } catch (error) {
        return { valid: false, reason: `Feedback JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
function validateReviewResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, reason: "Review result must be a JSON object." };
    if (typeof value.passed !== "boolean") return { valid: false, reason: "passed must be a boolean." };
    if ("reasons" in value && (!Array.isArray(value.reasons) || value.reasons.some((reason) => typeof reason !== "string"))) return { valid: false, reason: "reasons must be an array of strings." };
    if ("learnings" in value && (!Array.isArray(value.learnings) || value.learnings.some((learning) => typeof learning !== "string"))) return { valid: false, reason: "learnings must be an array of strings." };
    const reasons = Array.isArray(value.reasons) ? value.reasons : [];
    const learnings = Array.isArray(value.learnings) ? value.learnings : [];
    if (!value.passed) {
        if (reasons.length === 0) return { valid: false, reason: "A failing review must provide at least one reason." };
        return { valid: true, review: { passed: false, reasons, learnings } };
    }
    return { valid: true, review: { passed: true, reasons, learnings } };
}
function parseReviewResult(text) {
    const trimmed = String(text).trim();
    let jsonText = trimmed;
    const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
    if (fenced) jsonText = fenced[1].trim();
    if (!jsonText.startsWith("{")) {
        const start = jsonText.indexOf("{");
        if (start === -1) return { valid: false, reason: "Review response did not contain a JSON object." };
        jsonText = jsonText.slice(start);
    }
    const end = jsonText.lastIndexOf("}");
    if (end === -1) return { valid: false, reason: "Review response did not contain a closing JSON brace." };
    jsonText = jsonText.slice(0, end + 1);
    try {
        return validateReviewResult(JSON.parse(jsonText));
    } catch (error) {
        return { valid: false, reason: `Review JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
function formatExecutedSteps(completedSteps) {
    if (!Array.isArray(completedSteps) || completedSteps.length === 0) return "(none)";
    return completedSteps.map((entry) => `${entry.step}. ${entry.text}`).join("\n");
}
function formatLearnings(learnings) {
    if (!Array.isArray(learnings) || learnings.length === 0) return "(none)";
    return learnings.map((learning, index) => `${index + 1}. ${learning}`).join("\n");
}
/**
 * Build a concise summary of a happy review for use in the review commit message.
 * When the review carried learnings, those are used; otherwise the generic
 * "review passed" summary is returned.
 */
function summarizeReview(review: { passed: boolean; reasons?: string[]; learnings?: string[] } | undefined) {
    const learnings = Array.isArray(review?.learnings) ? review.learnings.filter(Boolean) : [];
    if (learnings.length > 0) return truncate(learnings.join("; "), 160);
    return "completed work passed all four review criteria";
}
/**
 * Issue the review prompt to the model and return a validated review result.
 * If the response is not valid JSON, append the parsing error and issue a
 * retry request, up to a small number of retries. Every request flows through
 * client.create, so all prompts and responses are recorded to llm.log.
 */
async function runReview(client, configData, reviewRequest, validationError) {
    let lastParsed;
    for (let retry = 0; retry <= 2; retry += 1) {
        const promptToSend = retry === 0 && !validationError
            ? reviewRequest
            : `${reviewRequest}\n\nThe previous response was not valid JSON. Here's the error: ${
                validationError ?? lastParsed?.reason ?? "unknown"}. Please return valid JSON following this exact structure.`;
        const response = await client.create({ input: promptToSend });
        new CompatibleResponseWrapper(response).print();
        recordUsage(configData, response);
        lastParsed = parseReviewResult(responseText(response));
        if (lastParsed.valid) return lastParsed.review as NonNullable<typeof lastParsed.review>;
    }
    status.error(`Review response was not valid JSON after retries: ${lastParsed?.reason ?? "unknown"}`);
    return { passed: false, reasons: [`Review response could not be parsed as JSON: ${lastParsed?.reason ?? "unknown"}`], learnings: [] };
}

function captureExecutionFeedback(configData, response, stepIndex) {
    if (!Array.isArray(configData.executionFeedback)) configData.executionFeedback = [];
    const rawResponse = responseText(response);
    const parsed = parseExecutionFeedback(rawResponse);
    const entry: any = { response_id: response.id, step: stepIndex + 1, valid: parsed.valid };
    if (parsed.valid) entry.feedback = parsed.feedback;
    else {
        entry.validationError = parsed.reason;
        entry.rawResponse = rawResponse;
        status.error(`Step ${stepIndex + 1} response was not valid JSON: ${parsed.reason}`, hierarchyIndent("contentInStep"));
    }
    configData.executionFeedback.push(entry);
    return entry;
}
function planSteps(plan) {
    const steps = plan.split("\n").map((line) => line.trim())
        .filter((line) => /^\d+[.)]\s+/.test(line)).map((line) => line.replace(/^\d+[.)]\s+/, "").trim()).filter(Boolean);
    return steps.length > 0 ? steps : [plan.trim() || "Execute the requested work and report the result."];
}
function actionablePlanSteps(plan) {
    if (typeof plan !== "string" || !plan.trim()) return { valid: false, reason: "The revised plan response was empty." };
    const steps = plan.split("\n").map((line) => line.trim())
        .filter((line) => /^\d+[.)]\s+/.test(line)).map((line) => line.replace(/^\d+[.)]\s+/, "").trim());
    if (steps.length === 0) return { valid: false, reason: "The revised plan must contain at least one numbered step." };
    if (steps.length > maxRevisedPlanSteps) return { valid: false, reason: `The revised plan has more than ${maxRevisedPlanSteps} steps.` };
    if (steps.some((step) => !step || /^(none|n\/?a|no action)$/i.test(step))) return { valid: false, reason: "The revised plan contains an empty or non-actionable step." };
    return { valid: true, steps };
}
async function attemptReplan(feedbackEntry, activeSteps, completedStepCount, configData) {
    const remainingStart = completedStepCount + 1;
    const remainingSteps = activeSteps.slice(remainingStart);
    const feedback = feedbackEntry?.feedback;
    if (!feedbackEntry?.valid || !feedback?.replanRequired) return { attempted: false, applied: false };
    if (remainingSteps.length === 0) {
        status.warning("Replan request skipped because there are no remaining steps to replace.", hierarchyIndent("contentInStep"));
        return { attempted: false, applied: false, reason: "No remaining plan steps." };
    }
    if (configData.replanAttemptCount >= maxReplanAttempts) {
        status.warning(`Replan request skipped: the limit of ${maxReplanAttempts} attempts has been reached. Keeping the existing remaining plan.`, hierarchyIndent("contentInStep"));
        return { attempted: false, applied: false, reason: "Replan attempt limit reached." };
    }

    configData.replanAttemptCount += 1;
    const attempt = configData.replanAttemptCount;
    status.replan(`Requesting focused revised plan (attempt ${attempt}/${maxReplanAttempts}): ${truncate(feedback.replanReason)}`, hierarchyIndent("contentInStep"));
    const completedWork = (configData.completedSteps ?? []).map((entry) => `${entry.step}. ${entry.text}`).join("\n") || "(none)";
    const toolFindings = (configData.toolCallTldrs ?? []).slice(-historyLimit).join("\n") || "(none)";
    const request = renderPrompt(replanPromptTemplate, { claudeInstructions, completedWork, feedback, toolFindings, formatPlan, remainingSteps });
    try {
        const response = await client.create({ input: request });
        new CompatibleResponseWrapper(response).print(hierarchyIndent("contentInStep"));
        recordUsage(configData, response);
        const validation = actionablePlanSteps(responseText(response));
        const historyEntry: any = { attempt, response_id: response.id, reason: feedback.replanReason, applied: false };
        if (!validation.valid) {
            historyEntry.failure = validation.reason;
            configData.replanHistory.push(historyEntry);
            status.warning(`Rejected revised plan; keeping the existing remaining plan: ${validation.reason}`, hierarchyIndent("contentInStep"));
            return { attempted: true, applied: false, reason: validation.reason };
        }
        const revisedSteps: string[] = validation.steps as string[];
        activeSteps.splice(remainingStart, remainingSteps.length, ...revisedSteps);
        historyEntry.applied = true;
        historyEntry.replacementStepCount = revisedSteps.length;
        configData.replanHistory.push(historyEntry);
        status.change(`Accepted focused replan: replaced ${remainingSteps.length} remaining step${remainingSteps.length === 1 ? "" : "s"} with ${revisedSteps.length}.`, hierarchyIndent("contentInStep"));
        return { attempted: true, applied: true, steps: revisedSteps };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        configData.replanHistory.push({ attempt, reason: feedback.replanReason, applied: false, failure: reason });
        status.warning(`Replan request failed; keeping the existing remaining plan: ${reason}`, hierarchyIndent("contentInStep"));
        return { attempted: true, applied: false, reason };
    }
}
function formatPlan(steps) {
    return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}
function appendSuggestedUpdate(step, update) {
    return `${step}\nUpdate: ${update.trim()}`;
}
function reportExecutionFeedback(feedbackEntry) {
    const stepLabel = `Step ${feedbackEntry?.step ?? "unknown"}`;
    if (!feedbackEntry?.valid) {
        status.warning(`${stepLabel} feedback was retained as an execution note but not applied: ${feedbackEntry?.validationError ?? "unknown validation error"}`, hierarchyIndent("contentInStep"));
        return;
    }

    const feedback = feedbackEntry.feedback;
    status.feedback(`${stepLabel} status: ${feedback.stepStatus}. ${truncate(feedback.summary)}`, hierarchyIndent("contentInStep"));
    if (feedback.findings.length > 0) {
        status.feedback(`${stepLabel} findings: ${feedback.findings.map((finding) => truncate(finding, 160)).join("; ")}`, hierarchyIndent("contentInStep"));
    }
    if (feedback.replanRequired) {
        status.replan(`${stepLabel} recommends replanning: ${truncate(feedback.replanReason)}`, hierarchyIndent("contentInStep"));
    } else {
        status.replan(`${stepLabel} does not recommend replanning.`, hierarchyIndent("contentInStep"));
    }
}
function reportAppliedPlanChanges(appliedChanges) {
    if (appliedChanges.localUpdate) {
        status.change(`Accepted local update for step ${appliedChanges.localUpdate.step}: ${truncate(appliedChanges.localUpdate.update)}`, hierarchyIndent("contentInStep"));
    }
    for (const update of appliedChanges.planUpdates) {
        status.change(`Accepted update for remaining step ${update.step}: ${truncate(update.update)}`, hierarchyIndent("contentInStep"));
    }
    for (const rejected of appliedChanges.rejectedPlanUpdates) {
        status.warning(`Skipped suggested update for step ${rejected.step}: ${rejected.reason}`, hierarchyIndent("contentInStep"));
    }
}
function applyExecutionFeedback(feedbackEntry, activeSteps, completedStepCount) {
    const result: { localUpdate: any; planUpdates: any[]; rejectedPlanUpdates: any[] } = { localUpdate: null, planUpdates: [], rejectedPlanUpdates: [] };
    if (!feedbackEntry?.valid || !feedbackEntry.feedback) return result;

    const feedback = feedbackEntry.feedback;
    if (feedback.suggestedStepUpdate?.trim()) {
        activeSteps[completedStepCount] = appendSuggestedUpdate(activeSteps[completedStepCount], feedback.suggestedStepUpdate);
        result.localUpdate = { step: completedStepCount + 1, update: feedback.suggestedStepUpdate };
    }

    for (const suggestion of feedback.suggestedPlanUpdates) {
        const targetIndex = suggestion.step - 1;
        if (targetIndex < completedStepCount + 1 || targetIndex >= activeSteps.length) {
            result.rejectedPlanUpdates.push({ ...suggestion, reason: "The target is not a remaining plan step." });
            continue;
        }
        if (!suggestion.update.trim()) {
            result.rejectedPlanUpdates.push({ ...suggestion, reason: "The update is empty." });
            continue;
        }
        activeSteps[targetIndex] = appendSuggestedUpdate(activeSteps[targetIndex], suggestion.update);
        result.planUpdates.push({ step: suggestion.step, update: suggestion.update });
    }
    return result;
}
function recordUsage(configData, response) {
    const { total, cached, totalMinusCache } = usageSummary(response.usage);
    configData.tokenUsage.push({ response_id: response.id, total_tokens: total, cached_tokens: cached, total_minus_cache: totalMinusCache, input_tokens_details: response.usage?.input_tokens_details ?? {} });
}
function serializeToolResult(resultOrError) {
    try {
        const serialized = JSON.stringify(resultOrError);
        return serialized === undefined ? "null" : serialized;
    } catch (error) {
        return JSON.stringify({ error: `Tool result could not be serialized: ${error instanceof Error ? error.message : String(error)}` });
    }
}
function functionCallOutput(toolCall, resultOrError) {
    return {
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: serializeToolResult(resultOrError),
    };
}

async function executePlanStep(step, index, steps, plan, configData, executionContext) {
    const color = typeof process.stdout.isTTY === "boolean" && process.stdout.isTTY;
    for (const line of buildPrettyStepLines(index, steps.length, step, { color, remainingSteps: steps.slice(index + 1) })) {
        status.step(line, hierarchyIndent("planStep"));
    }
    let previousResponseId;
    let toolOutputs: any[] = [];
    while (true) {
        const request = { tools } as any;
        if (previousResponseId) {
            request.previous_response_id = previousResponseId;
            request.input = toolOutputs;
        } else {
            request.input = renderPrompt(stepExecutionPromptTemplate, { claudeInstructions, commitInstruction, plan, index, steps, step, executionFeedbackFormat, executionContext, toolsAvailable });
        }
        const response = await client.create(request);
        new CompatibleResponseWrapper(response).print(toolChildIndent);
        recordUsage(configData, response);
        previousResponseId = response.id;
        toolOutputs = [];
        for (const output of response.output ?? []) {
            if (output.type !== "function_call") continue;
            renderToolCallPending(output);
            const tool = tools.find((candidate) => candidate.name === output.name);
            let toolArguments;
            try {
                toolArguments = JSON.parse(output.arguments);
                if (!tool?.exec_handler) throw new Error(`No exec_handler found for tool: ${output.name}`);
                const toolResponse = await tool.exec_handler(toolArguments);
                toolOutputs.push(functionCallOutput(output, toolResponse));
                appendHistory(configData.toolCallTldrs, summarizeToolCall(output.name, toolArguments, toolResponse));
                renderToolCallSucceeded(output, toolResponse);
            } catch (error) {
                const toolResponse = { error: error instanceof Error ? error.message : String(error) };
                toolOutputs.push(functionCallOutput(output, toolResponse));
                appendHistory(configData.toolCallTldrs, summarizeToolCall(output.name, toolArguments ?? {}, toolResponse));
                renderToolCallFailed(output, toolResponse.error);
            }
        }
        saveData(configData);
        if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);
        if (toolOutputs.length === 0) {
            let feedbackEntry = captureExecutionFeedback(configData, response, index);
            reportExecutionFeedback(feedbackEntry);
            saveData(configData);
            if (!feedbackEntry.valid) {
                const stepPrompt = renderPrompt(stepExecutionPromptTemplate, { claudeInstructions, commitInstruction, plan, index, steps, step, executionFeedbackFormat, executionContext, toolsAvailable });
                configData.retryPrompt =
                    `${stepPrompt}\n\nThe previous response was not valid JSON. Here's the error: ` +
                    `${feedbackEntry.validationError}. Please return valid JSON following this exact structure.`;
                status.replan(`Step ${index + 1} response was not valid JSON; sending a retry request with the parsing error appended.`, hierarchyIndent("contentInStep"));
                const retryResponse = await client.create({ input: configData.retryPrompt });
                new CompatibleResponseWrapper(retryResponse).print(toolChildIndent);
                recordUsage(configData, retryResponse);
                saveData(configData);
                if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);
                const retryEntry = captureExecutionFeedback(configData, retryResponse, index);
                reportExecutionFeedback(retryEntry);
                feedbackEntry = retryEntry;
                saveData(configData);
            }
            status.success(`Step ${index + 1}/${steps.length} completed.`, hierarchyIndent("contentInStep"));
            return feedbackEntry;
        }
    }
}

async function runExecutionPhase(activeSteps, plan, configData, executionContext = "(none)", useReviewWorktree = false, specKeeperState: any = null) {
    configData.completedSteps = [];
    configData.replanAttemptCount = 0;
    configData.replanHistory = [];
    configData.activePlanSteps = [...activeSteps];
    configData.lastResponseId = null;
    configData.lastToolCallIds = [];
    saveData(configData);
    if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);
    // Execution staging (review mode only): plan steps write into a dedicated
    // worktree and stage their changes there (git add -A) without ever
    // committing. The worktree is created once and reused across review
    // attempts so staged work accumulates for the review step to inspect. On
    // entry we chdir into the worktree so the file tools (Write,
    // ExecuteCommand, etc.) resolve paths inside it, and we restore the main
    // working directory when the phase ends. Without review mode the phase
    // runs directly in the main working directory and the Git tool is allowed
    // to commit normally.
    inExecutionPhase = false;
    const worktree = useReviewWorktree ? ensureWorktree(executionWorktreeBranch, mainCwd) : null;
    const originalCwd = process.cwd();
    if (worktree) {
        inExecutionPhase = true;
        executionWorktreePath = worktree;
        process.chdir(worktree);
    }
    try {
        for (let index = 0; index < activeSteps.length; index += 1) {
            const executedStep = activeSteps[index];
            if (specKeeperState?.stepTasks?.[index]) {
                await specKeeperSync(
                    `step ${index + 1} marked in_progress`,
                    async () => updateSpecKeeperTask(
                        specKeeperState.stepTasks[index],
                        { status: "in_progress", status_note: `Executing plan step ${index + 1}.` },
                        specKeeperState.taskUpdateOptions,
                    ),
                );
            }
            const feedbackEntry = await executePlanStep(executedStep, index, activeSteps, formatPlan(activeSteps), configData, executionContext);
            configData.completedSteps.push({ step: index + 1, text: executedStep, feedbackResponseId: feedbackEntry?.response_id ?? null });
            if (specKeeperState?.stepTasks?.[index]) {
                const stepStatus = feedbackEntry?.valid && feedbackEntry.feedback?.stepStatus === "blocked" ? "blocked" : "done";
                const stepNote = feedbackEntry?.valid
                    ? `Step ${index + 1} ${feedbackEntry.feedback.stepStatus}. ${feedbackEntry.feedback.summary ?? ""}`.trim()
                    : `Step ${index + 1} completed.`;
                await specKeeperSync(
                    `step ${index + 1} marked ${stepStatus}`,
                    async () => updateSpecKeeperTask(
                        specKeeperState.stepTasks[index],
                        { status: stepStatus, status_note: stepNote },
                        specKeeperState.taskUpdateOptions,
                    ),
                );
            }
            const appliedChanges = applyExecutionFeedback(feedbackEntry, activeSteps, index);
            reportAppliedPlanChanges(appliedChanges);
            await attemptReplan(feedbackEntry, activeSteps, index, configData);
            configData.activePlanSteps = [...activeSteps];
            configData.lastAppliedPlanChanges = appliedChanges;
            if (worktree) {
                // Stage all changes this step produced into the worktree. We never
                // commit here; the review step commits only when it is satisfied.
                stageAllInWorktree(worktree);
            }
            saveData(configData);
            if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);
        }
    } finally {
        if (worktree) {
            process.chdir(originalCwd);
            inExecutionPhase = false;
        }
    }
}

async function runReviewPhase(activeSteps, plan, configData, reviewAttempt) {
    // The review phase starts with a plan step: ask the model to plan how to
    // conduct the review of the executed work against the four review criteria.
    status.planning("Creating a review plan...");
    const reviewPlanGoal =
        "Plan how to conduct a review of the just-executed work. Assess the original prompt request, " +
        "the end-result quality, SDLC.md compliance, and record any learnings. Return a concise step-by-step plan.";
    const reviewPlanPrompt = `${reviewPlanGoal}\n\n${planningSuffix}`;
    const reviewPlanResponse = await client.create({ input: reviewPlanPrompt });
    new CompatibleResponseWrapper(reviewPlanResponse).print();
    recordUsage(configData, reviewPlanResponse);
    const reviewPlan = responseText(reviewPlanResponse);
    saveData(configData);

    status.planning(`Reviewing the completed work (attempt ${reviewAttempt}/${maxReviewAttempts})...`);
    const executedSteps = formatExecutedSteps(configData.completedSteps);
    const learnings = formatLearnings(configData.reviewLearnings ?? []);
    // Surface the actual staged execution work (changed files + diff against
    // HEAD) to the reviewer so it reviews concrete changes rather than only the
    // prose describing executed steps, which previously left it reporting "no
    // changes detected". Best-effort: if the diff cannot be read, fall back to
    // an explicit notice rather than failing the review phase.
    let changes = "(no staged changes summary available)";
    if (executionWorktreePath) {
        try {
            changes = stagedChangesSummary(executionWorktreePath);
        } catch (error) {
            status.warning(`Could not read staged changes for review: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (changes.includes("(no staged changes against HEAD)")) {
            // The staged diff is empty (for example the execution work was
            // already committed). Surface the committed work so the reviewer
            // still sees concrete changes instead of a blank staged block.
            try {
                changes = `${changes}\n\n${committedChangesSummary(executionWorktreePath)}`;
            } catch (error) {
                status.warning(`Could not read committed changes for review: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    const reviewRequest = renderPrompt(reviewPromptTemplate, {
        claudeInstructions, originalPrompt: commandLinePrompt, plan: formatPlan(activeSteps),
        executedSteps, changes, reviewPlan, learnings, reviewAttempt, maxReviewAttempts,
    });
    return runReview(client, configData, reviewRequest, null);
}

/**
 * Execute the original command-line prompt directly when the planning-necessity
 * classifier decides no formal plan is needed. This is a single execution step:
 * one initial LLM completion with the tool set, followed by tool-call
 * continuations until the model returns a final answer. There is no planning
 * prompt, no plan JSON, no plan review step, and no plan-derived worktree
 * lifecycle. `reviewMode` preserves the existing --review commit behavior by
 * blocking Git commits during the step, without creating a worktree.
 */
async function runSingleStep(prompt: string, configData: any, reviewMode: boolean, specKeeperDefaults: any = null): Promise<void> {
    configData.completedSteps = [{ step: 1, text: commandLinePrompt }];
    configData.activePlanSteps = [commandLinePrompt];
    configData.lastResponseId = null;
    configData.lastToolCallIds = [];
    saveData(configData);
    if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);

    const skClientOptions = specKeeperClientOptions(specKeeperDefaults);
    const defaultEpic = specKeeperDefaults?.defaultEpic ?? {};
    const defaultTask = specKeeperDefaults?.defaultTask ?? {};
    let skTask: any = null;

    // Epic-first task sync for the no-plan path: reuse/create the configured
    // default epic, then reuse/create one task beneath it for this run.
    const epicSync = await specKeeperSync("epic-first task epic sync", async () => syncSpecKeeperEpic({
        key: defaultEpic.key,
        title: defaultEpic.title ?? defaultEpic.key ?? commandLinePrompt,
        description: defaultEpic.description ?? `Auto-created by elastic-agent for: ${commandLinePrompt}`,
        ...skClientOptions,
    }));
    if (epicSync) {
        const taskSync = await specKeeperSync("task sync", async () => syncSpecKeeperTask({
            key: defaultTask.key,
            title: commandLinePrompt,
            description: `Direct task execution (no plan): ${commandLinePrompt}`,
            epicId: epicIdentifier(epicSync.epic),
            keyPrefix: defaultTask.keyPrefix,
            defaultStatus: defaultTask.status ?? "in_progress",
            ...skClientOptions,
        }));
        if (taskSync) {
            skTask = taskSync.task;
            if (!taskSync.created) {
                await specKeeperSync("task in_progress", async () => updateTaskStatus(skTask, "in_progress", "Direct execution started.", skClientOptions));
            }
        }
    }

    const previousInExecutionPhase = inExecutionPhase;
    if (reviewMode) inExecutionPhase = true;

    try {
        status.step("Executing request directly without a plan.", hierarchyIndent("planStep"));
        let previousResponseId;
        let toolOutputs: any[] = [];
        while (true) {
            const request = { tools } as any;
            if (previousResponseId) {
                request.previous_response_id = previousResponseId;
                request.input = toolOutputs;
            } else {
                request.input = prompt;
            }
            const response = await client.create(request);
            new CompatibleResponseWrapper(response).print(toolChildIndent);
            recordUsage(configData, response);
            previousResponseId = response.id;
            toolOutputs = [];
            for (const output of response.output ?? []) {
                if (output.type !== "function_call") continue;
                renderToolCallPending(output);
                const tool = tools.find((candidate) => candidate.name === output.name);
                let toolArguments;
                try {
                    toolArguments = JSON.parse(output.arguments);
                    if (!tool?.exec_handler) throw new Error(`No exec_handler found for tool: ${output.name}`);
                    const toolResponse = await tool.exec_handler(toolArguments);
                    toolOutputs.push(functionCallOutput(output, toolResponse));
                    appendHistory(configData.toolCallTldrs, summarizeToolCall(output.name, toolArguments, toolResponse));
                    renderToolCallSucceeded(output, toolResponse);
                } catch (error) {
                    const toolResponse = { error: error instanceof Error ? error.message : String(error) };
                    toolOutputs.push(functionCallOutput(output, toolResponse));
                    appendHistory(configData.toolCallTldrs, summarizeToolCall(output.name, toolArguments ?? {}, toolResponse));
                    renderToolCallFailed(output, toolResponse.error);
                }
            }
            saveData(configData);
            if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);
            if (toolOutputs.length === 0) {
                if (skTask) {
                    await specKeeperSync("task done", async () => updateTaskStatus(
                        skTask,
                        "done",
                        reviewMode ? "Direct execution complete; commit deferred to review." : "Direct execution complete and committed.",
                        skClientOptions,
                    ));
                }
                status.success("Direct execution step completed.", hierarchyIndent("contentInStep"));
                return;
            }
        }
    } catch (error) {
        if (skTask) {
            await specKeeperSync("task blocked", async () => updateTaskStatus(
                skTask,
                "blocked",
                `Direct execution failed: ${error instanceof Error ? error.message : String(error)}`,
                skClientOptions,
            ));
        }
        throw error;
    } finally {
        inExecutionPhase = previousInExecutionPhase;
    }
}

async function main(options: { review?: boolean } = {}) {
    client = new MultiTurnLlmRuntime(await createRuntimeLlmAdapter({ configuration: providerSelection.configuration }), modelConfiguration.model);
    let configData = readData();
    if (!configData) configData = { responseIds: [] };
    if (!Array.isArray(configData.requestResponses)) configData.requestResponses = [];
    if (!configData.toolCallResponse || typeof configData.toolCallResponse !== "object") configData.toolCallResponse = {};
    if (!Array.isArray(configData.tokenUsage)) configData.tokenUsage = [];
    if (!Array.isArray(configData.commandLinePrompts)) configData.commandLinePrompts = [];
    if (!Array.isArray(configData.toolCallTldrs)) configData.toolCallTldrs = [];
    if (!Array.isArray(configData.replanHistory)) configData.replanHistory = [];
    if (!Number.isInteger(configData.replanAttemptCount) || configData.replanAttemptCount < 0) configData.replanAttemptCount = 0;
    appendHistory(configData.commandLinePrompts, commandLinePrompt);
    const prompt = buildPrompt(configData.commandLinePrompts, configData.toolCallTldrs);

    // Resolve Spec Keeper operational defaults once before any planning or
    // execution sync. This loads the local .spec-keeper file (when present) and
    // reports the winning config source without ever logging secret values.
    const specKeeperDefaults = resolveSpecKeeperDefaults();
    for (const warning of specKeeperDefaults.warnings) status.warning(warning);
    status.specKeeper(`defaults loaded: ${describeSpecKeeperDefaults(specKeeperDefaults)}`);

    // Planning-necessity classification: before entering the plan-then-execute
    // flow, ask the LLM whether the original command-line prompt genuinely
    // needs a formal plan. The classification runs after the prompt is resolved
    // and before runExecutionPhase/executePlanStep is ever invoked. Invalid or
    // missing classifier output falls back to requiresPlanning=true so the
    // safer plan flow runs.
    const planningNecessity = await determinePlanningNecessity(commandLinePrompt, client);
    const selectedMode = selectExecutionMode(planningNecessity);
    status.classification(`requiresPlanning=${planningNecessity.requiresPlanning} (${planningNecessity.reason}); mode: ${selectedMode}`, hierarchyIndent("plan"));
    if (!planningNecessity.requiresPlanning) {
        // No-plan single-step path: run the original command-line prompt
        // directly. No planning prompt, plan JSON, plan review step, or
        // plan-derived worktree lifecycle. The existing --review flag still
        // controls commit behavior via commitInstruction and the Git commit
        // guard handled by runSingleStep.
        const directPrompt = `${prompt}\n\n${toolsAvailable}\n\nCommit instruction for this step: ${commitInstruction}`;
        await runSingleStep(directPrompt, configData, options.review === true, specKeeperDefaults);
        const totals = totalUsage(configData.tokenUsage);
        status.success(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);
        status.success("Direct execution complete. Stopping.");
        return;
    }

    // Epic-first Spec Keeper coordination: always pull epics, select or create
    // the epic that matches this work, fetch its tasks, and make that context
    // available to the planning prompt so the plan incorporates the epic tasks.
    // Best-effort: when Spec Keeper is unreachable we proceed without it so the
    // run is not blocked by coordination unavailability.
    let epicSync: any = null;
    try {
        epicSync = await syncSpecKeeperEpic({ title: commandLinePrompt, description: `Execution requested for: ${commandLinePrompt}`, projectSlug: specKeeperDefaults.projectSlug });
        status.specKeeper(`${epicSync.selection}.`);
    } catch (error) {
        status.warning(`Spec Keeper epic-first sync skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    const epicContext = buildEpicPlanContext(epicSync);

    status.planning("Creating an execution plan...");

    const planningPrompt = `${prompt}\n\n${planningSuffix}${epicContext}`;

    const planningResponse = await client.create({ input: planningPrompt });
    new CompatibleResponseWrapper(planningResponse).print();
    recordUsage(configData, planningResponse);
    const plan = responseText(planningResponse);
    // Extract the plan JSON from the planning prompt response and use that
    // object as the plan. The parsed JSON's step array becomes the active
    // execution plan, replacing the previous text-based parsing. The
    // planSteps() flow remains only as a fallback for responses that are not
    // valid plan JSON.
    const parsedPlan = extractPlanJson(plan);
    let activeSteps;
    if (parsedPlan.valid) {
        printPlan(parsedPlan.plan);
        activeSteps = planStepsFromObject(parsedPlan.plan);
        if (activeSteps.length === 0) {
            status.warning("Planning response JSON had steps without usable text; falling back to text parsing.");
            activeSteps = planSteps(plan);
        }
    } else {
        status.warning(`Planning response was not parseable as plan JSON (${parsedPlan.reason}); falling back to text parsing.`);
        activeSteps = planSteps(plan);
    }
    configData.replanAttemptCount = 0;
    configData.replanHistory = [];
    configData.lastResponseId = null;
    configData.lastToolCallIds = [];
    saveData(configData);
    if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);

    status.success(`Plan created with ${activeSteps.length} step${activeSteps.length === 1 ? "" : "s"}.`);

    const skClientOptions = specKeeperClientOptions(specKeeperDefaults);
    const specKeeperState: any = {
        epic: epicSync?.epic ?? null,
        runTask: null,
        stepTasks: [],
        taskUpdateOptions: skClientOptions,
    };

    // Persist the generated plan onto the selected epic so it becomes the
    // durable home for the plan (best-effort; the run proceeds without it).
    if (epicSync?.epic) {
        try {
            await updateEpicWithPlan(epicSync.epic, formatPlan(activeSteps), { title: commandLinePrompt, projectSlug: specKeeperDefaults.projectSlug });
            status.specKeeper("updated epic with the generated plan.");
        } catch (error) {
            status.warning(`Spec Keeper plan update skipped: ${error instanceof Error ? error.message : String(error)}`);
        }

        await specKeeperSync("epic in_progress", async () => updateEpicStatus(epicSync.epic, "in_progress", skClientOptions));

        const runTaskSync = await specKeeperSync("run task sync", async () => syncSpecKeeperTask({
            key: specKeeperDefaults.defaultTask?.key,
            title: commandLinePrompt,
            description: `Plan execution for: ${commandLinePrompt}`,
            epicId: epicIdentifier(epicSync.epic),
            keyPrefix: specKeeperDefaults.defaultTask?.keyPrefix,
            defaultStatus: specKeeperDefaults.defaultTask?.status ?? "in_progress",
            ...skClientOptions,
        }));
        if (runTaskSync) {
            specKeeperState.runTask = runTaskSync.task;
            if (!runTaskSync.created) {
                await specKeeperSync("run task in_progress", async () => updateTaskStatus(runTaskSync.task, "in_progress", "Plan execution started.", skClientOptions));
            }
            await specKeeperSync("plan linked to run task", async () => updateSpecKeeperTask(
                runTaskSync.task,
                { plan: formatPlan(activeSteps), status: "in_progress" },
                skClientOptions,
            ));
        }

        const stepSync = await specKeeperSync("plan step tasks sync", async () => syncPlanStepTasks(
            epicSync.epic,
            activeSteps,
            {
                keyPrefix: specKeeperDefaults.defaultTask?.keyPrefix,
                epicId: epicIdentifier(epicSync.epic),
                ...skClientOptions,
            },
        ));
        if (stepSync) specKeeperState.stepTasks = stepSync.tasks;
    }

    // Review loop: execute the plan, then review the result. The execution
    // phase stages changes in the execution worktree and NEVER commits. The
    // review step commits ONLY when it is happy (review.passed === true): it
    // stages, commits the staged work in the worktree, and merges the worktree
    // branch into the main branch, then finishes. On a failing review the loop
    // restarts from the execution phase (with the same retained worktree) and
    // does NOT commit. After maxReviewAttempts failures, an explicit error is
    // thrown and the work is left uncommitted.
    let reviewAttempt = 0;
    let executionContext = "(none)";

    if (options.review) {
        while (true) {
            await runExecutionPhase(activeSteps, plan, configData, executionContext, true, specKeeperState);
            reviewAttempt += 1;
            const review = await runReviewPhase(activeSteps, plan, configData, reviewAttempt);
            if (review.passed) {
                status.success(`Review passed on attempt ${reviewAttempt}.`);
                // The review step is happy: commit the staged execution work.
                if (executionWorktreePath) {
                    try {
                        // Stage once more (idempotent) to pick up anything staged during
                        // the just-completed execution phase, then commit in the worktree
                        // and merge the worktree branch into the current (main) branch.
                        stageAllInWorktree(executionWorktreePath);
                        const summary = summarizeReview(review);
                        commitInWorktree(executionWorktreePath, `review happy: ${summary}`);
                        mergeWorktreeIntoMain(executionWorktreeBranch, mainCwd);
                        status.success(`Committed satisfied review work into main (review happy: ${summary}).`);
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        status.error(`Review passed but committing the staged work failed: ${reason}`);
                        cleanupExecutionWorktree();
                        throw new Error(`Review passed but the review commit failed: ${reason}`);
                    }
                } else {
                    status.warning("Review passed but there is no execution worktree in which to commit the work.");
                }
                if (specKeeperState?.runTask) {
                    await specKeeperSync("run task done", async () => updateTaskStatus(
                        specKeeperState.runTask,
                        "done",
                        `Review passed on attempt ${reviewAttempt}.`,
                        skClientOptions,
                    ));
                }
                if (specKeeperState?.epic) {
                    await specKeeperSync("epic done", async () => updateEpicStatus(specKeeperState.epic, "done", skClientOptions));
                }
                break;
            }

            // Review did not pass: record the blocker and stop. The re-run loop
            // is intentionally disabled, so the work remains uncommitted and the
            // Spec Keeper records carry the failing review reasons.
            if (specKeeperState?.runTask) {
                await specKeeperSync("run task blocked", async () => updateTaskStatus(
                    specKeeperState.runTask,
                    "blocked",
                    `Review failed: ${(review.reasons ?? []).join("; ") || "no reasons provided"}`,
                    skClientOptions,
                ));
            }
            if (specKeeperState?.epic) {
                await specKeeperSync("epic blocked", async () => updateEpicStatus(specKeeperState.epic, "blocked", skClientOptions));
            }
            break;
        }
    } else {
        await runExecutionPhase(activeSteps, plan, configData, executionContext, false, specKeeperState);
        if (specKeeperState?.runTask) {
            await specKeeperSync("run task done", async () => updateTaskStatus(
                specKeeperState.runTask,
                "done",
                "Plan execution complete and committed.",
                skClientOptions,
            ));
        }
        if (specKeeperState?.epic) {
            await specKeeperSync("epic done", async () => updateEpicStatus(specKeeperState.epic, "done", skClientOptions));
        }
    }

    const totals = totalUsage(configData.tokenUsage);
    status.success(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);
    status.success("Plan complete. Stopping.");
    cleanupExecutionWorktree();
}

// Remove the execution worktree and its branch once the run finishes (or fails),
// so the main repository is left clean of staged execution work.
function cleanupExecutionWorktree() {
    if (!executionWorktreePath) return;
    try {
        cleanupWorktree(executionWorktreeBranch, mainCwd);
        executionWorktreePath = null;
    } catch (error) {
        status.warning(`Failed to clean up execution worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
}

main(options)
    .catch((error) => {
        cleanupExecutionWorktree();
        status.error(error instanceof Error ? error.stack ?? error.message : String(error));
    });
