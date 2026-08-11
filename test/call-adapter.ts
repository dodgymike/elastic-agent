/**
 * A simple script that calls the DeepSeek V4 adapter directly.
 *
 * This is the step-9/step-10 harness for the "robust JSON repair" work (task
 * 43b3c126). It constructs a DeepSeekV4Adapter with an injected fetcher (so no
 * live API key or network call is required) and invokes generate() with a
 * representative Write-tool request. The fetcher returns the supplied
 * tool-call arguments verbatim, which drives the adapter through its
 * parse/repair/retry chain.
 *
 * The `mode` argument selects which malformed pattern the mock fetcher returns,
 * so each repair strategy from the execution plan can be driven and verified:
 *   - 'brace'     : missing closing braces ({\"a\":1  → brace matching repair)
 *   - 'bracket'   : missing closing brackets ([... → bracket matching repair)
 *   - 'quote'     : leading non-JSON prose before the first `{` and/or trailing
 *                   prose after the object (quote/violation tolerance)
 *   - 'garbage'   : content after the last `}` must be trimmed (trailing-garbage
 *                   removal, including braces embedded in the garbage text)
 *   - 'truncate'  : output truncated mid-string/value (progressive truncation)
 *   - 'repair'    : generic malformed arguments returned repaired (default)
 *   - 'retry'     : repair fails on the first call; the adapter retries once
 *                   with a pure-JSON hint and returns the clean result
 *   - 'fail'      : both calls return unrepairable arguments; the error surfaces
 *
 * Usage:
 *   node --experimental-strip-types test/call-adapter.ts [<raw-arguments>] [<mode>]
 *
 * If no raw arguments are given, the default for the selected mode is used.
 */
import { DeepSeekV4Adapter, type DeepSeekFetch } from "../llm/deepseek-v4-adapter.js";
import type { GenerateRequest } from "../llm/adapter-contract.js";

const DEFAULT_ARGUMENTS =
  '{"path":"src/app.ts","content":"export function foo() {\\n  return { bar: 1 };\\n}\\n"';

/** Default malformed Write arguments for each repair strategy from the plan. */
const PATTERN_DEFAULTS: Record<string, string> = {
  // Plan step 1: brace matching — missing `}` (and optionally missing `]`).
  brace: '{"path":"a.txt","content":"line1\\nline2"',
  // Plan step 2: bracket matching — an array opened but never closed.
  bracket: '{"files":["a.txt","b.txt","c.txt"',
  // Plan step 3: quote/violation tolerance — prose before the first `{`.
  quote: 'Here is the result: {"path":"a.txt","content":"hi"} Regards.',
  // Plan step 4: trailing garbage after the last `}` (including stray braces).
  garbage: '{"path":"a.txt","content":"hi"} done } more',
  // Plan step 5: progressive truncation — content string cut off mid-way.
  truncate: '{"path":"a.txt","content":"The file is at',
  // Generic repair of a trailing comma / unquoted keys etc.
  repair: '{"path":"a.txt","content":"hi",}',
};

const request: GenerateRequest = {
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: [{ type: "text", text: "Write these files" }] }],
  tools: [
    {
      type: "function",
      name: "Write",
      description: "Write a file to the repository",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean" },
          read_hash: { type: "string" },
        },
      },
    },
  ],
};

/** Build an adapter whose fetcher serves the supplied arguments per attempt index. */
function adapterWithArguments(argumentValues: string[]): {
  adapter: DeepSeekV4Adapter;
  calls: { readonly count: number };
} {
  const calls = { count: 0 };
  let attempt = 0;
  const fetcher: DeepSeekFetch = async () => {
    attempt++;
    calls.count++;
    const args = argumentValues[Math.min(attempt, argumentValues.length) - 1];
    return new Response(JSON.stringify({
      id: `call-${attempt}`,
      model: "deepseek-v4-pro",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [{ id: `call-${attempt}`, type: "function", function: { name: "Write", arguments: args } }],
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { adapter: new DeepSeekV4Adapter("test-key", "https://deepseek.example/v1", fetcher), calls };
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  const mode = process.argv[3] ?? "repair";

  // Determine the raw arguments to return for the selected mode.
  let rawArguments: string;
  if (raw !== undefined && raw !== "") {
    rawArguments = raw;
  } else {
    rawArguments = PATTERN_DEFAULTS[mode] ?? DEFAULT_ARGUMENTS;
  }

  console.log(`=== Simple DeepSeek adapter call script ===`);
  console.log(`mode: ${mode}`);
  console.log(`raw arguments: ${rawArguments}`);
  console.log("");

  let argumentValues: string[];
  if (mode === "retry") {
    // First call unrepairable, retry returns valid JSON.
    argumentValues = ["not json at all", '{"path":"a.txt","content":"repaired on retry"}'];
  } else if (mode === "fail") {
    // Both calls unrepairable.
    argumentValues = ["not json at all", "still not json"];
  } else {
    // Single call: return the pattern (repair, or direct parse for valid input).
    argumentValues = [rawArguments];
  }

  const { adapter, calls } = adapterWithArguments(argumentValues);
  try {
    const response = await adapter.generate(request);
    console.log(`finishReason: ${response.finishReason}`);
    console.log(`http calls made: ${calls.count}`);
    console.log(`tool calls returned: ${response.message.toolCalls?.length ?? 0}`);
    for (const call of response.message.toolCalls ?? []) {
      console.log(`  ${call.name} arguments = ${JSON.stringify(call.arguments)}`);
    }
    console.log("");
    console.log("RESULT: adapter returned a tool call successfully.");
  } catch (error) {
    console.log(`http calls made: ${calls.count}`);
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Object && "code" in error ? (error as { code?: unknown }).code : "unknown";
    console.log(`ERROR (${String(code)}):`);
    console.log(message.slice(0, 500));
    console.log("");
    console.log("RESULT: adapter surfaced an error.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
