import { createRuntimeLlmAdapter, resolveRuntimeLlmModel } from "./llm/application.js";
import { selectCliProvider } from "./llm/cli-provider-selection.js";
import { resolveCliRunMode } from "./cli-task-mode.js";
import { defaultBusQueueFilePath, drainBusQueue } from "./loop-queue.js";
import { classifyAgentBusMessage, messageToSearchableText } from "./loop-mode.js";
import {
    pollLoopBusOnce,
    pollLoopBusUntilMessage,
    resolveLoopMaxIdlePolls,
    resolveLoopPollTiming,
    type AgentBusRead,
} from "./loop-poll.js";
import {
    consumeReplanBudget,
    decideSafeReplan,
    extractReplanPrompt,
    initialLoopReplanBudget,
    type LoopReplanBudget,
} from "./loop-replan.js";
import { defaultBusCursorFilePath, watchAgentBusOnce } from "./loop-busctl-read.js";
import { resolveToolSafetyConfig, startDirPathWarning } from "./tool-safety-config.js";
import { buildPrompt, renderPrompt } from "./prompt-builder.js";
import { detectDocker, describeDockerDetection } from "./docker-detection.js";
import { restoreStartDir, switchToStartDir } from "./tool-cwd.js";
import { MultiTurnLlmRuntime } from "./llm/multi-turn-runtime.js";
import { determinePlanningNecessity, selectExecutionMode } from "./llm/planning-necessity.js";
import { RunAbortError, throwIfAborted, type RunAbortPhase } from "./llm/run-abort.js";
import { buildPrettyStepLines } from "./step-renderer.js";
import { responseDisplayText, wrapResponseText } from "./response-format.js";
import { parsePlanOrAbort, indent, planStepsFromObject, printPlan } from "./plan-printer.js";
import { abortBlockText, boundedAbortReason } from "./llm/abort-report.js";
import {
    nextConsecutiveNoProgressReplans,
    parseReplanResponse,
    phaseRestartRequired,
    recordReplanElapsedAndAssertBudget,
    replanRemainingKey,
    throwIfConsecutiveNoProgressReplansReached,
    throwIfReplanAttemptLimitReached,
    throwIfReplanTimeBudgetExceeded,
} from "./llm/replan-abort.js";
import { ensureWorktree, stageAllInWorktree, cleanupWorktree, commitInWorktree, mergeWorktreeIntoMain, stagedChangesSummary, committedChangesSummary, latestCommitEvidence, listWorktrees } from "./worktree.js";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { renderToolPhase, terminalColorEnabled, truncate, stringify } from "./tool-renderer.js";
import { startToolTimer } from "./tool-timer.js";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, basename, isAbsolute, join, resolve as pathResolve } from "node:path";
import { resolveWorkspaceInit, loadWorkspaceInit, workspaceInitToState, writeWorkspaceInitMarkdown, type WorkspaceInit } from "./workspace-init.ts";
import { randomUUID } from "node:crypto";
import Write from "./tools/Write.ts";
import Read, { ReadParameters } from "./tools/Read.ts";
import FileSize from "./tools/FileSize.ts";
import Edit from "./tools/Edit.ts";
import Delete from "./tools/Delete.ts";
import ListDirectory from "./tools/ListDirectory.ts";
import Mkdir from "./tools/Mkdir.ts";
import Rmdir from "./tools/Rmdir.ts";
import Find from "./tools/Find.ts";
import Grep, { GrepParameters } from "./tools/Grep.ts";
import Http from "./tools/Http.ts";
import HttpRequest from "./tools/HttpRequest.ts";
import Git, { GitParameters } from "./tools/Git.tsx";
import { executeCommand as ExecuteCommand } from "./tools/ExecuteCommand.ts";
import AgentBus from "./tools/AgentBus.ts";
import AgentBusEnrol from "./tools/AgentBusEnrol.ts";
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
import { fetchSpecKeeperTask, describeTaskWorkOrder } from "./specKeeperTaskFetch.ts";
import type { TaskWorkOrder } from "./specKeeperTaskFetch.ts";
import { claimSpecKeeperTask, describeClaimedSpecKeeperTask } from "./specKeeperTaskClaim.ts";
import { buildTaskWorkOrderPrompt, buildTaskWorkOrderBrief } from "./specKeeperTaskPrompt.ts";
import { postSpecKeeperTaskNote, updateSpecKeeperTaskStatus, attachSpecKeeperTaskProof } from "./specKeeperTaskLifecycle.ts";
import { abortSpecKeeperTask, completeSpecKeeperTask, failSpecKeeperTask } from "./specKeeperTaskCompletion.ts";
import { Command } from "commander";
import { classifyToolCall, createToolSafetyLogger, toolRiskLevel } from "./tool-safety-classifier.js";
import { routeGitExecuteCommand, GIT_COMMAND_ROUTER_PROMPT_PATH } from "./git-command-router.js";
import { detectAgentBusCommand } from "./tools/agent-bus-detect.js";
import { DenialTracker, DENIAL_REPLAN_THRESHOLD } from "./denial-tracker.js";

const terminalColor = terminalColorEnabled(process.stdout);
if (!terminalColor) chalk.level = 0;

const program = new Command();
program
    .name("elastic-agent")
    .description("Plan and execute a prompt with the selected LLM provider.")
    .argument("[prompt]", "task or request to plan and execute (omit when using --task-id)")
    .option("--task-id <task-id>", "run task mode for an existing Spec Keeper task ID (task key or public_id); cannot be combined with <prompt>")
    .option("--loop", "keep running in loop mode: watch the Agent Bus between execution steps and classify incoming messages (relevant messages trigger a re-plan; others are queued)", false)
    .option("--respond-all", "loop-mode no-filter: treat every Agent Bus message as relevant so the agent responds to all of them instead of filtering irrelevant ones; only meaningful together with --loop", false)
    .option("--provider <provider-id>", "LLM provider: openai, bedrock-claude, or deepseek-v4 (overrides LLM_PROVIDER)")
    .option("--review", "Run the review stage after execution (default: false)", false)
    .option("--disable-classifier", "Bypass the tool safety classifier", false)
    .option("--agent-source-dir <dir>", "Agent source directory whose files may be edited (default: resolved agent source directory)")
    .option("--start-dir <dir>", "Starting directory whose files may be edited (default: runtime working directory)")
    .option("--allow-agent-source-modifications", "Allow edit-capable tools to modify files inside the agent source and start directories", false)
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
// The prompt is mutable so loop mode can re-enter planning with a relevant
// Agent Bus message as the new work order (see runAgentReplanLoop / step 5 of
// the loop-mode plan). The first execution uses the CLI positional prompt.
let commandLinePrompt = program.args[0];
let runMode: ReturnType<typeof resolveCliRunMode>;
try {
    runMode = resolveCliRunMode(options.taskId, commandLinePrompt, options.loop === true, options.respondAll === true);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
// Tool-safety flags are resolved and validated before any runtime work starts
// so a missing or invalid --agent-source-dir/--start-dir produces a clear CLI
// error instead of a mid-run failure.
let toolSafetyConfig: ReturnType<typeof resolveToolSafetyConfig>;
try {
    // The main entry module path (from process.argv[1], the script handed to
    // node) is resolved to the agent-source root so --allow-agent-source-modifications
    // can enforce that the working directory matches the directory containing
    // main.ts.
    const mainModulePath = pathResolve(process.argv[1] ?? "main.ts");
    toolSafetyConfig = resolveToolSafetyConfig({
        disableClassifier: options.disableClassifier,
        agentSourceDir: options.agentSourceDir,
        startDir: options.startDir,
        allowAgentSourceModifications: options.allowAgentSourceModifications,
    }, process.cwd(), mainModulePath);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
// When --allow-agent-source-modifications is set, the authoritative working
// directory is the agent-source root (the directory containing main.ts). The
// config resolution has already verified the process cwd resolves to it, so
// chdir to the canonical root makes it the authoritative cwd for all reads and
// tool calls that follow.
if (toolSafetyConfig.allowAgentSourceModifications) {
    process.chdir(toolSafetyConfig.agentSourceDir);
}
// Task mode is handled inside main() after Spec Keeper defaults are resolved.
// The run mode is resolved above so prompt-mode-only argument rules are
// enforced before any runtime work starts.
const commitInstruction = options.review ? "do not commit" : "commit all of your work";
const providerSelection = selectCliProvider(process.argv.slice(2));

const modelConfiguration = resolveRuntimeLlmModel({ configuration: providerSelection.configuration });
const abortController = new AbortController();
// SIGINT/SIGTERM are user-triggered aborts. The handlers only abort the
// controller; the single top-level abort handler prints the [ABORT] block and
// assigns the exit code. A second SIGINT is the emergency escape hatch.
let sigintAbortObserved = false;
process.on("SIGINT", () => {
    if (sigintAbortObserved) {
        // Escape hatch: a wedged cleanup must not trap the user.
        process.exit(130);
    }
    sigintAbortObserved = true;
    abortController.abort("SIGINT");
});
process.on("SIGTERM", () => {
    abortController.abort("SIGTERM");
});
let client: MultiTurnLlmRuntime;
const claudeInstructions = readFileSync("CLAUDE.md", "utf-8");
const dataFilename = "/tmp/data.json";
const memoryFilename = process.env.ELASTIC_AGENT_MEMORY_PATH ?? "/tmp/elastic-agent-memory.json";
const historyLimit = 10;
const maxReplanAttempts = 3;
const maxConsecutiveNoProgressReplans = 2;
const maxReplanDurationMs = 120000;
const maxReplanParseRetries = 2;
const maxPlanParseRetries = 1;
const maxReviewParseRetries = 2;
const maxReviewAttempts = 3;
const maxRevisedPlanSteps = 50;
// Execution worktree: plan steps stage their changes in a dedicated worktree
// (git add --all) and never commit. The worktree is kept alive across review
// attempts so the review step can inspect the staged changes before committing.
const executionWorktreeBranch = "review-worktree";
const mainCwd = process.cwd();
// System initialisation: capture the working directory (pwd) and the canonical
// (symlink-resolved) path of the starting directory before any agent action
// that depends on file paths. These values feed CLAUDE.md starting-directory
// guidance and are provided to the tool classifier as trusted roots. Resolving
// once here means later process.chdir() calls (e.g. into the review worktree
// during execution) do not shift what the runtime treats as the authoritative
// starting directory.
const workspaceInit: WorkspaceInit = resolveWorkspaceInit(mainCwd);

// Docker/container detection: resolve once at startup so the tool-safety
// classifier and prompt-building code can choose the right filesystem policy
// (strict outside the start/working directory on non-Docker hosts, relaxed
// inside a throwaway container while data.json, credentials, and secrets stay
// protected). The result is exposed as runtimeConfig.isDocker for the steps
// that follow, and the evidence that produced it is logged immediately.
const dockerDetection = detectDocker();
const runtimeConfig = { isDocker: dockerDetection.isDocker };
console.log(`[DOCKER] ${describeDockerDetection(dockerDetection)}`);

let executionWorktreePath: string | null = null;
let inExecutionPhase = false;
let activeTaskLifecycle: any = null;
let activeConfigData: any = null;
let activePromptSpecKeeperState: any = null;
let activePromptEpic: any = null;
let activePromptSpecKeeperOptions: any = null;
let mainCheckoutMayHavePartialWork = false;
// Prompts are loaded from external files under /elastic-agent/prompts/
// (relative to the process working directory, which is the repository root).
const planningSuffix = readFileSync("prompts/planning-suffix.txt", "utf-8");
const executionFeedbackFormat = readFileSync("prompts/execution-feedback-format.txt", "utf-8");
const buildPromptTemplate = readFileSync("prompts/build-prompt-skeleton.txt", "utf-8");
const selfModificationSection = readFileSync("prompts/self-modification-section.txt", "utf-8");
const stepExecutionPromptTemplate = readFileSync("prompts/step-execution-prompt.txt", "utf-8");
const replanPromptTemplate = readFileSync("prompts/replan-prompt.txt", "utf-8");
const reviewPromptTemplate = readFileSync("prompts/review-prompt.txt", "utf-8");

// ---------------------------------------------------------------------------
// Loop mode (`--loop`) between-step Agent Bus polling.
//
// When loop mode is enabled the runtime keeps running and, at each execution
// step boundary, polls the Agent Bus feed for new coordination messages. Every
// message is classified (see loop-mode.ts): a *relevant* message (one that
// references the current plan/task ID or carries a plan-change directive) is
// surfaced as a re-plan candidate; any other message is queued durably with
// loop-queue.ts so unrelated coordination never disturbs the plan in flight.
//
// The poll runs on an injectable interval (`LOOP_POLL_INTERVAL_MS`, default
// DEFAULT_LOOP_POLL_INTERVAL_MS) and each individual request is bounded by a
// configurable timeout (`LOOP_POLL_REQUEST_TIMEOUT_MS`) so a hung or
// unconfigured bus never blocks a step boundary indefinitely. Missing queue
// files, a malformed queue, and an unreachable bus are all soft failures: loop
// mode fails open to normal execution rather than crashing the run.
// ---------------------------------------------------------------------------
let pendingLoopReplanMessages: unknown[] = [];

/**
 * The bus poll timing (poll interval + per-request timeout), resolved once at
 * module load from `LOOP_POLL_INTERVAL_MS`/`LOOP_POLL_REQUEST_TIMEOUT_MS` (or
 * the documented defaults). Only relevant when loop mode is active.
 */
const loopPollTiming = resolveLoopPollTiming();

/**
 * The durable queue file path used by loop mode to persist queued (irrelevant)
 * bus messages. It lives in the project root as `bus-queue.json` (see
 * loop-queue.ts) and is drained on a later restart.
 */
const loopQueueFilePath = defaultBusQueueFilePath(mainCwd);

/**
 * The loop-mode bus cursor state file path: `bus-cursor.json` in the project
 * root (git-ignored, alongside `bus-queue.json`). Each poll that receives
 * messages persists the last message's cursor id here, and the next poll
 * resumes from it (or from the in-process cursor) so a restart — or the next
 * pre-planning/between-step/idle poll — keeps reading forward instead of
 * re-delivering the retained window. Never a secrets store and never
 * `data.json`; see loop-busctl-read.ts.
 */
const loopBusCursorFilePath = defaultBusCursorFilePath(mainCwd);

/**
 * Feed path read from the Agent Bus during loop mode. The default is the
 * deployment's messages route; operators may override it via
 * `LOOP_BUS_MESSAGES_PATH`.
 */
const loopBusMessagesPath = process.env.LOOP_BUS_MESSAGES_PATH ?? "/api/v1/messages";

/**
 * Wrap the `agent-busctl watch` shell-out so it satisfies the `AgentBusRead`
 * contract used by pollLoopBusOnce: a single bounded read of the Agent Bus
 * feed that normalizes success/transport failure into a non-throwing result.
 *
 * This deliberately does NOT use the raw authenticated HTTP client
 * (`tools/AgentBus.ts`), which required a bearer credential
 * (`options.accessToken` / `AGENT_BUS_ACCESS_TOKEN`). The real Agent Bus
 * authenticates through the enrolled identity held by `agent-busctl` and
 * driven with `--bus` and `--identity` — no access token is involved (see
 * loop-busctl-read.ts). `watchAgentBusOnce` shells out to that CLI, resolves
 * the bus URL and identity store from the environment or `.agent-bus.local`,
 * and folds any transport failure into a soft "read failed" outcome instead of
 * letting it propagate into the step loop.
 *
 * NO-TIMEOUT: `agent-busctl watch` is a long-lived watch by nature, so
 * `watchAgentBusOnce` applies no external watchdog timeout; shutdown is owned
 * by the caller (loop mode aborts/kills the run) and unexpected process exits
 * are still surfaced. The `requestTimeoutMs` value is used only as the CLI's
 * `--for` watch window (how long it waits for messages before reporting
 * idle), not as a SIGKILL bound.
 */
const loopBusRead: AgentBusRead = async () => {
    // cursorFilePath: enables cursor RESUME — after a poll that receives
    // messages, the last message's cursor id is persisted to bus-cursor.json
    // and the next poll (pre-planning, between-step, or idle) passes it back
    // via `--cursor` so reads keep moving forward across restarts. When no
    // cursor exists yet (a first run), no --cursor flag is passed and the
    // watch starts naturally. See loop-busctl-read.ts resolveStartCursorId.
    return watchAgentBusOnce({
        watchWindowMs: loopPollTiming.requestTimeoutMs,
        cursorFilePath: loopBusCursorFilePath,
    });
};

/**
 * Surface relevant loop-mode bus messages captured in an earlier between-step
 * poll. Step 5 (replanning for relevant messages) consumes this; until then it
 * holds the messages that warrant a re-plan so no relevant directive is lost.
 */
function pendingLoopReplanText(): string {
    return messageToSearchableText(
        (pendingLoopReplanMessages[0] ?? { text: "" }) as { text?: string },
    );
}

/**
 * Perform one between-steps bus poll and route the result:
 *   - relevant messages (plan-change directives / plan-ID references) are
 *     recorded as pending re-plan candidates and reported;
 *   - irrelevant messages are enqueued durably (loop-queue.ts).
 *
 * Returns true when a relevant message was found (the caller should break out
 * of its current step loop and re-enter planning with the message as the new
 * prompt). Transport/unconfiguration failures are soft: they log a warning and
 * return false so the step loop continues normally.
 */
async function pollLoopBusBetweenSteps(reportPrefix = hierarchyIndent("plan")): Promise<boolean> {
    if (!options.loop) return false;
    const planId = runMode.mode === "task" ? runMode.taskId : undefined;
    const result = await pollLoopBusOnce({
        read: loopBusRead,
        path: loopBusMessagesPath,
        requestTimeoutMs: loopPollTiming.requestTimeoutMs,
        queueFilePath: loopQueueFilePath,
        context: { planId, respondAll: runMode.respondAll },
        report: (message) => status.warning(message, reportPrefix),
    });
    if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
            if (result.readFailed) {
                status.warning(`loop poll: ${warning}`, reportPrefix);
            }
        }
    }
    if (result.relevantMessages.length > 0) {
        pendingLoopReplanMessages = [...result.relevantMessages];
        for (const relevant of result.relevantMessages) {
            const text = truncate(messageToSearchableText(relevant as { text?: string }), 240);
            status.replan(`loop mode detected a relevant bus message warranting re-plan: ${text}`, reportPrefix);
        }
        return true;
    }
    // In no-filter / respond-to-everything mode every message is classified as
    // relevant and processed immediately, so there are never irrelevant
    // (queued) messages to report. The count is always 0 in that mode; guard on
    // it explicitly so a future change to classification cannot surface a
    // misleading "queued" log for a mode that processes everything.
    if (!runMode.respondAll && result.queuedCount > 0) {
        status.success(`loop poll: ${result.queuedCount} irrelevant message(s) queued`, reportPrefix);
    }
    return false;
}

