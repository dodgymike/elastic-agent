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

const prompt = program.args[0];
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const modelList = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

const tools = [
    {
        type: "function",
        name: "Write",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                content: { type: "string" },
                overwrite: { type: "boolean" },
                read_hash: { type: "string" },
            },
            required: ["path", "content", "read_hash"],
        },
        exec_handler: async ({ path, content, overwrite, read_hash }) =>
            Write({ path, content, overwrite, read_hash }),
    },
    {
        type: "function",
        name: "Read",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
        },
        exec_handler: async ({ path }) => Read({ path }),
    },
    {
        type: "function",
        name: "Http",
        parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
        },
        exec_handler: async ({ url }) => Http({ url }),
    },
    {
        type: "function",
        name: "ListDirectory",
        parameters: {
            type: "object",
            properties: { directory: { type: "string" } },
            required: ["directory"],
        },
        exec_handler: async ({ directory }) => ListDirectory({ directory }),
    },
    {
        type: "function",
        name: "Git",
        description: "List repository changes, stage selected changes, or commit staged changes.",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["list", "stage", "commit"],
                    description: "The Git operation to perform.",
                },
                cwd: {
                    type: "string",
                    description: "Optional repository directory. Defaults to the current working directory.",
                },
                paths: {
                    type: "array",
                    items: { type: "string" },
                    description: "Paths to stage. Required for stage unless all is true.",
                },
                all: {
                    type: "boolean",
                    description: "For stage only: explicitly stage all changes. Do not combine with paths.",
                },
                message: {
                    type: "string",
                    description: "Non-empty commit message. Required for commit.",
                },
            },
            required: ["action"],
        },
        exec_handler: async (options) => Git(options),
    },
];

function saveData(data, filename = "data.json") {
    try {
        require("fs").writeFileSync(filename, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error("Failed to save data:", error);
    }
}

function readData(filename = "data.json") {
    try {
        return JSON.parse(require("fs").readFileSync(filename, "utf-8"));
    } catch (error) {
        console.error("Failed to read data:", error);
        return null;
    }
}

async function main() {
    let configData = readData();
    if (!configData) {
        configData = { responseIds: [] };
        saveData(configData);
    }
    if (!configData.requestResponses) {
        configData.requestResponses = [];
        saveData(configData);
    }
    if (!configData.toolCallResponse) {
        configData.toolCallResponse = {};
        saveData(configData);
    }

    const request = {
        model: modelList[1],
        tools,
        previous_response_id: configData.lastResponseId,
    };

    if (configData.lastToolCallIds && configData.lastToolCallIds.length > 0) {
        request.input = configData.lastToolCallIds.map((callId) => ({
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(configData.toolCallResponse[callId]),
        }));
        console.log(`request.input: ${JSON.stringify(request.input)}`);
    } else {
        request.input = prompt;
    }

    const responses = await client.responses.create(request);
    console.log("response:");
    console.dir(responses, { depth: null });
    console.log("Done");

    configData.lastResponseId = responses.id;
    configData.lastToolCallIds = [];

    for (const response of responses.output) {
        if (response.type === "message") {
            console.log(`RESPONSE: ${JSON.stringify(response.content)}`);
            console.log(`status: ${response.status}, phase: ${response.phase}`);
            if (response.status === "completed" && response.phase === "final_answer") {
                configData.lastResponseId = null;
            }
            continue;
        }
        if (response.type !== "function_call") continue;

        console.log(`Executing tool: ${response.name}`);
        const tool = tools.find((candidate) => candidate.name === response.name);
        if (!tool?.exec_handler) {
            console.error(`No exec_handler found for tool: ${response.name}`);
            continue;
        }

        const callId = response.call_id;
        const toolArguments = JSON.parse(response.arguments);
        try {
            const toolResponse = await tool.exec_handler(toolArguments);
            configData.toolCallResponse[callId] = { toolArguments, toolResponse };
        } catch (error) {
            configData.toolCallResponse[callId] = {
                toolArguments,
                toolResponse: { error: error instanceof Error ? error.message : String(error) },
            };
        }
        configData.lastToolCallIds.push(callId);
        saveData(configData);
    }

    saveData(configData);
}

main().catch(console.error);
