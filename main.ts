import { createRuntimeLlmAdapter, resolveRuntimeLlmModel } from "./llm/application.js";
import { selectCliProvider } from "./llm/cli-provider-selection.js";
import { MultiTurnLlmRuntime } from "./llm/multi-turn-runtime.js";
import chalk from "chalk";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import Write from "./tools/Write.ts";
import Read from "./tools/Read.ts";
import ListDirectory from "./tools/ListDirectory.ts";
import Http from "./tools/Http.ts";
import HttpRequest from "./tools/HttpRequest.ts";
import Git from "./tools/Git.tsx";
import { executeCommand as ExecuteCommand } from "./tools/ExecuteCommand.ts";
import AgentBus from "./tools/AgentBus.ts";
import SpecKeeper from "./tools/SpecKeeper.ts";
import SpecKeeperEnroll from "./tools/SpecKeeperEnroll.ts";
import { Command } from "commander";

const program = new Command();
program
    .name("elastic-agent")
    .description("Plan and execute a prompt with the selected LLM provider.")
    .argument("<prompt>", "task or request to plan and execute")
    .option("--provider <provider-id>", "LLM provider: openai, bedrock-claude, or deepseek-v4 (overrides LLM_PROVIDER)")
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
const providerSelection = selectCliProvider(process.argv.slice(2));

const modelConfiguration = resolveRuntimeLlmModel({ configuration: providerSelection.configuration });
let client: MultiTurnLlmRuntime;
const claudeInstructions = readFileSync("CLAUDE.md", "utf-8");
const commandLinePrompt = program.args[0];
const dataFilename = "/tmp/data.json";
const memoryFilename = process.env.ELASTIC_AGENT_MEMORY_PATH ?? "/tmp/elastic-agent-memory.json";
const historyLimit = 10;
const maxReplanAttempts = 3;
const maxRevisedPlanSteps = 50;
const planningSuffix = "PROVIDE A CLEAR, STEP-BY-STEP, CONCISE PLAN FOR LATER EXECUTION";
const executionFeedbackFormat = `
After you have finished this step and received outputs for every tool call, report the result and include exactly one machine-readable execution-feedback block. Do not emit this block while tool calls are still needed. Use this exact fenced JSON format:
\`\`\`json
{
  "stepStatus": "completed | partial | blocked | failed",
  "summary": "concise outcome of the current step",
  "findings": ["important finding or blocker"],
  "suggestedStepUpdate": null,
  "suggestedPlanUpdates": [],
  "replanRequired": false,
  "replanReason": null
}
\`\`\`

Field requirements:
- stepStatus must be one of completed, partial, blocked, or failed.
- summary must be a string.
- findings must be an array of strings; use [] when there are none.
- suggestedStepUpdate must be null when no local change is needed, otherwise a concise string describing the change to this step.
- suggestedPlanUpdates must be an array; each item must be an object with "step" (the remaining step number) and "update" (a concise replacement or change). Use [] when there are none.
- replanRequired must be a boolean. Set it to true only when the remaining plan should be replaced rather than updated incrementally.
- replanReason must be null when replanRequired is false, otherwise a concise string explaining why replanning is needed.
`;

const status = {
    planning: (message) => console.log(`${chalk.cyan.bold("[PLAN]")} ${message}`),
    step: (message) => console.log(`${chalk.yellow.bold("[STEP]")} ${message}`),
    tool: (message) => console.log(`${chalk.blue.bold("[TOOL]")} ${message}`),
    response: (message) => console.log(`${chalk.gray("[RESPONSE]")} ${message}`),
    success: (message) => console.log(`${chalk.green.bold("[SUCCESS]")} ${message}`),
    feedback: (message) => console.log(`${chalk.magenta.bold("[FEEDBACK]")} ${message}`),
    change: (message) => console.log(`${chalk.cyan.bold("[PLAN CHANGE]")} ${message}`),
    replan: (message) => console.log(`${chalk.magenta.bold("[REPLAN]")} ${message}`),
    warning: (message) => console.warn(`${chalk.yellow.bold("[WARNING]")} ${message}`),
    error: (message) => console.error(`${chalk.red.bold("[ERROR]")} ${message}`),
};