/**
 * Perform a single non-blocking Agent Bus poll *before planning starts* and
 * return every relevant message received in that one bounded read (as an
 * `{ text?: string }` array), or `undefined` when there are none.
 *
 * This reuses the same bounded, fail-open read path as `pollLoopBusBetweenSteps`
 * (`loopBusRead` -> `normalizeAgentBusMessages` -> relevant filtering) so a
 * directive that arrived before startup becomes the plan's work order rather
 * than being queued and only picked up at a step boundary. It deliberately
 * does NOT use the blocking `pollLoopBusUntilMessage` loop: it performs exactly
 * one bounded read, so startup never blocks when the bus is idle, unconfigured,
 * or unreachable (transport failures are soft and yield `undefined`). It is a
 * distinct helper from `pollLoopBusBetweenSteps` (which only returns a boolean)
 * because the caller needs the message objects themselves to seed the prompt.
 *
 * ALL relevant messages are returned (not just the first) so that no-filter /
 * respond-to-everything mode (`runMode.respondAll`, see loop-mode.ts) seeds the
 * new work order with every received message via `extractReplanPrompt` — the
 * caller concatenates their text so nothing is dropped, exactly as the between-
 * step replan loop does with `pendingLoopReplanMessages`.
 *
 * No bearer-token gate: this poll goes through `loopBusRead`, which shells out
 * to the `agent-busctl` CLI (see loop-busctl-read.ts). Authentication is
 * handled by the enrolled identity (`--bus` + `--identity`), so no
 * `AGENT_BUS_ACCESS_TOKEN` (or per-call accessToken) is required. When the CLI
 * is unavailable or the bus is unreachable the read fails soft (yields
 * `undefined`) exactly like an idle or unreachable bus.
 */
async function pollAgentBus(): Promise<{ text?: string }[] | undefined> {
    if (!options.loop) return undefined;

    const planId = runMode.mode === "task" ? runMode.taskId : undefined;
    const result = await pollLoopBusOnce({
        read: loopBusRead,
        path: loopBusMessagesPath,
        requestTimeoutMs: loopPollTiming.requestTimeoutMs,
        queueFilePath: loopQueueFilePath,
        context: { planId, respondAll: runMode.respondAll },
        report: (message) => status.warning(message, hierarchyIndent("plan")),
    });
    if (result.relevantMessages.length === 0) return undefined;
    return result.relevantMessages as { text?: string }[];
}

/**
 * Drain the durable Agent Bus queue at loop-mode restart and re-route anything
 * that is now relevant to the current plan.
 *
 * Loop mode persists *irrelevant* messages to `bus-queue.json` during a run so
 * unrelated coordination never disturbs the plan in flight (see loop-queue.ts).
 * `pollLoopBusUntilMessage` and `pollLoopBusOnce` are the only live-read paths —
 * loop mode consumes the Agent Bus *exclusively by polling* and never
 * subscribes, streams, or long-polls. This startup call is the complement to
 * that poll-only contract: it "reads the queue when restarting" (per the
 * loop-mode plan) by draining the durable queue left by a prior run and, for
 * each drained message, re-classifying it against the *current* plan context.
 *
 *   - a drained message that is *relevant now* (it references the current
 *     plan/task ID or carries a plan-change directive) is promoted to a pending
 *     re-plan candidate so the restart re-enters planning with it;
 *   - a drained message that is still irrelevant is acknowledged and dropped —
 *     it was queued precisely because it must not interrupt execution, and
 *     replaying it verbatim into a new plan could corrupt the work order.
 *
 * Fail-soft contract: a missing/corrupt queue, or a single bad drained message,
 * never aborts startup. They surface as [WARNING]s and the loop continues to
 * its normal poll-only execution.
 */
async function drainLoopQueueAtRestart(reportPrefix = hierarchyIndent("plan")): Promise<void> {
    const planId = runMode.mode === "task" ? runMode.taskId : undefined;
    const context = { planId, respondAll: runMode.respondAll };

    let warnings: string[] = [];
    let promotedCount = 0;
    const drain = await drainBusQueue(loopQueueFilePath, {
        handler: (entry) => {
            const classification = classifyAgentBusMessage(entry.message as never, context);
            if (classification.kind === "relevant") {
                pendingLoopReplanMessages.push(entry.message);
                promotedCount += 1;
            }
        },
    });
    warnings = warnings.concat(drain.warnings);

    for (const warning of warnings) status.warning(`loop queue: ${warning}`, reportPrefix);

    if (drain.drainedCount === 0 && warnings.length === 0) return;

    if (promotedCount > 0) {
        const text = truncate(pendingLoopReplanText() || "a plan-change directive", 240);
        status.replan(
            `Loop mode restart: drained ${drain.drainedCount} queued message(s); ${promotedCount} are relevant now and warrant a re-plan: ${text}`,
            reportPrefix,
        );
    } else {
        status.success(
            `Loop mode restart: drained ${drain.drainedCount} queued message(s); none are relevant to the current plan.`,
            reportPrefix,
        );
    }
}

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
    response: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.gray("[RESPONSE]"), message, prefix),
    success: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.green.bold("[SUCCESS]"), message, prefix),
    feedback: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.magenta.bold("[FEEDBACK]"), message, prefix),
    change: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.cyan.bold("[PLAN CHANGE]"), message, prefix),
    replan: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.magenta.bold("[REPLAN]"), message, prefix),
    warning: (message: string, prefix = "") => printStatusLine((line) => console.warn(line), chalk.yellow.bold("[WARNING]"), message, prefix),
    error: (message: string, prefix = "") => printStatusLine((line) => console.error(line), chalk.red.bold("[ERROR]"), message, prefix),
    classification: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.cyan.bold("[PLANNING NECESSITY]"), message, prefix),
    specKeeper: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.magenta.bold("[SPEC KEEPER]"), message, prefix),
    abort: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.red.bold("[ABORT]"), message, prefix),
    tldr: (message: string, prefix = "") => printStatusLine((line) => console.log(line), chalk.cyan.bold("[TLDR]"), message, prefix),
};

/**
 * Persist a `lastAbort` entry on the run config before exiting. The entry is
 * bounded and secret-safe so a later run can report what aborted without
 * leaking model or tool payloads. Uses the existing saveData behavior, which
 * is best-effort and never throws.
 */
function recordLastAbort(configData: any, error: RunAbortError): void {
    if (!configData) return;
    configData.lastAbort = {
        kind: error.kind,
        phase: error.phase,
        step: error.step ?? null,
        reason: boundedAbortReason(error.message),
        timestamp: new Date().toISOString(),
    };
    saveData(configData);
}

/**
 * Detect provider-side cancellation that was not requested by our own signal.
 * Per ABORT_SEMANTICS.md section 4.3, a generation that ends with
 * finishReason "cancelled" while our AbortSignal is still un-aborted is an
 * unable-to-complete abort, not a user-triggered one.
 */
