import OpenAI from "openai";
import Write from "./tools/Write.ts";
import Read from "./tools/Read.ts";
import ListDirectory from "./tools/ListDirectory.ts";
import Http from "./tools/Http.ts";
import Git from "./tools/Git.tsx";
import { Command } from "commander";

const program = new Command();
program.argument("<prompt>");
program.parse();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const prompt = program.args[0];
const modelList = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

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
        type: "function", name: "ListDirectory",
        parameters: { type: "object", properties: { directory: { type: "string" } }, required: ["directory"] },
        exec_handler: ({ directory }) => ListDirectory({ directory }),
    },
    {
        type: "function", name: "Git",
        description: "List repository changes, stage selected changes, or commit staged changes.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "stage", "commit"] },
                cwd: { type: "string" },
                paths: { type: "array", items: { type: "string" } },
                all: { type: "boolean" },
                message: { type: "string" },
            },
            required: ["action"],
        },
        exec_handler: (options) => Git(options),
    },
];

function truncate(value, maxLength = 240) {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function summarizeResponse(response) {
    const summaries = [];
    for (const output of response.output ?? []) {
        if (output.type === "function_call") {
            let args = output.arguments ?? "";
            try { args = JSON.stringify(JSON.parse(args)); } catch { /* use raw arguments */ }
            summaries.push(`Tool call: ${output.name}${args ? ` ${truncate(args, 160)}` : ""}`);
        } else if (output.type === "message") {
            const text = (output.content ?? []).filter((item) => item.type === "output_text" || item.type === "text").map((item) => item.text).filter(Boolean).join(" ");
            if (text) summaries.push(`Text response: ${truncate(text)}`);
        }
    }
    return summaries.join("\n") || "No text response or tool calls.";
}

function tokenCount(value) {
    return Number.isFinite(value) ? value : 0;
}

function getCachedTokens(usage) {
    return tokenCount(usage?.input_tokens_details?.cached_tokens);
}

function usageSummary(usage) {
    const total = tokenCount(usage?.total_tokens);
    const cached = getCachedTokens(usage);
    return { total, cached, totalMinusCache: total - cached };
}

class OpenAIResponseWrapper {
    constructor(response) { this.response = response; }
    print() {
        console.log("response:");
        console.log(summarizeResponse(this.response));
        if (this.response.usage) {
            const { total, cached, totalMinusCache } = usageSummary(this.response.usage);
            console.log(`Usage: total_tokens=${total} cached_tokens=${cached} total_minus_cache=${totalMinusCache}`);
        }
    }
}

function saveData(data, filename = "data.json") {
    try { require("fs").writeFileSync(filename, JSON.stringify(data, null, 2)); }
    catch (error) { console.error("Failed to save data:", error); }
}

function readData(filename = "data.json") {
    try { return JSON.parse(require("fs").readFileSync(filename, "utf-8")); }
    catch (error) { console.error("Failed to read data:", error); return null; }
}

async function main() {
    let configData = readData();
    if (!configData) configData = { responseIds: [] };
    if (!Array.isArray(configData.requestResponses)) configData.requestResponses = [];
    if (!configData.toolCallResponse || typeof configData.toolCallResponse !== "object") configData.toolCallResponse = {};
    if (!Array.isArray(configData.tokenUsage)) configData.tokenUsage = [];

    const request = { model: modelList[1], tools, previous_response_id: configData.lastResponseId };
    if (configData.lastToolCallIds?.length > 0) {
        request.input = configData.lastToolCallIds.map((callId) => ({ type: "function_call_output", call_id: callId, output: JSON.stringify(configData.toolCallResponse[callId]) }));
        console.log(`request.input: ${JSON.stringify(request.input)}`);
    } else {
        request.input = prompt;
    }

    const response = await client.responses.create(request);
    new OpenAIResponseWrapper(response).print();

    // Persist the complete cache breakdown for every Responses API result.
    const { total, cached, totalMinusCache } = usageSummary(response.usage);
    configData.tokenUsage.push({
        response_id: response.id,
        total_tokens: total,
        cached_tokens: cached,
        total_minus_cache: totalMinusCache,
        input_tokens_details: response.usage?.input_tokens_details ?? {},
    });

    const totals = configData.tokenUsage.reduce((sum, usage) => ({
        total: sum.total + tokenCount(usage.total_tokens),
        cached: sum.cached + tokenCount(usage.cached_tokens),
        totalMinusCache: sum.totalMinusCache + tokenCount(usage.total_minus_cache),
    }), { total: 0, cached: 0, totalMinusCache: 0 });
    console.log(`Total token usage: total=${totals.total} cached=${totals.cached} total_minus_cache=${totals.totalMinusCache}`);

    configData.lastResponseId = response.id;
    configData.lastToolCallIds = [];
    for (const output of response.output ?? []) {
        if (output.type === "message") {
            if (output.status === "completed" && output.phase === "final_answer") configData.lastResponseId = null;
            continue;
        }
        if (output.type !== "function_call") continue;
        console.log(`Executing tool: ${output.name}`);
        const tool = tools.find((candidate) => candidate.name === output.name);
        if (!tool?.exec_handler) { console.error(`No exec_handler found for tool: ${output.name}`); continue; }

        const callId = output.call_id;
        const toolArguments = JSON.parse(output.arguments);
        try {
            configData.toolCallResponse[callId] = { toolArguments, toolResponse: await tool.exec_handler(toolArguments) };
        } catch (error) {
            configData.toolCallResponse[callId] = { toolArguments, toolResponse: { error: error instanceof Error ? error.message : String(error) } };
        }
        configData.lastToolCallIds.push(callId);
        saveData(configData);
    }
    saveData(configData);
    console.log("Done");
}

main().catch(console.error);