const tools = [
    {
        type: "function", name: "Write",
        parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" }, read_hash: { type: "string" } },
            required: ["path", "content", "read_hash"],
        },
        exec_handler: ({ path, content, overwrite, read_hash }) => Write({ path, content, overwrite, read_hash }),
    },
    {
        type: "function", name: "Read",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        exec_handler: ({ path }) => Read({ path }),
    },
    {
        type: "function", name: "Http",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        exec_handler: ({ url }) => Http({ url }),
    },
    {
        type: "function", name: "HttpRequest",
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
        parameters: { type: "object", properties: { directory: { type: "string" } }, required: ["directory"] },
        exec_handler: ({ directory }) => ListDirectory({ directory }),
    },
    {
        type: "function", name: "ExecuteCommand",
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
        description: "List repository changes, stage selected changes, or commit staged changes.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "stage", "commit"] }, cwd: { type: "string" },
                paths: { type: "array", items: { type: "string" } }, all: { type: "boolean" }, message: { type: "string" },
            }, required: ["action"],
        },
        exec_handler: (options) => Git(options),
    },
    {
        type: "function", name: "AgentBus",
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
        description: "Redeem a one-time Spec Keeper enrollment token and return its enrollment recipe. The recipe contains secrets and must not be written to the repository.",
        parameters: {
            type: "object", properties: { token: { type: "string", description: "Token from the #token= fragment of a Spec Keeper enrollment URL." } }, required: ["token"],
        },
        exec_handler: ({ token }) => SpecKeeperEnroll({ token }),
    },
];

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
    status.tool(`Pending: ${toolCall.name}${argumentsSummary ? ` ${argumentsSummary}` : ""}`);
}
function renderToolCallSucceeded(toolCall, result) {
    status.success(`Succeeded: ${toolCall.name}${result === undefined ? "" : ` → ${truncate(stringify(result), 160)}`}`);
}
function renderToolCallFailed(toolCall, error) {
    status.error(`Failed: ${toolCall.name}: ${error}`);
}
function appendHistory(history, value) { history.push(value); if (history.length > historyLimit) history.splice(0, history.length - historyLimit); }
function buildPrompt(commandPrompts, toolCallTldrs) {
    const promptHistory = commandPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n") || "(none)";
    const toolHistory = toolCallTldrs.map((tldr, index) => `${index + 1}. ${tldr}`).join("\n") || "(none)";
    return `${claudeInstructions}\n\nRecent command line prompts (oldest to newest; last ${historyLimit}):\n${promptHistory}\n\nRecent tool call TLDRs (oldest to newest; last ${historyLimit}):\n${toolHistory}\n\nCurrent command line prompt:\n${commandLinePrompt}`;
}
function summarizeToolCall(name, toolArguments, toolResponse) { return truncate(`${name}(${truncate(stringify(toolArguments), 160)}) → ${truncate(stringify(toolResponse), 240)}`, 480); }
function summarizeResponse(response) {
    const summaries = [];
    for (const output of response.output ?? []) {
        if (output.type === "function_call") {
            let args = output.arguments ?? ""; try { args = JSON.stringify(JSON.parse(args)); } catch { /* use raw arguments */ }
            // summaries.push(`Tool call: ${output.name}${args ? ` ${truncate(args, 160)}` : ""}`);
        } else if (output.type === "message") {
            const text = (output.content ?? []).filter((item) => item.type === "output_text" || item.type === "text").map((item) => item.text).filter(Boolean).join(" ");
            if (text) summaries.push(`Text response: ${truncate(text)}`);
        }
    }
    return summaries.join("\n") || "No text response or tool calls.";
}
function tokenCount(value) { return Number.isFinite(value) ? value : 0; }
function getCachedTokens(usage) { return tokenCount(usage?.input_tokens_details?.cached_tokens); }
function usageSummary(usage) { const total = tokenCount(usage?.total_tokens); const cached = getCachedTokens(usage); return { total, cached, totalMinusCache: total - cached }; }
function totalUsage(tokenUsage) {
    return tokenUsage.reduce((sum, usage) => ({ total: sum.total + tokenCount(usage.total_tokens), cached: sum.cached + tokenCount(usage.cached_tokens), totalMinusCache: sum.totalMinusCache + tokenCount(usage.total_minus_cache) }), { total: 0, cached: 0, totalMinusCache: 0 });
}
class CompatibleResponseWrapper { constructor(response) { this.response = response; } print() { status.response(summarizeResponse(this.response)); } }
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
function captureExecutionFeedback(configData, response, stepIndex) {
    if (!Array.isArray(configData.executionFeedback)) configData.executionFeedback = [];
    const rawResponse = responseText(response);
    const parsed = parseExecutionFeedback(rawResponse);
    const entry = { response_id: response.id, step: stepIndex + 1, valid: parsed.valid };
    if (parsed.valid) entry.feedback = parsed.feedback;
    else {
        entry.validationError = parsed.reason;
        entry.rawResponse = rawResponse;
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
        status.warning("Replan request skipped because there are no remaining steps to replace.");
        return { attempted: false, applied: false, reason: "No remaining plan steps." };
    }
    if (configData.replanAttemptCount >= maxReplanAttempts) {
        status.warning(`Replan request skipped: the limit of ${maxReplanAttempts} attempts has been reached. Keeping the existing remaining plan.`);
        return { attempted: false, applied: false, reason: "Replan attempt limit reached." };
    }

    configData.replanAttemptCount += 1;
    const attempt = configData.replanAttemptCount;
    status.replan(`Requesting focused revised plan (attempt ${attempt}/${maxReplanAttempts}): ${truncate(feedback.replanReason)}`);
    const completedWork = (configData.completedSteps ?? []).map((entry) => `${entry.step}. ${entry.text}`).join("\n") || "(none)";
    const toolFindings = (configData.toolCallTldrs ?? []).slice(-historyLimit).join("\n") || "(none)";
    const request = `${claudeInstructions}\n\nThe execution plan needs focused replanning. Replace only the remaining work; do not repeat completed work and do not execute tools.\n\nCompleted work:\n${completedWork}\n\nCurrent step feedback:\n${JSON.stringify(feedback)}\n\nRecent tool-result summaries:\n${toolFindings}\n\nExisting remaining steps:\n${formatPlan(remainingSteps)}\n\nReturn a concise, actionable revised plan containing one or more numbered steps only.`;
    try {
        const response = await client.create({ input: request });
        new CompatibleResponseWrapper(response).print();
        recordUsage(configData, response);
        const validation = actionablePlanSteps(responseText(response));
        const historyEntry = { attempt, response_id: response.id, reason: feedback.replanReason, applied: false };
        if (!validation.valid) {
            historyEntry.failure = validation.reason;
            configData.replanHistory.push(historyEntry);
            status.warning(`Rejected revised plan; keeping the existing remaining plan: ${validation.reason}`);
            return { attempted: true, applied: false, reason: validation.reason };
        }
        activeSteps.splice(remainingStart, remainingSteps.length, ...validation.steps);
        historyEntry.applied = true;
        historyEntry.replacementStepCount = validation.steps.length;
        configData.replanHistory.push(historyEntry);
        status.change(`Accepted focused replan: replaced ${remainingSteps.length} remaining step${remainingSteps.length === 1 ? "" : "s"} with ${validation.steps.length}.`);
        return { attempted: true, applied: true, steps: validation.steps };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        configData.replanHistory.push({ attempt, reason: feedback.replanReason, applied: false, failure: reason });
        status.warning(`Replan request failed; keeping the existing remaining plan: ${reason}`);
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
        status.warning(`${stepLabel} feedback was retained as an execution note but not applied: ${feedbackEntry?.validationError ?? "unknown validation error"}`);
        return;
    }

    const feedback = feedbackEntry.feedback;
    status.feedback(`${stepLabel} status: ${feedback.stepStatus}. ${truncate(feedback.summary)}`);
    if (feedback.findings.length > 0) {
        status.feedback(`${stepLabel} findings: ${feedback.findings.map((finding) => truncate(finding, 160)).join("; ")}`);
    }
    if (feedback.replanRequired) {
        status.replan(`${stepLabel} recommends replanning: ${truncate(feedback.replanReason)}`);
    } else {
        status.replan(`${stepLabel} does not recommend replanning.`);
    }
}
function reportAppliedPlanChanges(appliedChanges) {
    if (appliedChanges.localUpdate) {
        status.change(`Accepted local update for step ${appliedChanges.localUpdate.step}: ${truncate(appliedChanges.localUpdate.update)}`);
    }
    for (const update of appliedChanges.planUpdates) {
        status.change(`Accepted update for remaining step ${update.step}: ${truncate(update.update)}`);
    }
    for (const rejected of appliedChanges.rejectedPlanUpdates) {
        status.warning(`Skipped suggested update for step ${rejected.step}: ${rejected.reason}`);
    }
}
function applyExecutionFeedback(feedbackEntry, activeSteps, completedStepCount) {
    const result = { localUpdate: null, planUpdates: [], rejectedPlanUpdates: [] };
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

async function executePlanStep(step, index, steps, plan, configData) {
    status.step(`Current step ${index + 1}/${steps.length}: ${step}`);
    let previousResponseId;
    let toolOutputs = [];
    while (true) {
        const request = { tools } as any;
        if (previousResponseId) {
            request.previous_response_id = previousResponseId;
            request.input = toolOutputs;
        } else {
            request.input = `${claudeInstructions}\n\nExecution plan:\n${plan}\n\nYou are executing step ${index + 1} of ${steps.length}: ${step}\nCarry out only this step. Use tools when needed, report the result, and do not begin another plan step.\n${executionFeedbackFormat}`;
        }
        const response = await client.create(request);
        new CompatibleResponseWrapper(response).print();
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
            const feedbackEntry = captureExecutionFeedback(configData, response, index);
            reportExecutionFeedback(feedbackEntry);
            saveData(configData);
            status.success(`Step ${index + 1}/${steps.length} completed.`);
            return feedbackEntry;
        }
    }
}