function throwIfProviderCancelled(response: { finishReason?: string }, phase: RunAbortPhase, step?: number): void {
    if (response.finishReason === "cancelled" && !abortController.signal.aborted) {
        throw new RunAbortError(
            "unable-to-complete",
            phase,
            "provider cancelled generation",
            step === undefined ? undefined : { step },
        );
    }
}

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
 * Indentation prefix for child tool-call feedback lines emitted below the
 * pending `ToolName(args)` line. The pending line uses the content-in-step
 * indent of 6 spaces, and these result/timer lines sit one hierarchy level
 * below it at the tool-result indent of 8 spaces, sourced from
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
        type: "function", name: "Delete",
        usage_prompt: "tools/delete-usage.md",
        description: "Permanently delete a regular file, but only after verifying the file at path currently has exactly the supplied file_hash (SHA-256, 64 hex chars) AND file_size (bytes). If either value is missing, malformed, or does not match the file on disk, the tool aborts and leaves the file untouched. Read the file (for its read_hash) and FileSize it before calling, then delete with those exact values. Never use shell rm for an in-workspace file; use this tool.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                file_hash: { type: "string", description: "SHA-256 of the file's current bytes, encoded as exactly 64 lowercase hex characters (the read_hash returned by Read)." },
                file_size: { type: "number", description: "Exact size of the file in bytes (the size returned by FileSize). Must match the file on disk or the tool aborts." },
            },
            required: ["path", "file_hash", "file_size"],
        },
        exec_handler: ({ path, file_hash, file_size }) => Delete({ path, file_hash, file_size }),
    },
    {
        type: "function", name: "Read",
        usage_prompt: "tools/read-usage.md",
        description: "Read a UTF-8 file after first obtaining its size with FileSize. Use read_offset and read_length to read a byte window, or pass an optional inclusive 1-based line_range such as '100-200' to read only those lines. Refuses files larger than 500k.",
        parameters: ReadParameters,
        exec_handler: ({ path, file_size, read_length, read_offset, line_range, read_hash }) => Read({ path, file_size, read_length, read_offset, line_range, read_hash }),
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
        description: "Edit a file in place using replacement operations. Provide the read_hash returned by the last Read (or Write/Edit) of this file so an edit only applies when the file is unchanged. Use either string replacement (a single old_string/new_string pair or an ordered edits array, each old_string appearing exactly once) or line-range mode (line_range plus content replaces exactly those inclusive 1-based lines).",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" }, read_hash: { type: "string" },
                old_string: { type: "string" }, new_string: { type: "string" },
                edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" } }, required: ["old_string", "new_string"] } },
                line_range: { type: "string", description: "Optional inclusive 1-based line range such as '100-200' (or '100' for a single line). Use with content to replace exactly those lines. Cannot be combined with old_string/new_string/edits." },
                content: { type: "string", description: "Replacement text for line_range mode. Use an empty string to delete the selected lines. Valid only together with line_range." },
            }, required: ["path", "read_hash"],
        },
        exec_handler: ({ path, read_hash, old_string, new_string, edits, line_range, content }) => Edit({ path, read_hash, old_string, new_string, edits, line_range, content }),
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
        type: "function", name: "Mkdir",
        usage_prompt: "tools/mkdir-usage.md",
        description: "Create a directory at path. When recursive is true, any missing parent directories are created as well (like mkdir -p); otherwise a missing parent rejects. Existing directories are accepted as a no-op.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                recursive: { type: "boolean", description: "Create missing parent directories as needed (default false)." },
            },
            required: ["path"],
        },
        exec_handler: ({ path, recursive }) => Mkdir({ path, recursive }),
    },
    {
        type: "function", name: "Rmdir",
        usage_prompt: "tools/rmdir-usage.md",
        description: "Remove a directory. Without recursive, only an empty directory is removed and a non-empty one rejects; pass recursive:true to remove the directory tree and its contents explicitly. Never removes a regular file (use Delete for files).",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                recursive: { type: "boolean", description: "Remove the directory tree and its contents (default false)." },
            },
            required: ["path"],
        },
        exec_handler: ({ path, recursive }) => Rmdir({ path, recursive }),
    },
    {
        type: "function", name: "Find",
        usage_prompt: "tools/find-usage.md",
        description: "Search a directory for entries matching an optional name glob and entry type, recursing up to an optional maxdepth. Returns matching entry paths in depth-first order.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                name: { type: "string", description: "Optional basename glob: * (any run), ? (one char), or an exact name." },
                type: { type: "string", enum: ["file", "directory"], description: "Optional entry-type filter." },
                maxdepth: { type: "number", description: "Optional maximum recursion depth below path (0 matches only the path's own entries)." },
            },
            required: ["path"],
        },
        exec_handler: ({ path, name, type, maxdepth }) => Find({ path, name, type, maxdepth }),
    },
    {
        type: "function", name: "Grep",
        usage_prompt: "tools/grep-usage.md",
        description: "Search a single file or a directory for contents matching a literal text or regular expression, returning path:line:text matches and the set of matching files. Directory searches descend recursively when recursive:true. Read-only; refuses to inspect files larger than 500k and never searches data.json.",
        parameters: GrepParameters,
        exec_handler: ({ pattern, path, name, recursive, literal, maxdepth, ignoreCase, maxFileSize, limit }) => Grep({ pattern, path, name, recursive, literal, maxdepth, ignoreCase, maxFileSize, limit }),
    },
    {
        type: "function", name: "ExecuteCommand",
        usage_prompt: "tools/execute-command-usage.md",
        description: "Run a Bash command and return its exit code, standard output, and standard error. Parameters are safely supplied as positional arguments. Refuses all agent-bus actions (agent-busctl/agentbus/agent-bus); use the AgentBus or AgentBusEnrol tool instead.",
        parameters: {
            type: "object",
            properties: { command: { type: "string" }, parameters: { type: "array", items: { type: "string" } } },
            required: ["command"],
        },
        exec_handler: ({ command, parameters }) => ExecuteCommand(command, parameters, toolSafetyConfig.startDirConfigured ? toolSafetyConfig.startDir : undefined),
    },
    {
        type: "function", name: "Git",
        usage_prompt: "tools/git-usage.md",
        description: "Inspect a Git repository (status, log, diff, ls-files), stage selected changes, or commit staged changes.",
        parameters: GitParameters,
        exec_handler: (options) => {
            // In review mode, execution steps stage changes in the worktree and
            // never commit; committing is performed only by the review step when
            // it is happy. Without review mode, inExecutionPhase stays false and
            // the Git tool may commit normally.
            if (options.action === "commit" && inExecutionPhase) {
                const message = executionWorktreePath
                    ? "The Git tool cannot commit during the execution phase. Changes are staged in the execution worktree; only the review step commits when it is satisfied."
                    : "The Git tool cannot commit during the execution phase; the --review flag requires the work to remain uncommitted.";
                // Throwing routes this through the normal tool-error path so
                // the terminal renders it as an error while the model still
                // receives the same serialized `{ error }` result.
                throw new Error(message);
            }
            return Git(options);
        },
    },
    {
        type: "function", name: "AgentBus",
        usage_prompt: "tools/agent-bus-usage.md",
        description: "Send coordination messages, long-poll wait for incoming messages, and check identity — exclusively through the local agent-busctl CLI (never HTTP).",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["whoami", "watch", "send", "agents", "logout", "help"], description: "Which agent-busctl action to run; inferred when omitted (to -> send, a wait bound -> watch, otherwise whoami). enrol lives in AgentBusEnrol and broadcast is not a real subcommand." },
                verify: { type: "boolean", description: "[whoami] authenticate against the bus (--verify)." },
                forDuration: { type: "string", description: "[watch] how long to wait for a message, e.g. \"30s\" (--for <dur>)." },
                count: { type: "number", description: "[watch] stop after N messages (--count N)." },
                to: { type: "string", description: "[send] fully-qualified recipient <bus-id>.<agent-id>; a bare name is refused by agent-busctl." },
                message: { type: "string", description: "[send] the message body, sent verbatim as a single argument. Must never carry secret-store or data.json contents." },
                json: { type: "boolean", description: "machine-readable output (--json); defaults true." },
                identity: { type: "string", description: "override the default --identity <dir> credential-store directory; default <root>/tmp/elastic-identity, or the enrolled identityStore in .agent-bus.local when present." },
                persistSession: { type: "boolean", description: "apply --persist-session to reuse the session token across processes; defaults true." },
                busUrl: { type: "string", description: "override the --bus <url>; when omitted the CLI resolves it from its own store." },
                binary: { type: "string", description: "path to the agent-busctl binary; default <root>/agent-busctl." },
                root: { type: "string", description: "workspace root used to resolve relative paths and defaults; defaults to cwd." },
            },
        },
        exec_handler: (options) => AgentBus(options),
    },
    {
        type: "function", name: "AgentBusEnrol",
        usage_prompt: "tools/agent-bus-enrol-usage.md",
        description: "Redeem an agent-bus enrollment invite through the local agent-busctl client, store the identity, and record non-secret roster metadata in .agent-bus.local.",
        parameters: {
            type: "object",
            properties: {
                inviteFile: { type: "string", description: "Path to the invite JSON file; defaults to the single agent-bus-invite-*.json match in the repo root." },
                name: { type: "string", description: "Agent name to enrol as; defaults to the invite's embedded name." },
                identity: { type: "string", description: "Directory where agent-busctl stores the enrolled identity credentials; defaults to <repoRoot>/.agent-bus-identity." },
                rootDir: { type: "string", description: "Repo/workspace root used to locate agent-busctl and the .agent-bus.local store." },
            },
        },
        exec_handler: (options) => AgentBusEnrol(options),
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

/**
 * Emit tool-renderer lines under the tool-result hierarchy indent without any
 * legacy [TOOL]/[SUCCESS]/[ERROR] status label. The shared render helper and
 * per-tool renderers own circle/status formatting; this function only owns
 * indentation and the write target.
 */
function emitToolLines(lines: string[], prefix = toolChildIndent): void {
    for (const line of lines) console.log(`${prefix}${line}`);
}

/**
 * Emit the pending tool-call label as `ToolName(args)` before argument parsing
 * or execution. The label is produced by the per-tool renderer map so every
 * tool shares the same heading format without a legacy `[TOOL] Pending:`
 * prefix, while a tool can still customize or suppress its pending line.
 */
function renderToolCallPending(toolCall) {
    const lines = renderToolPhase("pending", toolCall, undefined, { color: terminalColor });
    for (const line of lines) console.log(`${hierarchyIndent("contentInStep")}${line}`);
}

/**
 * Render a completed tool call through the per-tool renderer map first so
 * specialized result views (the Edit diff, Git structured status, and
 * redacted secret-carrying tools) are used when intended. Command-shaped tools
 * (ExecuteCommand and the non-status Git modes) delegate to the shared
 * tool-command helper inside their own renderers, so the circle/stdout/stderr
 * rules stay exactly the same. No legacy [SUCCESS]/[ERROR] prefix is emitted.
 */
function renderToolCallSucceeded(toolCall, result) {
    emitToolLines(renderToolPhase("succeeded", toolCall, result, { color: terminalColor }));
}

function renderToolCallFailed(toolCall, error) {
    emitToolLines(renderToolPhase("failed", toolCall, error, { color: terminalColor }));
}
function appendHistory(history, value) { history.push(value); if (history.length > historyLimit) history.splice(0, history.length - historyLimit); }
// renderPrompt and buildPrompt live in ./prompt-builder.js so the prompt
// flag-state gating can be unit tested without booting the side-effectful CLI.
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
 * Post one progress note to the active task-mode Spec Keeper task. Notes are
 * best-effort lifecycle updates: a failed note is surfaced as a [WARNING] and
 * never aborts the run.
 */
async function specKeeperTaskNote(taskLifecycle: any, action: string, note: string): Promise<void> {
    if (!taskLifecycle) return;
    await specKeeperSync(
        `task ${taskLifecycle.taskId} ${action}`,
        () => postSpecKeeperTaskNote(taskLifecycle.taskId, note, taskLifecycle.options),
    );
}

/**
 * Update the active task-mode Spec Keeper task status with an optional status
 * note. Failures are best-effort and surfaced as [WARNING] diagnostics.
 */
async function specKeeperTaskStatus(
    taskLifecycle: any,
    action: string,
    status: string,
    statusNote?: string,
): Promise<void> {
    if (!taskLifecycle) return;
    await specKeeperSync(
        `task ${taskLifecycle.taskId} ${action}`,
        () => updateSpecKeeperTaskStatus(taskLifecycle.taskId, status, statusNote, taskLifecycle.options),
    );
}

/**
 * Attach a proof artifact to the active task-mode Spec Keeper task. The proof
 * helper falls back from the task proof field to a proof note when the field is
 * not supported by the deployed schema. Any final failure is surfaced as a
 * [WARNING] and returned as an unattached result.
 */
async function specKeeperTaskProof(taskLifecycle: any, proof: any): Promise<any> {
    if (!taskLifecycle) return null;
    const result = await attachSpecKeeperTaskProof(taskLifecycle.taskId, proof, taskLifecycle.options);
    if (result.attached) {
        status.specKeeper(`task ${taskLifecycle.taskId} proof attached via ${result.method}.`);
    } else {
        status.warning(`Spec Keeper task ${taskLifecycle.taskId} proof not attached: ${result.error ?? "unknown error"}.`);
    }
    return result;
}

/**
 * Log finalization diagnostics without exposing request or response bodies.
 */
function logTaskFinalizationDiagnostics(taskId: string, result: { diagnostics: string[] }): void {
    for (const diagnostic of result.diagnostics) {
        status.warning(`Spec Keeper task ${taskId} final update diagnostic: ${diagnostic}`);
    }
}

/**
 * Mark the active task-mode Spec Keeper task complete with a note, status done,
 * and the supplied proof artifact. The proof should include commit or test
 * evidence when available. Finalization is best-effort and never throws; each
 * failed update is surfaced as a [WARNING].
 */
async function finalizeTaskModeSuccess(taskLifecycle: any, proof: any): Promise<void> {
    if (!taskLifecycle || taskLifecycle.finalized) return;
    taskLifecycle.finalized = true;
    const result = await completeSpecKeeperTask(taskLifecycle.taskId, proof, taskLifecycle.options);
    logTaskFinalizationDiagnostics(taskLifecycle.taskId, result);
    status.specKeeper(`task ${taskLifecycle.taskId} completed (status=${result.status}, note=${result.noteRecorded ? "recorded" : "failed"}, proof=${result.proofMethod}).`);
}

/**
 * Mark the active task-mode Spec Keeper task failed or blocked with the
 * supplied diagnostic. The diagnostic is written as a note, status note, and
 * proof payload. Finalization is best-effort and never throws; each failed
 * update is surfaced as a [WARNING].
 */
async function finalizeTaskModeFailure(taskLifecycle: any, diagnostic: string): Promise<void> {
    if (!taskLifecycle || taskLifecycle.finalized) return;
    taskLifecycle.finalized = true;
    const result = await failSpecKeeperTask(taskLifecycle.taskId, diagnostic, taskLifecycle.options);
    logTaskFinalizationDiagnostics(taskLifecycle.taskId, result);
    status.specKeeper(`task ${taskLifecycle.taskId} ${result.status} (note=${result.noteRecorded ? "recorded" : "failed"}, proof=${result.proofMethod}).`);
}

/**
 * Mark the active task-mode Spec Keeper task blocked with the abort reason in
 * the exact note form `Aborted (<kind>): <bounded reason>`. Finalization is
 * best-effort and never throws, and a failed update must not change the abort
 * exit code or mask the abort reason.
 */
async function finalizeTaskModeAbort(taskLifecycle: any, error: RunAbortError): Promise<void> {
    if (!taskLifecycle || taskLifecycle.finalized) return;
    taskLifecycle.finalized = true;
    const result = await abortSpecKeeperTask(taskLifecycle.taskId, error.kind, boundedAbortReason(error.message), taskLifecycle.options);
    logTaskFinalizationDiagnostics(taskLifecycle.taskId, result);
    status.specKeeper(`task ${taskLifecycle.taskId} ${result.status} (note=${result.noteRecorded ? "recorded" : "failed"}, proof=${result.proofMethod}).`);
}

/**
 * Apply the prompt-mode abort transition to any Spec Keeper artifacts created
 * for this run: mark the epic, run task, and unfinished plan-step tasks
 * blocked with the abort reason as the status note. Each update is best-effort
 * through specKeeperSync, so failures are [WARNING]s and never change the
 * abort exit code.
 */
async function finalizePromptSpecKeeperAbort(error: RunAbortError): Promise<void> {
    const abortNote = `Aborted (${error.kind}): ${boundedAbortReason(error.message)}`;
    const state = activePromptSpecKeeperState;
    const options = state?.taskUpdateOptions ?? activePromptSpecKeeperOptions ?? {};
    const epic = state?.epic ?? activePromptEpic;

    if (epic) {
        await specKeeperSync("epic blocked", async () => updateEpicStatus(epic, "blocked", options));
    }
    if (state?.runTask) {
        await specKeeperSync("run task blocked", async () => updateTaskStatus(state.runTask, "blocked", abortNote, options));
    }
    for (const stepTask of state?.stepTasks ?? []) {
        if (!stepTask) continue;
        if (String(stepTask.status ?? "").toLowerCase() === "done") continue;
        await specKeeperSync("plan step task blocked", async () => updateTaskStatus(stepTask, "blocked", abortNote, options));
    }
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
    for (let retry = 0; retry <= maxReviewParseRetries; retry += 1) {
        throwIfAborted(abortController.signal, "review");
        const promptToSend = retry === 0 && !validationError
            ? reviewRequest
            : `${reviewRequest}\n\nThe previous response was not valid JSON. Here's the error: ${
                validationError ?? lastParsed?.reason ?? "unknown"}. Please return valid JSON following this exact structure.`;
        const response = await client.create({ input: promptToSend, abortPhase: "review" });
        new CompatibleResponseWrapper(response).print();
        recordUsage(configData, response);
        throwIfProviderCancelled(response, "review");
        lastParsed = parseReviewResult(responseText(response));
        if (lastParsed.valid) return lastParsed.review as NonNullable<typeof lastParsed.review>;
    }
    const reason = `Review response was not valid JSON after ${maxReviewParseRetries} retries: ${lastParsed?.reason ?? "unknown"}`;
    status.error(reason);
    throw new RunAbortError("unable-to-complete", "review", reason);
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
    const step = completedStepCount + 1;
    throwIfAborted(abortController.signal, "replan", step);
    const remainingStart = completedStepCount + 1;
    const remainingSteps = activeSteps.slice(remainingStart);
    const feedback = feedbackEntry?.feedback;
    if (!feedbackEntry?.valid || !feedback?.replanRequired) return { attempted: false, applied: false };
    if (remainingSteps.length === 0) {
        status.warning("Replan request skipped because there are no remaining steps to replace.", hierarchyIndent("contentInStep"));
        return { attempted: false, applied: false, reason: "No remaining plan steps." };
    }

    throwIfReplanAttemptLimitReached(configData, step, maxReplanAttempts);
    throwIfReplanTimeBudgetExceeded(configData, step, maxReplanDurationMs);

    const beforeKey = replanRemainingKey(activeSteps, completedStepCount);
    const attemptStart = Date.now();
    configData.replanAttemptCount += 1;
    const attempt = configData.replanAttemptCount;
    status.replan(`Requesting focused revised plan (attempt ${attempt}/${maxReplanAttempts}): ${truncate(feedback.replanReason)}`, hierarchyIndent("contentInStep"));
    const completedWork = (configData.completedSteps ?? []).map((entry) => `${entry.step}. ${entry.text}`).join("\n") || "(none)";
    const toolFindings = (configData.toolCallTldrs ?? []).slice(-historyLimit).join("\n") || "(none)";
    const currentPhase = configData.planPhase === undefined ? "(none)" : String(configData.planPhase);
    const request = renderPrompt(replanPromptTemplate, { claudeInstructions, completedWork, feedback, toolFindings, formatPlan, remainingSteps, currentPhase });
    let lastFailure = "unknown";
    try {
        for (let parseAttempt = 0; parseAttempt <= maxReplanParseRetries; parseAttempt += 1) {
            throwIfAborted(abortController.signal, "replan", step);
            const promptToSend = parseAttempt === 0
                ? request
                : `${request}\n\nThe previous revised plan response was not valid JSON. Here's the error: ${lastFailure}. Please return valid JSON following the requested structure.`;
            const response = await client.create({ input: promptToSend, abortPhase: "replan" });
            new CompatibleResponseWrapper(response).print(hierarchyIndent("contentInStep"));
            recordUsage(configData, response);
            throwIfProviderCancelled(response, "replan", step);
            const validation = parseReplanResponse(responseText(response));
            if (validation.valid && validation.abort) {
                throw new RunAbortError("unable-to-complete", "replan", validation.reason, { step });
            }
            if (validation.valid) {
                const revisedSteps: string[] = validation.steps as string[];
                const nextPhase = validation.phase;
                // A replan that moves the plan into a different top-level phase is
                // a phase-level change: it abandons executed progress and restarts
                // the whole plan. Edits that keep the same phase (or omit phase)
                // only replace the remaining steps and continue in place.
                const restart = phaseRestartRequired(configData.planPhase, nextPhase);
                if (restart) {
                    activeSteps.splice(0, activeSteps.length, ...revisedSteps);
                    configData.completedSteps = [];
                    configData.planPhase = nextPhase;
                    configData.consecutiveNoProgressReplans = 0;
                    configData.replanHistory.push({
                        attempt,
                        response_id: response.id,
                        reason: feedback.replanReason,
                        applied: true,
                        replacementStepCount: revisedSteps.length,
                        phaseChange: true,
                        noProgress: false,
                    });
                    recordReplanElapsedAndAssertBudget(configData, step, attemptStart, maxReplanDurationMs);
                    status.change(`Accepted phase-changing replan: moved into phase \`${String(nextPhase)}\` and restarted the entire plan with ${revisedSteps.length} step${revisedSteps.length === 1 ? "" : "s"}.`, hierarchyIndent("contentInStep"));
                    return { attempted: true, applied: true, steps: revisedSteps, restart: true, phase: nextPhase };
                }
                activeSteps.splice(remainingStart, remainingSteps.length, ...revisedSteps);
                const afterKey = replanRemainingKey(activeSteps, completedStepCount);
                const progressed = afterKey !== beforeKey;
                configData.consecutiveNoProgressReplans = nextConsecutiveNoProgressReplans(
                    progressed,
                    configData.consecutiveNoProgressReplans ?? 0,
                );
                configData.replanHistory.push({
                    attempt,
                    response_id: response.id,
                    reason: feedback.replanReason,
                    applied: true,
                    replacementStepCount: revisedSteps.length,
                    noProgress: !progressed,
                });
                recordReplanElapsedAndAssertBudget(configData, step, attemptStart, maxReplanDurationMs);
                throwIfConsecutiveNoProgressReplansReached(configData.consecutiveNoProgressReplans ?? 0, maxConsecutiveNoProgressReplans, step);
                status.change(`Accepted focused replan: replaced ${remainingSteps.length} remaining step${remainingSteps.length === 1 ? "" : "s"} with ${revisedSteps.length}.`, hierarchyIndent("contentInStep"));
                return { attempted: true, applied: true, steps: revisedSteps };
            }
            lastFailure = validation.reason;
            configData.replanHistory.push({ attempt, response_id: response.id, reason: feedback.replanReason, applied: false, failure: lastFailure });
            if (parseAttempt < maxReplanParseRetries) {
                status.warning(`Replan response was not valid JSON; sending a retry request with the parsing error appended: ${lastFailure}`, hierarchyIndent("contentInStep"));
            }
        }

        // Parse-retry exhaustion is unable-to-complete. Record elapsed time
        // without throwing the stuck budget error so unable-to-complete keeps
        // its documented precedence over stuck when both would fire at once.
        configData.replanElapsedMs = (configData.replanElapsedMs ?? 0) + (Date.now() - attemptStart);
        throw new RunAbortError("unable-to-complete", "replan", `Revised plan response was not valid after ${maxReplanParseRetries} parse retries: ${lastFailure}`, { step });
    } catch (error) {
        throwIfAborted(abortController.signal, "replan", step);
        if (error instanceof RunAbortError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        recordReplanElapsedAndAssertBudget(configData, step, attemptStart, maxReplanDurationMs);
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
/**
 * Count classifier-denial goals that reached the "fighting" threshold during
 * this run. `denialTrackerState` is the serialized DenialTracker (see
 * denial-tracker.ts): `{ goals: { goalKey: { count, lastTool, lastReason } } }`.
 * A goal counts as fighting once its consecutive-denial count reaches the
 * DENIAL_REPLAN_THRESHOLD.
 */
function fightingDenialCount(configData): number {
    const goals = configData?.denialTrackerState?.goals ?? {};
    const values = typeof goals === "object" && !Array.isArray(goals) ? Object.values(goals) : [];
    return values.filter((goal: any) => goal && Number.isInteger(goal.count) && goal.count >= DENIAL_REPLAN_THRESHOLD).length;
}

/**
 * Build and print a concise end-of-plan summary (the implementation tldr) of
 * what actually happened during execution, just before the terminal "Plan
 * complete." line. It surfaces the information the operator most wants from a
 * finished plan in one place:
 *   - how many of the plan's steps were completed;
 *   - every replan that occurred (applied focused replans vs failed ones) plus
 *     any loop-mode replan directives issued from classifier denials;
 *   - issues / blockers encountered (replan failures, repeated classifier
 *     denials, and review learnings/reasons when a review ran);
 *   - a short, honest evaluation of whether the outcome matched the prompt,
 *     derived from the recorded outcome (review pass/fail, direct completion).
 *
 * All counts are derived from configData that is already persisted and
 * secret-free; nothing here reads a model response or a file payload. The
 * output uses the shared status.tldr helper so it fits the existing console
 * hierarchy (plan-level indent) and degrades gracefully when there is no
 * detailed state (it falls back to "no issues recorded" rather than throwing).
 */
function reportImplementationTldr(
    configData: any,
    originalPrompt: string,
    options: { taskMode?: boolean; direct?: boolean; reviewOutcome?: "passed" | "failed" | null; reviewAttempts?: number } = {},
): void {
    const prefix = hierarchyIndent("plan");
    const completedSteps = Array.isArray(configData?.completedSteps) ? configData.completedSteps : [];
    const replans = Array.isArray(configData?.replanHistory) ? configData.replanHistory : [];
    const appliedReplans = replans.filter((entry) => entry && entry.applied === true);
    const failedReplans = replans.filter((entry) => entry && entry.applied === false);

    const summaryLines: string[] = [];
    summaryLines.push(`Steps completed: ${completedSteps.length}.`);

    if (appliedReplans.length > 0) {
        const detail = appliedReplans
            .map((entry) => truncate(String(entry.reason ?? ""), 120))
            .filter(Boolean)
            .join(" | ");
        summaryLines.push(`Replans applied: ${appliedReplans.length}${detail ? ` — ${detail}` : ""}.`);
    } else {
        summaryLines.push("Replans applied: none.");
    }
    if (failedReplans.length > 0) {
        summaryLines.push(`Replans failed: ${failedReplans.length} (${failedReplans.map((entry) => truncate(String(entry.failure ?? entry.reason ?? ""), 100)).filter(Boolean).join(" | ") || "no reason recorded"}).`);
    }

    // Issues / blockers: classifier-denial "fighting" count plus any recorded
    // review learnings/reasons. Both are bounded and secret-free.
    const issues: string[] = [];
    const fightingCount = fightingDenialCount(configData);
    if (fightingCount > 0) issues.push(`${fightingCount} goal(s) hit repeated classifier denials (fighting-the-classifier)`);
    for (const entry of failedReplans) {
        const reason = truncate(String(entry.failure ?? entry.reason ?? "replan failed"), 100);
        if (reason) issues.push(`replan failure: ${reason}`);
    }
    if (options.reviewOutcome === "failed") {
        issues.push("review did not pass (work left uncommitted, task blocked)");
    }
    if (issues.length > 0) {
        summaryLines.push(`Issues / blockers: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? "; ..." : ""}.`);
    } else {
        summaryLines.push("Issues / blockers: none recorded.");
    }

    // Evaluation of whether the outcome matched the prompt.
    let evaluation: string;
    if (options.reviewOutcome === "failed") {
        evaluation = "Outcome did not fully match the prompt: the review failed, so the work was left uncommitted and the task was marked blocked.";
    } else if (options.direct) {
        evaluation = "Outcome: single-step (no-plan) execution completed and matched the requested work.";
    } else if (options.reviewOutcome === "passed") {
        evaluation = `Outcome: execution completed and the review passed${options.reviewAttempts ? ` on attempt ${options.reviewAttempts}` : ""}; the outcome matches the prompt.`;
    } else {
        evaluation = "Outcome: execution completed and the plan was fully executed; the outcome matches the prompt.";
    }
    summaryLines.push(`Evaluation: ${evaluation}`);

    status.tldr(summaryLines.join("\n"), prefix);
    void originalPrompt; // originalPrompt is intentionally accepted for future use; not printed (avoids echoing the full prompt).
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

/**
 * Load (or create) the persisted fighting-with-classifier counter from
 * configData. The tracker is stored in configData.denialTrackerState so its
 * per-goal denial counts survive across saveData/reload cycles. threshold
 * defaults to DENIAL_REPLAN_THRESHOLD.
 */
function loadDenialTracker(configData, threshold = DENIAL_REPLAN_THRESHOLD) {
    return new DenialTracker(threshold, configData?.denialTrackerState);
}

/** Persist the fighting-with-classifier counter back into configData. */
function persistDenialTracker(configData, tracker) {
    if (!configData) return;
    configData.denialTrackerState = tracker.toJSON();
}

/**
 * Shared tool-call dispatch used by both executePlanStep and runSingleStep.
 * Pending output is emitted before argument parsing, and the safety classifier
 * runs before any exec_handler so an unsafe call never reaches the tool. If the
 * classifier itself fails, mutating and high-risk tools fail closed; read-only
 * tools may proceed only with an explicit warning so the check is never
 * silently bypassed. Once the call is cleared, an in-place timer tracks the
 * command and success/failure output routes through the shared render helper.
 *
 * The fighting-with-classifier counter is wired in here: every classifier
 * denial increments a per-goal counter, and when repeated denials for the same
 * goal reach the threshold the denied result carries an explicit REPLAN
 * DIRECTIVE telling the model to stop repeating the blocked action and re-plan.
 * Progress (a successful call) resets the current goal's counter, and the
 * tracker is reset at plan/step boundaries in runExecutionPhase and
 * runSingleStep, so a fresh approach is not mistaken for fighting.
 */
async function dispatchToolCall(output, configData, goalKey) {
    throwIfAborted(abortController.signal, "execution");
    renderToolCallPending(output);
    const tool = tools.find((candidate) => candidate.name === output.name);
    let toolArguments;
    try {
        toolArguments = JSON.parse(output.arguments);
    } catch (error) {
        const message = `Tool arguments could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`;
        renderToolCallFailed(output, { error: message });
        return { output, toolArguments: {}, toolResponse: { error: message }, errorMessage: message };
    }

    if (!tool?.exec_handler) {
        const message = `No exec_handler found for tool: ${output.name}`;
        renderToolCallFailed(output, { error: message });
        return { output, toolArguments, toolResponse: { error: message }, errorMessage: message };
    }

    // ExecuteCommand preflight: keep supported git commands on the dedicated
    // Git tool. Clear mappings (status/log/diff/ls-files/add/commit) are
    // refused with an actionable Git tool suggestion before the general safety
    // classifier runs; unclear mappings are sent to the git-command router LLM
    // and its refusal is respected here.
    //
    // Agent-bus commands are refused here (before the safety classifier, which
    // makes LLM/HTTP calls) because all agent-bus activity is owned by the
    // dedicated AgentBus (whoami/watch/send/agents/logout/help) and
    // AgentBusEnrol (enroll) tools.
    // `detectAgentBusCommand` is pure string logic with no I/O, so this guard
    // runs safely before any file/identity read or HTTP call. See
    // tools/agent-bus-detect.ts for the exact matching rules.
    if (output.name === "ExecuteCommand") {
        const command = toolArguments && typeof toolArguments === "object" && !Array.isArray(toolArguments)
            ? toolArguments.command
            : undefined;
        const commandText = typeof command === "string" ? command : "";
        const agentBusDetection = detectAgentBusCommand(commandText);
        if (agentBusDetection.action === "refuse") {
            renderToolCallFailed(output, { error: agentBusDetection.reason });
            return { output, toolArguments, toolResponse: { error: agentBusDetection.reason }, errorMessage: agentBusDetection.reason };
        }
        const routing = await routeGitExecuteCommand(command, {
            runtime: client,
            promptPath: isAbsolute(GIT_COMMAND_ROUTER_PROMPT_PATH)
                ? GIT_COMMAND_ROUTER_PROMPT_PATH
                : join(mainCwd, GIT_COMMAND_ROUTER_PROMPT_PATH),
        });
        if (routing.action === "refuse") {
            renderToolCallFailed(output, { error: routing.reason });
            return { output, toolArguments, toolResponse: { error: routing.reason }, errorMessage: routing.reason };
        }
    }

    // Classifier trusted-root selection. When --start-dir is explicitly
    // configured, all work is confined to that single directory: the workspace
    // root becomes the canonical start directory and the process's original
    // start-up directory is *removed* from the allowed set, so neither the
    // logical pwd nor its canonical form are trusted any longer. When
    // --allow-agent-source-modifications is set, the only trusted/allowed root
    // is the canonical agent-source root (the directory containing main.ts),
    // which is also the authoritative cwd. Otherwise the running directory and
    // its canonical form from workspace-init are the trusted "local" roots.
    const classifierWorkspaceRoot = toolSafetyConfig.startDirConfigured
        ? toolSafetyConfig.startDir
        : toolSafetyConfig.allowAgentSourceModifications
            ? toolSafetyConfig.agentSourceDir
            : process.cwd();
    const classifierAllowedDirectories = toolSafetyConfig.startDirConfigured
        ? [toolSafetyConfig.startDir]
        : toolSafetyConfig.allowAgentSourceModifications
            ? [toolSafetyConfig.agentSourceDir]
            : workspaceInit.allowedDirectories;

    let classification;
    try {
        classification = await classifyToolCall(output.name, toolArguments, {
            runtime: client,
            workspaceRoot: classifierWorkspaceRoot,
            // Without --start-dir, the starting-directory init provides both
            // the logical cwd (pwd) and the canonical (symlink-resolved) path
            // as trusted "local" roots so legitimate calls that stay within
            // either form are accepted. With --start-dir, only the canonical
            // start directory is trusted (computed above); the original
            // start-up directory and its canonical form are excluded.
            allowedDirectories: classifierAllowedDirectories,
            // Tool-safety CLI flags resolved once at startup (enabled,
            // agentSourceDir, startDir, allowAgentSourceModifications) are
            // threaded into the classifier so its edit/write policy and
            // bypass behavior follow the user's configuration.
            toolSafetyConfig,
            // Docker/container detection selects the classifier prompt
            // variant: Docker uses the relaxed filesystem-policy addendum,
            // non-Docker keeps the strict start/working-directory boundary.
            isDocker: runtimeConfig.isDocker,
            promptDirectory: mainCwd,
            logger: createToolSafetyLogger(toolChildIndent),
        });
    } catch (error) {
        throwIfAborted(abortController.signal, "execution");
        if (error instanceof RunAbortError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        const risk = toolRiskLevel(output.name);
        if (risk !== "readonly") {
            const message = `Safety classifier failed for ${output.name} (${risk} tool); refusing to execute: ${reason}`;
            renderToolCallFailed(output, { error: message });
            return { output, toolArguments, toolResponse: { error: message }, errorMessage: message };
        }
        status.warning(`Safety classifier failed for read-only tool ${output.name}; proceeding with an explicit warning: ${reason}`, toolChildIndent);
    }

    if (classification && !classification.safe) {
        const message = `Tool call blocked by safety classifier (${classification.source}): ${classification.reason}`;
        // Fighting-with-classifier counter: track this denial for the current
        // goal. When repeated denials for the same goal reach the threshold,
        // attach an explicit REPLAN DIRECTIVE so the model stops repeating the
        // blocked action and re-plans its approach instead.
        const tracker = loadDenialTracker(configData);
        const denial = tracker.recordDenial(goalKey ?? "(default-goal)", output.name, classification.reason);
        persistDenialTracker(configData, tracker);
        if (denial.thresholdReached && denial.replanDirective) {
            status.replan(`Repeated classifier denials for goal '${goalKey ?? "(default-goal)"}' (${denial.count}); issuing a replan directive.`, toolChildIndent);
        }
        const fullMessage = denial.thresholdReached && denial.replanDirective
            ? `${message}\n\n${denial.replanDirective}`
            : message;
        renderToolCallFailed(output, { error: fullMessage });
        return { output, toolArguments, toolResponse: { error: fullMessage }, errorMessage: fullMessage };
    }

    // --start-dir tool cwd: run each tool from the configured start directory
    // and restore the previous working directory afterwards, including when
    // the tool rejects. The directory is validated at startup, but a chdir
    // failure here fails the call safely instead of running the tool from an
    // unexpected directory. The switch happens before the timer starts so a
    // chdir failure never leaves an instrumented call running.
    //
    // The AgentBus tool is excluded from this start-dir injection. agent-busctl
    // resolves its workspace root, binary location, and enrolled credential
    // store relative to the process it was launched from (default
    // <root>/tmp/elastic-identity / <root>/agent-busctl), so running it from
    // --start-dir (for example a review worktree) could point it at the wrong
    // root. It therefore runs from the process working directory, keeping the
    // injected start-directory switch from altering agent-bus behavior.
    const isAgentBusTool = output.name === "AgentBus";
    const configuredStartDir = !isAgentBusTool && toolSafetyConfig.startDirConfigured ? toolSafetyConfig.startDir : undefined;
    let toolCwdSwitch: ReturnType<typeof switchToStartDir>;
    try {
        toolCwdSwitch = switchToStartDir(configuredStartDir);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        renderToolCallFailed(output, { error: message });
        return { output, toolArguments, toolResponse: { error: message }, errorMessage: message };
    }

    const timer = startToolTimer({ prefix: toolChildIndent, color: terminalColor });
    timer.start();
    try {
        const toolResponse = await tool.exec_handler(toolArguments);
        timer.stop();
        renderToolCallSucceeded(output, toolResponse);
        // Progress: a cleared call counts as forward motion, so reset the
        // current goal's denial counter so the next denial starts afresh.
        if (configData) {
            const tracker = loadDenialTracker(configData);
            tracker.recordSuccess(goalKey ?? "(default-goal)");
            persistDenialTracker(configData, tracker);
        }
        return { output, toolArguments, toolResponse, errorMessage: null };
    } catch (error) {
        timer.stop();
        const message = error instanceof Error ? error.message : String(error);
        const toolResponse = { error: message };
        renderToolCallFailed(output, toolResponse);
        return { output, toolArguments, toolResponse, errorMessage: message };
    } finally {
        restoreStartDir(toolCwdSwitch);
    }
}

async function executePlanStep(step, index, steps, plan, configData, executionContext) {
    const color = terminalColor;
    for (const line of buildPrettyStepLines(index, steps.length, step, { color, remainingSteps: steps.slice(index + 1) })) {
        status.step(line, hierarchyIndent("planStep"));
    }
    let previousResponseId;
    let toolOutputs: any[] = [];
    const startDirWarning = startDirPathWarning(toolSafetyConfig, runtimeConfig.isDocker);
    while (true) {
        throwIfAborted(abortController.signal, "execution", index + 1);
        const request = { tools, abortPhase: "execution" } as any;
        if (previousResponseId) {
            request.previous_response_id = previousResponseId;
            request.input = toolOutputs;
        } else {
            request.input = renderPrompt(stepExecutionPromptTemplate, { claudeInstructions, commitInstruction, plan, index, steps, step, executionFeedbackFormat, executionContext, toolsAvailable }) + startDirWarning;
        }
        const response = await client.create(request);
        new CompatibleResponseWrapper(response).print(toolChildIndent);
        recordUsage(configData, response);
        throwIfProviderCancelled(response, "execution", index + 1);
        previousResponseId = response.id;
        toolOutputs = [];
        for (const output of response.output ?? []) {
            if (output.type !== "function_call") continue;
            const dispatched = await dispatchToolCall(output, configData, `plan-${index + 1}`);
            toolOutputs.push(functionCallOutput(dispatched.output, dispatched.toolResponse));
            appendHistory(configData.toolCallTldrs, summarizeToolCall(dispatched.output.name, dispatched.toolArguments, dispatched.toolResponse));
        }
        saveData(configData);
        if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);
        if (toolOutputs.length === 0) {
            let feedbackEntry = captureExecutionFeedback(configData, response, index);
            reportExecutionFeedback(feedbackEntry);
            saveData(configData);
            if (!feedbackEntry.valid) {
                const stepPrompt = renderPrompt(stepExecutionPromptTemplate, { claudeInstructions, commitInstruction, plan, index, steps, step, executionFeedbackFormat, executionContext, toolsAvailable }) + startDirWarning;
                configData.retryPrompt =
                    `${stepPrompt}\n\nThe previous response was not valid JSON. Here's the error: ` +
                    `${feedbackEntry.validationError}. Please return valid JSON following this exact structure.`;
                status.replan(`Step ${index + 1} response was not valid JSON; sending a retry request with the parsing error appended.`, hierarchyIndent("contentInStep"));
                throwIfAborted(abortController.signal, "execution", index + 1);
                const retryResponse = await client.create({ input: configData.retryPrompt, abortPhase: "execution" });
                new CompatibleResponseWrapper(retryResponse).print(toolChildIndent);
                recordUsage(configData, retryResponse);
                throwIfProviderCancelled(retryResponse, "execution", index + 1);
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

async function runExecutionPhase(activeSteps, plan, configData, executionContext = "(none)", useReviewWorktree = false, specKeeperState: any = null, taskLifecycle: any = null) {
    configData.completedSteps = [];
    configData.replanAttemptCount = 0;
    configData.replanHistory = [];
    configData.consecutiveNoProgressReplans = 0;
    configData.replanElapsedMs = 0;
    configData.activePlanSteps = [...activeSteps];
    configData.lastResponseId = null;
    configData.lastToolCallIds = [];
    // A new plan execution phase begins a fresh denial-tracking context, so
    // denials from a previous run step are not carried into this one.
    persistDenialTracker(configData, new DenialTracker());
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
    if (!useReviewWorktree) mainCheckoutMayHavePartialWork = true;
    const worktree = useReviewWorktree ? ensureWorktree(executionWorktreeBranch, mainCwd) : null;
    const originalCwd = process.cwd();
    if (worktree) {
        inExecutionPhase = true;
        executionWorktreePath = worktree;
        process.chdir(worktree);
    }
    try {
        for (let index = 0; index < activeSteps.length; index += 1) {
            throwIfAborted(abortController.signal, "execution", index + 1);
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
            if (taskLifecycle) {
                const stepSummary = feedbackEntry?.valid && feedbackEntry.feedback?.summary
                    ? feedbackEntry.feedback.summary
                    : "completed";
                await specKeeperTaskNote(
                    taskLifecycle,
                    `step ${index + 1} completed`,
                    `Plan step ${index + 1} ${stepSummary}.`,
                );
            }
            const appliedChanges = applyExecutionFeedback(feedbackEntry, activeSteps, index);
            reportAppliedPlanChanges(appliedChanges);
            const replanResult = await attemptReplan(feedbackEntry, activeSteps, index, configData);
            configData.activePlanSteps = [...activeSteps];
            configData.lastAppliedPlanChanges = appliedChanges;
            if (worktree) {
                // Stage all changes this step produced into the worktree. We never
                // commit here; the review step commits only when it is satisfied.
                stageAllInWorktree(worktree);
            }
            saveData(configData);
            if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);
            if (replanResult?.restart) {
                // A replan moved the plan into a new phase: executed progress was
                // already cleared inside attemptReplan and the whole plan was
                // replaced, so restart execution from the very first step.
                index = -1; // the for-loop's index += 1 makes this step 0
                continue;
            }
        }
        if (taskLifecycle) {
            await specKeeperTaskNote(
                taskLifecycle,
                "checks run",
                `Execution phase completed after ${activeSteps.length} step${activeSteps.length === 1 ? "" : "s"}; agent-run checks finished.`,
            );
        }
    } finally {
        if (worktree) {
            process.chdir(originalCwd);
            inExecutionPhase = false;
        }
    }
}

async function runReviewPhase(activeSteps, plan, configData, reviewAttempt, originalPrompt = commandLinePrompt) {
    throwIfAborted(abortController.signal, "review-plan");
    // The review phase starts with a plan step: ask the model to plan how to
    // conduct the review of the executed work against the four review criteria.
    status.planning("Creating a review plan...");
    const reviewPlanGoal =
        "Plan how to conduct a review of the just-executed work. Assess the original prompt request, " +
        "the end-result quality, SDLC.md compliance, and record any learnings. Return a concise step-by-step plan.";
    const reviewPlanPrompt = `${reviewPlanGoal}\n\n${planningSuffix}`;
    const reviewPlanResponse = await client.create({ input: reviewPlanPrompt, abortPhase: "review-plan" });
    new CompatibleResponseWrapper(reviewPlanResponse).print();
    recordUsage(configData, reviewPlanResponse);
    throwIfProviderCancelled(reviewPlanResponse, "review-plan");
    const reviewPlan = responseText(reviewPlanResponse);
    saveData(configData);

    throwIfAborted(abortController.signal, "review");
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
        claudeInstructions, originalPrompt, plan: formatPlan(activeSteps),
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
async function runSingleStep(
    prompt: string,
    configData: any,
    reviewMode: boolean,
    specKeeperDefaults: any = null,
    taskMode = false,
    originalPrompt = commandLinePrompt,
    taskLifecycle: any = null,
): Promise<void> {
    const stepText = taskMode ? originalPrompt : commandLinePrompt;
    configData.completedSteps = [{ step: 1, text: stepText }];
    configData.activePlanSteps = [stepText];
    configData.lastResponseId = null;
    configData.lastToolCallIds = [];
    // Start a fresh denial-tracking context for this direct step.
    persistDenialTracker(configData, new DenialTracker());
    saveData(configData);
    if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);

    const skClientOptions = specKeeperClientOptions(specKeeperDefaults);
    const defaultEpic = specKeeperDefaults?.defaultEpic ?? {};
    const defaultTask = specKeeperDefaults?.defaultTask ?? {};
    let skTask: any = null;

    // Epic-first task sync for the no-plan path: reuse/create the configured
    // default epic, then reuse/create one task beneath it for this run. Task
    // mode already fetched and claimed the Spec Keeper task, so it must not
    // create a second prompt-mode epic/task here.
    if (!taskMode) {
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
    }

    const previousInExecutionPhase = inExecutionPhase;
    if (reviewMode) inExecutionPhase = true;
    mainCheckoutMayHavePartialWork = true;

    try {
        status.step("Executing request directly without a plan.", hierarchyIndent("planStep"));
        let previousResponseId;
        let toolOutputs: any[] = [];
        while (true) {
            throwIfAborted(abortController.signal, "execution");
            const request = { tools, abortPhase: "execution" } as any;
            if (previousResponseId) {
                request.previous_response_id = previousResponseId;
                request.input = toolOutputs;
            } else {
                request.input = prompt;
            }
            const response = await client.create(request);
            new CompatibleResponseWrapper(response).print(toolChildIndent);
            recordUsage(configData, response);
            throwIfProviderCancelled(response, "execution");
            previousResponseId = response.id;
            toolOutputs = [];
            for (const output of response.output ?? []) {
                if (output.type !== "function_call") continue;
                const dispatched = await dispatchToolCall(output, configData, "direct-step");
                toolOutputs.push(functionCallOutput(dispatched.output, dispatched.toolResponse));
                appendHistory(configData.toolCallTldrs, summarizeToolCall(dispatched.output.name, dispatched.toolArguments, dispatched.toolResponse));
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
                if (taskLifecycle) {
                    const directStatusNote = reviewMode
                        ? "Direct execution complete; commit deferred to review."
                        : "Direct execution complete and committed.";
                    await finalizeTaskModeSuccess(taskLifecycle, {
                        outcome: "completed",
                        mode: "direct",
                        commitEvidence: latestCommitEvidence(mainCwd),
                        note: directStatusNote,
                    });
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
        if (taskLifecycle) {
            const reason = error instanceof Error ? error.message : String(error);
            await finalizeTaskModeFailure(taskLifecycle, `Direct execution failed: ${reason}`);
        }
        throw error;
    } finally {
        inExecutionPhase = previousInExecutionPhase;
    }
}

async function main(options: { review?: boolean; loop?: boolean } = {}): Promise<{ success: boolean; loopReplanPending?: boolean }> {
    client = new MultiTurnLlmRuntime(
        await createRuntimeLlmAdapter({ configuration: providerSelection.configuration }),
        modelConfiguration.model,
        abortController.signal,
    );
    let configData = readData();
    if (!configData) configData = { responseIds: [] };
    if (!Array.isArray(configData.requestResponses)) configData.requestResponses = [];
    if (!configData.toolCallResponse || typeof configData.toolCallResponse !== "object") configData.toolCallResponse = {};
    if (!Array.isArray(configData.tokenUsage)) configData.tokenUsage = [];
    if (!Array.isArray(configData.commandLinePrompts)) configData.commandLinePrompts = [];
    if (!Array.isArray(configData.toolCallTldrs)) configData.toolCallTldrs = [];
    if (!Array.isArray(configData.replanHistory)) configData.replanHistory = [];
    if (!Number.isInteger(configData.replanAttemptCount) || configData.replanAttemptCount < 0) configData.replanAttemptCount = 0;
    if (!Number.isInteger(configData.consecutiveNoProgressReplans) || configData.consecutiveNoProgressReplans < 0) configData.consecutiveNoProgressReplans = 0;
    if (!Number.isFinite(configData.replanElapsedMs) || configData.replanElapsedMs < 0) configData.replanElapsedMs = 0;
    activeConfigData = configData;

    // System initialisation result is persisted into configData so later steps
    // (CLAUDE.md starting-directory injection and the tool-classifier trusted
    // roots) can read it without re-running realpath. Reuse an existing stored
    // state when present, otherwise record the freshly resolved init.
    if (!configData.workspaceInit || !configData.workspaceInit.pwd) {
        configData.workspaceInit = workspaceInitToState(workspaceInit);
    }

    // Inject the starting directory (pwd + canonical path) guidance into the
    // repo-root CLAUDE.md so the model is told to prefix relative paths with the
    // starting directory name. This is idempotent: an existing injected section
    // is replaced in place and any other CLAUDE.md content is preserved. The
    // injection runs at startup, before any agent action that depends on file
    // paths, so the section is in place for the remainder of the run.
    try {
        writeWorkspaceInitMarkdown("CLAUDE.md", workspaceInit);
    } catch (error) {
        status.warning(`Could not inject starting-directory guidance into CLAUDE.md: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Resolve Spec Keeper operational defaults once before any planning or
    // execution sync. This loads the local .spec-keeper file (when present) and
    // reports the winning config source without ever logging secret values.
    const specKeeperDefaults = resolveSpecKeeperDefaults();
    for (const warning of specKeeperDefaults.warnings) status.warning(warning);
    status.specKeeper(`defaults loaded: ${describeSpecKeeperDefaults(specKeeperDefaults)}`);

    // Task mode seeds the runtime from an existing Spec Keeper task: fetch it
    // by id, claim it, and convert it into the initial agent prompt. The
    // fetched task is the source of truth for the work order; prompt mode
    // keeps using the original command-line prompt.
    const isTaskMode = runMode.mode === "task";
    if (!isTaskMode) activePromptSpecKeeperOptions = specKeeperClientOptions(specKeeperDefaults);

    // Loop-mode pre-planning bus poll: before the work order is resolved (and
    // thus before any planning begins), poll the Agent Bus once for a relevant
    // coordination message so a directive that arrived before startup becomes
    // the plan's work order rather than being queued and picked up only at a
    // step boundary. This is a single non-blocking bounded read (see
    // pollAgentBus), so startup never blocks when the bus is idle or
    // unreachable. When relevant message(s) are found, `extractReplanPrompt`
    // concatenates their searchable text into the new work order exactly the
    // way the step-5 replan loop does — so in no-filter / respond-to-everything
    // mode every message received before planning becomes part of the prompt,
    // not just the original command-line prompt and not just the first message.
    const busMessages = await pollAgentBus();
    if (busMessages) {
        commandLinePrompt = extractReplanPrompt(busMessages);
        for (const busMessage of busMessages) {
            status.replan(
                `Loop mode: using a relevant bus message received before planning as the work order: ${truncate(messageToSearchableText(busMessage), 240)}`,
                hierarchyIndent("plan"),
            );
        }
    }

    let originalPrompt = commandLinePrompt;
    let taskWorkOrder: TaskWorkOrder | null = null;
    let taskLifecycle: any = null;
    if (isTaskMode) {
        throwIfAborted(abortController.signal, "task-mode-setup");
        const taskModeOptions = specKeeperClientOptions(specKeeperDefaults);
        try {
            taskWorkOrder = await fetchSpecKeeperTask(runMode.taskId!, taskModeOptions);
            status.specKeeper(describeTaskWorkOrder(taskWorkOrder));
            const claimedTask = await claimSpecKeeperTask(taskWorkOrder, taskModeOptions);
            status.specKeeper(describeClaimedSpecKeeperTask(claimedTask));
            taskWorkOrder = {
                ...taskWorkOrder,
                status: claimedTask.status || taskWorkOrder.status,
                raw: claimedTask.task || taskWorkOrder.raw,
            };
            taskLifecycle = {
                taskId: taskWorkOrder.id,
                options: taskModeOptions,
            };
            activeTaskLifecycle = taskLifecycle;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            status.error(`Task mode could not be started: ${message}`);
            throw error;
        }
        originalPrompt = buildTaskWorkOrderBrief(taskWorkOrder);
    }

    appendHistory(configData.commandLinePrompts, originalPrompt);
    const prompt = isTaskMode && taskWorkOrder
        ? buildTaskWorkOrderPrompt(taskWorkOrder)
        : buildPrompt({
            commandPrompts: configData.commandLinePrompts,
            toolCallTldrs: configData.toolCallTldrs,
            commandLinePromptValue: originalPrompt,
            template: buildPromptTemplate,
            claudeInstructions,
            historyLimit,
            selfModificationSection,
            allowAgentSourceModifications: toolSafetyConfig.allowAgentSourceModifications,
        });

    // Planning-necessity classification: before entering the plan-then-execute
    // flow, ask the LLM whether the work order genuinely needs a formal plan.
    // The classification runs after the prompt is resolved and before
    // runExecutionPhase/executePlanStep is ever invoked. Invalid or missing
    // classifier output falls back to requiresPlanning=true so the safer plan
    // flow runs.
    throwIfAborted(abortController.signal, "planning-necessity");
    const planningNecessity = await determinePlanningNecessity(originalPrompt, client, abortController.signal);
    const selectedMode = selectExecutionMode(planningNecessity);
    status.classification(`requiresPlanning=${planningNecessity.requiresPlanning} (${planningNecessity.reason}); mode: ${selectedMode}`, hierarchyIndent("plan"));
    if (!planningNecessity.requiresPlanning) {
        // No-plan single-step path: run the work order directly. No planning
        // prompt, plan JSON, plan review step, or plan-derived worktree
        // lifecycle. The existing --review flag still controls commit behavior
        // via commitInstruction and the Git commit guard handled by
        // runSingleStep.
        const directPrompt = `${prompt}\n\n${toolsAvailable}\n\nCommit instruction for this step: ${commitInstruction}${startDirPathWarning(toolSafetyConfig, runtimeConfig.isDocker)}`;
        if (taskLifecycle) {
            await specKeeperTaskNote(taskLifecycle, "note (execution started)", "Task-mode direct execution started.");
        }
        await runSingleStep(directPrompt, configData, options.review === true, specKeeperDefaults, isTaskMode, originalPrompt, taskLifecycle);
        // Between-step poll: even the no-plan path honors loop mode by checking
        // the bus after the direct execution step completed. A relevant message
        // is surfaced as a re-plan candidate; the outer replan loop (step 5)
        // re-enters planning with that message.
        const noPlanLoopReplan = await pollLoopBusBetweenSteps(hierarchyIndent("contentInStep"));
        const totals = totalUsage(configData.tokenUsage);
        status.success(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);
        if (noPlanLoopReplan) {
            status.replan("Loop mode: relevant bus message received after direct execution; deferring completion so the plan can be re-planning with the message as the new work order.", hierarchyIndent("plan"));
            return { success: true, loopReplanPending: true };
        }
        status.success(isTaskMode ? "Task-mode direct execution complete. Stopping." : "Direct execution complete. Stopping.");
        return { success: true };
    }

    // Epic-first Spec Keeper coordination for prompt mode: always pull epics
    // and select or create the epic that matches this work so the generated
    // plan and its tasks can be recorded against the epic later. Best-effort:
    // when Spec Keeper is unreachable we proceed without it so the run is not
    // blocked by coordination unavailability. Task mode already fetched and
    // claimed its task and does not create a second prompt-mode epic here.
    let epicSync: any = null;
    if (!isTaskMode) {
        try {
            epicSync = await syncSpecKeeperEpic({ title: commandLinePrompt, description: `Execution requested for: ${commandLinePrompt}`, projectSlug: specKeeperDefaults.projectSlug });
            status.specKeeper(`${epicSync.selection}.`);
            activePromptEpic = epicSync?.epic ?? null;
        } catch (error) {
            status.warning(`Spec Keeper epic-first sync skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    throwIfAborted(abortController.signal, "planning");
    status.planning("Creating an execution plan...");

    const planningPrompt = `${prompt}\n\n${planningSuffix}`;

    console.log(planningPrompt);

    let planParseFailure: string | null = null;
    let parsedPlanningResponse: ReturnType<typeof parsePlanOrAbort> = { valid: false, reason: "Planning did not produce a response." };
    for (let attempt = 0; attempt <= maxPlanParseRetries; attempt += 1) {
        throwIfAborted(abortController.signal, "planning");
        const promptToSend = attempt === 0
            ? planningPrompt
            : `${planningPrompt}\n\nThe previous response was not valid plan JSON. Here's the error: ${planParseFailure}. Please return either a valid plan JSON object or an abort object.`;
        const planningResponse = await client.create({ input: promptToSend, abortPhase: "planning" });
        new CompatibleResponseWrapper(planningResponse).print();
        recordUsage(configData, planningResponse);
        throwIfProviderCancelled(planningResponse, "planning");
        parsedPlanningResponse = parsePlanOrAbort(responseText(planningResponse));
        if (parsedPlanningResponse.valid) break;
        planParseFailure = parsedPlanningResponse.reason;
        if (attempt < maxPlanParseRetries) {
            status.warning("Planning response was not valid plan JSON; sending a retry request with the parsing error appended.", hierarchyIndent("plan"));
        }
    }
    if (!parsedPlanningResponse.valid) {
        throw new RunAbortError("unable-to-complete", "planning", `Planning response was not valid after ${maxPlanParseRetries} parse retries: ${parsedPlanningResponse.reason}`);
    }
    if (parsedPlanningResponse.result.kind === "abort") {
        throw new RunAbortError("unable-to-complete", "planning", parsedPlanningResponse.result.reason);
    }
    printPlan(parsedPlanningResponse.result.plan);
    const activeSteps = planStepsFromObject(parsedPlanningResponse.result.plan);
    if (activeSteps.length === 0) {
        throw new RunAbortError("unable-to-complete", "planning", "Planning response JSON had steps without usable text.");
    }
    const plan = formatPlan(activeSteps);
    // Store the plan's top-level "phase" on the plan state so the handler can
    // recognize the phase the plan is currently in and detect a phase-level
    // change from a later replan (which restarts the whole plan). Only
    // very-high-complexity plans carry a phase; absent stays undefined.
    configData.planPhase = parsedPlanningResponse.result.plan.phase;
    configData.replanAttemptCount = 0;
    configData.replanHistory = [];
    configData.consecutiveNoProgressReplans = 0;
    configData.replanElapsedMs = 0;
    configData.lastResponseId = null;
    configData.lastToolCallIds = [];
    saveData(configData);
    if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);

    status.success(`Plan created with ${activeSteps.length} step${activeSteps.length === 1 ? "" : "s"}.`);

    if (taskLifecycle) {
        const planProducedNote = `Plan produced with ${activeSteps.length} step${activeSteps.length === 1 ? "" : "s"}.`;
        await specKeeperTaskStatus(taskLifecycle, "plan produced", "in_progress", planProducedNote);
        await specKeeperTaskNote(taskLifecycle, "note (plan produced)", planProducedNote);
    }

    const skClientOptions = specKeeperClientOptions(specKeeperDefaults);
    let specKeeperState: any = null;
    if (!isTaskMode) {
        specKeeperState = {
            epic: epicSync?.epic ?? null,
            runTask: null,
            stepTasks: [],
            taskUpdateOptions: skClientOptions,
        };
        activePromptSpecKeeperState = specKeeperState;

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
    let reviewOutcome: "passed" | "failed" | null = null;
    let executionContext = "(none)";
    // Set when loop mode interrupted the review/execution loop because a
    // relevant Agent Bus message was received between steps. When set, the
    // execution worktree is intentionally left in place (uncommitted) so the
    // re-planning logic in step 5 can re-enter planning without losing work.
    let loopReplanInterrupted = false;

    if (taskLifecycle) {
        await specKeeperTaskNote(
            taskLifecycle,
            "note (execution started)",
            `Plan execution started with ${activeSteps.length} step${activeSteps.length === 1 ? "" : "s"}.`,
        );
    }

    if (options.review) {
        while (true) {
            throwIfAborted(abortController.signal, "review");
            await runExecutionPhase(activeSteps, plan, configData, executionContext, true, specKeeperState, taskLifecycle);
            reviewAttempt += 1;
            // Between-step poll (execute -> review): if a relevant Agent Bus
            // message arrived while the plan was being executed, stop the
            // review loop so the work is left uncommitted for re-planning
            // rather than committing work the coordinator just redirected.
            if (await pollLoopBusBetweenSteps(hierarchyIndent("plan"))) {
                loopReplanInterrupted = true;
                status.replan("Loop mode: relevant bus message received after execution; deferring the review so the plan can be re-planned.", hierarchyIndent("plan"));
                break;
            }
            const review = await runReviewPhase(activeSteps, plan, configData, reviewAttempt, originalPrompt);
            // Between-step poll (review -> commit / next execution): a relevant
            // message here also defers any commit/re-review so a passing review
            // does not commit work the coordinator has redirected.
            if (await pollLoopBusBetweenSteps(hierarchyIndent("plan"))) {
                loopReplanInterrupted = true;
                status.replan("Loop mode: relevant bus message received after review; deferring commit so the plan can be re-planned.", hierarchyIndent("plan"));
                break;
            }
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
                if (taskLifecycle) {
                    const reviewProof = {
                        outcome: "completed",
                        mode: "plan",
                        reviewAttempt,
                        reviewSummary: summarizeReview(review),
                        commitEvidence: latestCommitEvidence(mainCwd),
                    };
                    await finalizeTaskModeSuccess(taskLifecycle, reviewProof);
                }
                reviewOutcome = "passed";
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
            if (taskLifecycle) {
                const reviewReasons = (review.reasons ?? []).join("; ") || "no reasons provided";
                await finalizeTaskModeFailure(taskLifecycle, `Review failed: ${reviewReasons}`);
            }
            reviewOutcome = "failed";
            break;
        }
    } else {
        throwIfAborted(abortController.signal, "execution");
        await runExecutionPhase(activeSteps, plan, configData, executionContext, false, specKeeperState, taskLifecycle);
        // Between-step poll (no-review path): after the plan finished executing,
        // check the bus once for a relevant coordination message. When found,
        // defer the run's completion so the plan can be re-planned (the pending
        // replan message is retained for step 5's replan loop).
        if (await pollLoopBusBetweenSteps(hierarchyIndent("plan"))) {
            loopReplanInterrupted = true;
            status.replan("Loop mode: relevant bus message received after execution; deferring completion so the plan can be re-planned.", hierarchyIndent("plan"));
        }
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
        if (taskLifecycle) {
            await finalizeTaskModeSuccess(taskLifecycle, {
                outcome: "completed",
                mode: "plan",
                steps: activeSteps.length,
                commitEvidence: latestCommitEvidence(mainCwd),
            });
        }
    }

    if (reviewOutcome === "failed") {
        status.error("Review did not pass; the work was left uncommitted and the task was marked blocked.");
        cleanupExecutionWorktree();
        return { success: false };
    }

    // Loop mode interruption: a relevant Agent Bus message was received
    // between steps. The execution worktree is intentionally left in place
    // (uncommitted) so the re-planning logic in step 5 can re-enter planning
    // on top of the preserved work rather than losing it. The run still
    // completes normally here; the pending replan message is surfaced so the
    // outer loop (step 5) can re-plan with it as the new prompt.
    if (loopReplanInterrupted) {
        const replanText = truncate(pendingLoopReplanText() || "a plan-change directive", 240);
        status.replan(`Loop mode: execution interrupted for re-planning. Pending replan message: ${replanText}. The execution worktree was preserved for the replan.`, hierarchyIndent("plan"));
        // Do NOT call cleanupExecutionWorktree() here; the preserved worktree is
        // needed by the replan loop (step 5) that follows. Signal the outer
        // replan controller so it re-enters planning with the message as the new
        // work order instead of treating this as a normal completed run.
        const totals = totalUsage(configData.tokenUsage);
        status.success(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);
        return { success: true, loopReplanPending: true };
    }

    const totals = totalUsage(configData.tokenUsage);
    status.success(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);
    // End-of-plan tldr: a concise summary of what the implementation actually
    // did (steps completed, replans, issues/blockers, and an outcome-vs-prompt
    // evaluation) printed just before the terminal "Plan complete." line.
    reportImplementationTldr(configData, originalPrompt, {
        taskMode: isTaskMode,
        reviewOutcome,
        reviewAttempts: reviewOutcome === "passed" ? reviewAttempt : undefined,
    });
    status.success(isTaskMode ? "Task-mode plan execution complete. Stopping." : "Plan complete. Stopping.");
    cleanupExecutionWorktree();
    return { success: true };
}

// Remove the execution worktree and its branch once the run finishes (or fails),
// so the main repository is left clean of staged execution work.
function cleanupExecutionWorktree(reportAbort = false) {
    if (!executionWorktreePath) return;
    try {
        cleanupWorktree(executionWorktreeBranch, mainCwd);
        executionWorktreePath = null;
        if (reportAbort) {
            status.abort("removed execution worktree .worktrees/review-worktree (staged work discarded)");
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        status.warning(`Failed to clean up execution worktree: ${boundedAbortReason(reason)}`);
    }
}

// ---------------------------------------------------------------------------
// Loop-mode replanning (step 5 of the loop-mode plan).
//
// When a relevant Agent Bus message interrupts execution, main() returns with
// `loopReplanPending: true` and the execution worktree intentionally preserved
// (uncommitted). `gitStatusPorcelain(cwd)` and the safety predicates below let
// the replan loop decide whether re-entering planning is safe, and
// `runAgentReplanLoop` re-drives the plan-then-execute flow with the relevant
// message as the new prompt, up to a bounded replan budget.
//
// The worktree lifecycle is coordinated safely across replans: the preserved
// worktree is NOT cleaned up between replan iterations (main() returns with it
// intact, and `ensureWorktree` reuses the same worktree for the new execution),
// and cleanup runs only once the whole replan loop finishes (or aborts).
// ---------------------------------------------------------------------------

/** Run `git status --porcelain` in a checkout; null when git cannot be run. */
function gitStatusPorcelain(cwd: string): string | null {
    try {
        const result = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
        if (result.error || result.status !== 0) return null;
        return (result.stdout ?? "").trim();
    } catch {
        return null;
    }
}

/**
 * Build the safety-check predicates the replan guard consumes. These wire the
 * real worktree/main-checkout state into decideSafeReplan (see loop-replan.ts)
 * so re-planning is allowed only when it will not corrupt uncommitted work.
 */
function loopReplanSafetyChecks(): {
    worktreeHasWork: () => boolean | null;
    mainCheckoutIsDirty: () => boolean | null;
    worktreeExists: () => boolean | null;
} {
    const worktreeExists = (): boolean =>
        executionWorktreePath !== null || listWorktrees(mainCwd).has(executionWorktreeBranch);
    const worktreeHasWork = (): boolean | null => {
        const path = executionWorktreePath ?? listWorktrees(mainCwd).get(executionWorktreeBranch) ?? null;
        if (!path) return null;
        const status = gitStatusPorcelain(path);
        return status === null ? null : status.length > 0;
    };
    const mainCheckoutIsDirty = (): boolean | null => {
        const status = gitStatusPorcelain(mainCwd);
        return status === null ? null : status.length > 0;
    };
    return { worktreeHasWork, mainCheckoutIsDirty, worktreeExists };
}

/**
 * Loop-mode replan controller. Runs main() once or more:
 *   - On the first iteration the CLI prompt is used.
 *   - If a run returns with `loopReplanPending: true`, the pending relevant bus
 *     message becomes the next work order and main() is re-entered (planning
 *     runs again with that message as the new prompt) — but only if the replan
 *     budget remains AND the repository is in a safe state to carry the new
 *     plan (the safety guard blocks replanning over dirty main-checkout work).
 *
 * The preserved execution worktree stays in place across replan iterations so
 * staged work is carried forward rather than lost; it is cleaned up only after
 * the loop finishes or when an abort/failure handler runs.
 */
async function runAgentReplanLoop(options: { review?: boolean; loop?: boolean } = {}): Promise<{ success: boolean }> {
    // Only loop mode ever interrupts for a replan; without --loop we run once.
    if (!options.loop) {
        return main(options);
    }

    // Loop mode restart: read the durable Agent Bus queue persisted by a prior
    // run before starting any work ("ALWAYS READ THE QUEUE WHEN RESTARTING").
    // Queued messages that are relevant to the *current* plan are promoted to
    // pending re-plan candidates; the rest are drained and dropped. Live Agent
    // Bus reads remain exclusively polling (pollLoopBusOnce / pollLoopBusUntilMessage).
    await drainLoopQueueAtRestart();

    let replanBudget: LoopReplanBudget = initialLoopReplanBudget();
    let iteration = 0;
    while (true) {
        // The replan loop is top-level orchestration; report an interrupt here
        // under the cleanup phase so a SIGINT mid-replan is handled as a
        // deliberate abort like any other cleanup-time interrupt.
        throwIfAborted(abortController.signal, "cleanup");
        const outcome = await main(options);
        const hasPending = outcome.loopReplanPending === true && pendingLoopReplanMessages.length > 0;

        if (!hasPending) {
            // The plan completed normally (nothing relevant arrived at a step
            // boundary). Loop mode does not exit here: it keeps the agent alive
            // and keeps polling the Agent Bus, waiting for a relevant message
            // that should drive the next re-plan. Irrelevant messages arriving
            // while idle are queued durably by the poll, never dropped. The
            // wait is bounded by LOOP_MAX_IDLE_POLLS (default: wait until a
            // relevant message arrives or the run is aborted) so the agent
            // truly keeps listening between plans.
            const idlePrefix = hierarchyIndent("plan");
            const maxIdlePolls = resolveLoopMaxIdlePolls();
            status.success(
                "Loop mode: plan complete. Continuing to watch the Agent Bus for new work; press Ctrl-C to stop.",
                idlePrefix,
            );
            const idle = await pollLoopBusUntilMessage({
                read: loopBusRead,
                path: loopBusMessagesPath,
                requestTimeoutMs: loopPollTiming.requestTimeoutMs,
                pollIntervalMs: loopPollTiming.pollIntervalMs,
                queueFilePath: loopQueueFilePath,
                context: { planId: runMode.mode === "task" ? runMode.taskId : undefined, respondAll: runMode.respondAll },
                maxIdlePolls,
                signal: abortController.signal,
                onPoll: (result) => {
                    for (const warning of result.warnings) {
                        if (result.readFailed) {
                            status.warning(`loop poll: ${warning}`, idlePrefix);
                        }
                    }
                    // In no-filter / respond-to-everything mode every message is
                    // classified as relevant and processed immediately, so there
                    // are never irrelevant (queued) messages to report. Suppress
                    // the misleading "queued" log for that mode.
                    if (!runMode.respondAll && !result.readFailed && result.queuedCount > 0) {
                        status.success(`loop poll: ${result.queuedCount} irrelevant message(s) queued`, idlePrefix);
                    }
                },
            });

            if (idle.aborted) {
                // A SIGINT/SIGTERM interrupted the idle wait; route through the
                // abort handler so cleanup and finalization run normally.
                throwIfAborted(abortController.signal, "cleanup");
            }
            if (idle.maxIdlePollsReached) {
                status.replan(
                    `Loop mode: idle-wait ceiling of ${maxIdlePolls} poll(s) reached with no relevant message; stopping.`,
                    idlePrefix,
                );
                return { success: outcome.success };
            }

            // A relevant message arrived while idle: surface it as a pending
            // re-plan so the replan handling below re-enters planning with it.
            pendingLoopReplanMessages = [...idle.relevantMessages];
            for (const relevant of idle.relevantMessages) {
                const text = truncate(messageToSearchableText(relevant as { text?: string }), 240);
                status.replan(`Loop mode: detected a relevant bus message while idle, warranting a re-plan: ${text}`, idlePrefix);
            }
        }

        // A relevant message changed the plan: decide whether it is safe to
        // re-enter planning on top of the preserved work.
        const safety = decideSafeReplan(loopReplanSafetyChecks());
        if (!safety.safe) {
            status.replan(
                `Loop mode: a relevant message requested re-planning, but it is not safe to proceed: ${safety.reason}`,
                hierarchyIndent("plan"),
            );
            return { success: outcome.success };
        }

        if (replanBudget.remaining <= 0) {
            status.replan(
                `Loop mode: reached the loop-driven replan cap (${replanBudget.maxIterations}); stopping. Pending message retained for the next run.`,
                hierarchyIndent("plan"),
            );
            return { success: outcome.success };
        }

        // Re-enter planning with the relevant message as the new work order.
        const newPrompt = extractReplanPrompt(pendingLoopReplanMessages);
        if (!newPrompt.trim()) {
            status.replan(
                "Loop mode: a relevant message was found but carried no usable text to re-plan with; stopping.",
                hierarchyIndent("plan"),
            );
            return { success: outcome.success };
        }
        replanBudget = consumeReplanBudget(replanBudget);
        iteration += 1;
        commandLinePrompt = newPrompt;
        pendingLoopReplanMessages = [];
        status.replan(
            `Re-planning with the loop message (iteration ${iteration}); ${replanBudget.remaining} loop replan(s) left in budget. The execution worktree is preserved and will be reused.`,
            hierarchyIndent("plan"),
        );
    }
}

runAgentReplanLoop(options)
    .then((outcome) => {
        cleanupExecutionWorktree();
        if (outcome && outcome.success === false) {
            process.exitCode = 1;
        }
    })
    .catch(async (error) => {
        if (error instanceof RunAbortError) {
            // Deliberate abort: print exactly one concise [ABORT] block, then
            // run best-effort cleanup, persist the abort record, and report to
            // Spec Keeper. Aborts never print a stack trace, and a second
            // SIGINT can still force-exit.
            status.abort(abortBlockText(error));
            recordLastAbort(activeConfigData, error);
            cleanupExecutionWorktree(true);
            if (mainCheckoutMayHavePartialWork) {
                status.abort("main-checkout changes were left as-is; no automatic rollback was performed");
            }
            await finalizePromptSpecKeeperAbort(error);
            await finalizeTaskModeAbort(activeTaskLifecycle, error);
            process.exitCode = error.exitCode;
            return;
        }

        cleanupExecutionWorktree();
        const message = error instanceof Error ? error.message : String(error);
        status.error(error instanceof Error ? error.stack ?? message : message);
        if (activeTaskLifecycle && !activeTaskLifecycle.finalized) {
            try {
                await finalizeTaskModeFailure(activeTaskLifecycle, message);
            } catch (finalizeError) {
                status.warning(`Spec Keeper task failure update skipped: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`);
            }
        }
        process.exitCode = 1;
    });
