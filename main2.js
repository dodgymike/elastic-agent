import OpenAI from "openai";

import Write from "./tools/Write.ts";
import Read from "./tools/Read.ts";
import ListDirectory from "./tools/ListDirectory.ts";
import Http from "./tools/Http.ts";
import { config } from "process";

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const modelList = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
];

const tools = [
    {
        type: "function",
        name: "Write",
        // description: "Writes content to a file",
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
        exec_handler: async function ({ path, content, overwrite, read_hash }) {
            return await Write({ path, content, overwrite, read_hash });
        },
    },
    {
        type: "function",
        name: "Read",
        // description: "Reads content from a file",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
            },
            required: ["path",],
        },
        exec_handler: async function ({ path, }) {
            return await Read({ path, });
        },
    },
    {
        type: "function",
        name: "Http",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string" },
            },
            required: ["url",],
        },
        exec_handler: async function ({ url, }) {
            return await Http({ url, });
        },
    },
    {
        type: "function",
        name: "ListDirectory",
        parameters: {
            type: "object",
            properties: {
                directory: { type: "string" },
            },
            required: ["directory",],
        },
        exec_handler: async function ({ directory, }) {
            return await ListDirectory({ directory, });
        },
    },
];

function getTool(name) {
    return tools.find(tool => tool.name === name);
}

function runTool(name, args) {
    const tool = getTool(name);
    if (!tool) {
        throw new Error(`Tool not found: ${name}`);
    }
    return tool.exec_handler(args);
}

function saveData(data, filename = "data.json") {
    // Implement the logic to save data
    try {
        // Example: save data to a file
        const fs = require('fs');
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Failed to save data:', error);
    }
}

function readData(filename = "data.json") {
    try {
        const fs = require('fs');
        const data = fs.readFileSync(filename, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Failed to read data:', error);
        return null;
    }
}

async function main() {
    const configData = readData();

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

    var request = {
        model: modelList[1],
        tools: tools,
        previous_response_id: configData.lastResponseId,
    };

    if (configData.lastToolCallIds) {
        // const toolResult = {
        //     type: "function_call_output",
        //     call_id: configData.lastToolCallId,
        //     output: JSON.stringify({
        //         temperature: 22,
        //         condition: "Sunny",
        //     }),
        // };

        // const toolData = JSON.stringify(configData.toolCallResponse[configData.lastToolCallIds]);

        // console.log(`toolData: ${toolData}`);

        // const toolResult = {
        //     type: "function_call_output",
        //     call_id: configData.lastToolCallId,
        //     output: toolData,
        // };

        // request.input = [toolResult];

        request.input = configData.lastToolCallIds.map(callId => ({
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(configData.toolCallResponse[callId]),
        }));

        console.log(`request.input: ${JSON.stringify(request.input)}`);
    } else {
        request.input = `
        Find all the current tool code in the current directory.
    `;
    }

    const responses = await client.responses.create(request);


    console.log("response:");
    console.dir(responses, { depth: null });

    console.log("Done");

    configData.lastResponseId = responses.id;
    configData.lastToolCallIds = [];

    var loopAgain = false;

    for (var response of responses.output) {
        if (response.type === 'message') {
            console.log(`RESPONSE: ${JSON.stringify(response.content)}`);

            const status = response.status;
            const phase = response.phase;

            console.log(`status: ${status}, phase: ${phase}`);

            if (status === 'completed' && phase === 'final_answer') {
                loopAgain = false;
                configData.lastResponseId = null;
            }
        } else if (response.type === 'function_call') {
            loopAgain = true;

            console.log(`Executing tool: ${response.name}`);
            console.log(`Response ID: ${response.id}`);
            console.log(`type: ${response.type}`);
            console.log(`arguments: ${JSON.stringify(response.arguments)}`);

            var tool = null;
            for (var t of tools) {
                console.log(`Matching tool: ${t.name} against ${response.name}`);
                if (t.name === response.name) {
                    console.log("Found matching tool");
                    console.log(`exec_handler: ${t.exec_handler}`);
                    console.log(`tool: ${JSON.stringify(t)}`);
                    tool = t;
                    break;
                }
            }

            if (tool && tool.exec_handler) {
                console.log(`Executing handler for tool: ${response.name}`);
                console.log(`response: ${JSON.stringify(response)}`);

                const callId = response.call_id;

                const toolArguments = JSON.parse(response.arguments);

                console.log(`toolArguments: ${JSON.stringify(toolArguments)}`);

                const toolResponse = await tool.exec_handler(toolArguments);

                configData.toolCallResponse[callId] = {
                    toolArguments: toolArguments,
                    toolResponse: toolResponse,
                };

                configData.lastToolCallIds.push(callId);

                saveData(configData);
            } else {
                console.error(`No exec_handler found for tool: ${response.name}`);
            }
        }
    }

    saveData(configData);
}

main().catch(console.error);