async function main() {
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

    status.planning("Creating an execution plan...");
    const planningResponse = await client.create({ input: `${prompt}\n\n${planningSuffix}` });
    new CompatibleResponseWrapper(planningResponse).print();
    recordUsage(configData, planningResponse);
    const plan = responseText(planningResponse);
    const activeSteps = planSteps(plan);
    // These records describe this newly created plan; completed work remains intact while it is replanned.
    configData.completedSteps = [];
    configData.replanAttemptCount = 0;
    configData.replanHistory = [];
    configData.lastResponseId = null;
    configData.lastToolCallIds = [];
    configData.activePlanSteps = [...activeSteps];
    saveData(configData);
    if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);

    status.success(`Plan created with ${activeSteps.length} step${activeSteps.length === 1 ? "" : "s"}.`);
    for (let index = 0; index < activeSteps.length; index += 1) {
        const executedStep = activeSteps[index];
        const feedbackEntry = await executePlanStep(executedStep, index, activeSteps, formatPlan(activeSteps), configData);
        configData.completedSteps.push({ step: index + 1, text: executedStep, feedbackResponseId: feedbackEntry?.response_id ?? null });
        const appliedChanges = applyExecutionFeedback(feedbackEntry, activeSteps, index);
        reportAppliedPlanChanges(appliedChanges);
        await attemptReplan(feedbackEntry, activeSteps, index, configData);
        configData.activePlanSteps = [...activeSteps];
        configData.lastAppliedPlanChanges = appliedChanges;
        saveData(configData);
        if (Object.hasOwn(configData, "memory")) saveMemory(configData.memory);
    }
    const totals = totalUsage(configData.tokenUsage);
    status.success(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);
    status.success("Plan complete. Stopping.");
}
main().catch((error) => status.error(error instanceof Error ? error.stack ?? error.message : String(error)));
