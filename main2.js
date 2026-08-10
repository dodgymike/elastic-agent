import OpenAI from "openai";
import chalk from "chalk";
import { readFileSync } from "node:fs";
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
program.argument("<prompt>");
program.parse();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const claudeInstructions = readFileSync("CLAUDE.md", "utf-8");
const commandLinePrompt = program.args[0];
const modelList = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const dataFilename = "/tmp/data.json";
const historyLimit = 10;
const planningSuffix = "PROVIDE A CLEAR, STEP-BY-STEP, CONCISE PLAN FOR LATER EXECUTION";

const status = {
    planning: (message) => console.log(`${chalk.cyan.bold("[PLAN]")} ${message}`),
    step: (message) => console.log(`${chalk.yellow.bold("[STEP]")} ${message}`),
    tool: (message) => console.log(`${chalk.blue.bold("[TOOL]")} ${message}`),
    response: (message) => console.log(`${chalk.gray("[RESPONSE]")} ${message}`),
    success: (message) => console.log(`${chalk.green.bold("[SUCCESS]")} ${message}`),
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
                path: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
                body: {}, baseUrl: { type: "string" }, accessToken: { type: "string" }, userAgent: { type: "string" },
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
                clientId: { type: "string" }, region: { type: "string" }, apiBase: { type: "string" }, userAgent: { type: "string" },
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
            summaries.push(`Tool call: ${output.name}${args ? ` ${truncate(args, 160)}` : ""}`);
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
class OpenAIResponseWrapper { constructor(response) { this.response = response; } print() { status.response(summarizeResponse(this.response)); } }
function saveData(data, filename = dataFilename) { try { require("fs").writeFileSync(filename, JSON.stringify(data, null, 2)); } catch (error) { status.error(`Failed to save data: ${error instanceof Error ? error.message : String(error)}`); } }
function readData(filename = dataFilename) { try { return JSON.parse(require("fs").readFileSync(filename, "utf-8")); } catch (error) { status.warning(`Failed to read saved data; starting with a new configuration: ${error instanceof Error ? error.message : String(error)}`); return null; } }
function isFinalAnswer(output) { return output.type === "message" && output.status === "completed" && output.phase === "final_answer"; }

function responseText(response) {
    return (response.output ?? []).filter((output) => output.type === "message").flatMap((output) => output.content ?? [])
        .filter((item) => item.type === "output_text" || item.type === "text").map((item) => item.text).filter(Boolean).join("\n").trim();
}
function planSteps(plan) {
    const steps = plan.split("\n").map((line) => line.trim())
        .filter((line) => /^\d+[.)]\s+/.test(line)).map((line) => line.replace(/^\d+[.)]\s+/, "").trim()).filter(Boolean);
    return steps.length > 0 ? steps : [plan.trim() || "Execute the requested work and report the result."];
}
function recordUsage(configData, response) {
    const { total, cached, totalMinusCache } = usageSummary(response.usage);
    configData.tokenUsage.push({ response_id: response.id, total_tokens: total, cached_tokens: cached, total_minus_cache: totalMinusCache, input_tokens_details: response.usage?.input_tokens_details ?? {} });
}

async function executePlanStep(step, index, steps, plan, configData) {
    status.step(`Current step ${index + 1}/${steps.length}: ${step}`);
    let previousResponseId;
    let toolOutputs = [];
    while (true) {
        const request = { model: modelList[1], tools };
        if (previousResponseId) {
            request.previous_response_id = previousResponseId;
            request.input = toolOutputs;
        } else {
            request.input = `${claudeInstructions}\n\nExecution plan:\n${plan}\n\nYou are executing step ${index + 1} of ${steps.length}: ${step}\nCarry out only this step. Use tools when needed, report the result, and do not begin another plan step.`;
        }
        const response = await client.responses.create(request);
        new OpenAIResponseWrapper(response).print();
        recordUsage(configData, response);
        previousResponseId = response.id;
        toolOutputs = [];
        for (const output of response.output ?? []) {
            if (output.type !== "function_call") continue;
            status.tool(`Executing: ${output.name}`);
            const tool = tools.find((candidate) => candidate.name === output.name);
            const callId = output.call_id;
            let toolArguments;
            try {
                toolArguments = JSON.parse(output.arguments);
                if (!tool?.exec_handler) throw new Error(`No exec_handler found for tool: ${output.name}`);
                const toolResponse = await tool.exec_handler(toolArguments);
                toolOutputs.push({ type: "function_call_output", call_id: callId, output: JSON.stringify(toolResponse) });
                appendHistory(configData.toolCallTldrs, summarizeToolCall(output.name, toolArguments, toolResponse));
                status.success(`Tool completed: ${output.name}`);
            } catch (error) {
                const toolResponse = { error: error instanceof Error ? error.message : String(error) };
                toolOutputs.push({ type: "function_call_output", call_id: callId, output: JSON.stringify(toolResponse) });
                appendHistory(configData.toolCallTldrs, summarizeToolCall(output.name, toolArguments ?? {}, toolResponse));
                status.error(`Tool failed: ${output.name}: ${toolResponse.error}`);
            }
        }
        saveData(configData);
        if (toolOutputs.length === 0) {
            status.success(`Step ${index + 1}/${steps.length} completed.`);
            return;
        }
    }
}

async function main() {
    let configData = readData();
    if (!configData) configData = { responseIds: [] };
    if (!Array.isArray(configData.requestResponses)) configData.requestResponses = [];
    if (!configData.toolCallResponse || typeof configData.toolCallResponse !== "object") configData.toolCallResponse = {};
    if (!Array.isArray(configData.tokenUsage)) configData.tokenUsage = [];
    if (!Array.isArray(configData.commandLinePrompts)) configData.commandLinePrompts = [];
    if (!Array.isArray(configData.toolCallTldrs)) configData.toolCallTldrs = [];
    appendHistory(configData.commandLinePrompts, commandLinePrompt);
    const prompt = buildPrompt(configData.commandLinePrompts, configData.toolCallTldrs);

    status.planning("Creating an execution plan...");
    const planningResponse = await client.responses.create({ model: modelList[1], input: `${prompt}\n\n${planningSuffix}` });
    new OpenAIResponseWrapper(planningResponse).print();
    recordUsage(configData, planningResponse);
    const plan = responseText(planningResponse);
    const steps = planSteps(plan);
    configData.lastResponseId = null;
    configData.lastToolCallIds = [];
    saveData(configData);

    status.success(`Plan created with ${steps.length} step${steps.length === 1 ? "" : "s"}.`);
    for (const [index, step] of steps.entries()) await executePlanStep(step, index, steps, plan, configData);
    const totals = totalUsage(configData.tokenUsage);
    status.success(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);
    status.success("Plan complete. Stopping.");
}
main().catch((error) => status.error(error instanceof Error ? error.stack ?? error.message : String(error)));
