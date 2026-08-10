import OpenAI from "openai";
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
class OpenAIResponseWrapper { constructor(response) { this.response = response; } print() { console.log(summarizeResponse(this.response)); } }
function saveData(data, filename = dataFilename) { try { require("fs").writeFileSync(filename, JSON.stringify(data, null, 2)); } catch (error) { console.error("Failed to save data:", error); } }
function readData(filename = dataFilename) { try { return JSON.parse(require("fs").readFileSync(filename, "utf-8")); } catch (error) { console.error("Failed to read data:", error); return null; } }
function isFinalAnswer(output) { return output.type === "message" && output.status === "completed" && output.phase === "final_answer"; }

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
    saveData(configData);
    let finalAnswerFound = false;
    while (!finalAnswerFound) {
        const request = { model: modelList[1], tools, previous_response_id: configData.lastResponseId };
        if (configData.lastToolCallIds?.length > 0) request.input = configData.lastToolCallIds.map((callId) => ({ type: "function_call_output", call_id: callId, output: JSON.stringify(configData.toolCallResponse[callId]) }));
        else request.input = prompt;
        const response = await client.responses.create(request);
        new OpenAIResponseWrapper(response).print();
        const { total, cached, totalMinusCache } = usageSummary(response.usage);
        configData.tokenUsage.push({ response_id: response.id, total_tokens: total, cached_tokens: cached, total_minus_cache: totalMinusCache, input_tokens_details: response.usage?.input_tokens_details ?? {} });
        configData.lastResponseId = response.id;
        configData.lastToolCallIds = [];
        for (const output of response.output ?? []) {
            if (isFinalAnswer(output)) { finalAnswerFound = true; configData.lastResponseId = null; continue; }
            if (output.type !== "function_call") continue;
            console.log(`Executing tool: ${output.name}`);
            const tool = tools.find((candidate) => candidate.name === output.name);
            if (!tool?.exec_handler) { console.error(`No exec_handler found for tool: ${output.name}`); continue; }
            const callId = output.call_id;
            const toolArguments = JSON.parse(output.arguments);
            try { configData.toolCallResponse[callId] = { toolArguments, toolResponse: await tool.exec_handler(toolArguments) }; }
            catch (error) { configData.toolCallResponse[callId] = { toolArguments, toolResponse: { error: error instanceof Error ? error.message : String(error) } }; }
            appendHistory(configData.toolCallTldrs, summarizeToolCall(output.name, toolArguments, configData.toolCallResponse[callId].toolResponse));
            configData.lastToolCallIds.push(callId);
            saveData(configData);
        }
        saveData(configData);
    }
    const totals = totalUsage(configData.tokenUsage);
    console.log(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);
    console.log("Done");
}
main().catch(console.error);
