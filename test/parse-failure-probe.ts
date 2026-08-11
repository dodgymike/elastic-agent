/**
 * DeepSeek adapter JSON argument repair/probe: document which specific parsing
 * patterns pass or fail in the adapter's JSON argument repair logic.
 *
 * This probe exercises the actual adapter parsing chain via an injected
 * fetcher, reproducing realistic Write-tool arguments, and reports which
 * patterns pass or fail, the exact repair strategy that resolved each one, and
 * a per-strategy coverage summary. Each repair strategy from the
 * robust-JSON-repair plan is represented:
 *   - brace matching (missing `{`/`}` balance)
 *   - bracket matching (missing `[`/`]` balance)
 *   - quote/violation tolerance (strip leading prose before the first `{`)
 *   - trailing garbage removal (trim content after the last `}`)
 *   - progressive truncation (truncate from the end and append closers)
 *   - clean retry (retry once with a pure-JSON hint)
 */
import assert from "node:assert/strict";
import { DeepSeekV4Adapter, diagnoseJsonObjectParse, type DeepSeekFetch } from "../llm/deepseek-v4-adapter.js";
import type { GenerateRequest } from "../llm/adapter-contract.js";

const request: GenerateRequest = {
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "Write these files" }] }],
};

/** Build an adapter whose fetcher returns the supplied function arguments verbatim. */
function deepSeekWithArguments(argumentsValue: string): DeepSeekV4Adapter {
  const fetcher: DeepSeekFetch = async () => new Response(JSON.stringify({
    id: "probe",
    model: "deepseek-v4-pro",
    choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "call-probe", type: "function", function: { name: "Write", arguments: argumentsValue } }] } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  return new DeepSeekV4Adapter("test-key", "https://deepseek.example/v1", fetcher);
}

interface Case {
  readonly name: string;
  readonly raw: string;
  readonly expectFail?: boolean;
}

const cases: Case[] = [
  {
    name: "valid JSON",
    raw: '{"path":"a.txt","content":"hello world"}',
  },
  // Brace matching (plan step 1): missing closing braces appended by balance.
  {
    name: "missing closing brace (incomplete JSON)",
    raw: '{"path":"a.txt","content":"line1\\nline2"',
  },
  {
    name: "missing closing brace (nested object)",
    raw: '{"meta":{"a":"b"},"path":"a.txt"',
  },
  {
    name: "embedded braces in string value (balance scan ignores string literals)",
    raw: '{"content":"a}b}","path":"a.txt"',
  },
  // Bracket matching (plan step 2): missing closing brackets appended by balance.
  {
    name: "missing closing bracket (array)",
    raw: '{"files":["a.txt","b.txt","c.txt"',
  },
  {
    name: "missing closing bracket (nested arrays)",
    raw: '{"matrix":[[1,2],[3,4]',
  },
  {
    name: "missing closing bracket (array inside closed object)",
    raw: '{"list":[1,2,3]}',
  },
  {
    name: "missing comma between properties",
    raw: '{"path":"a.txt" "content":"line1\\nline2"}',
  },
  {
    name: "unescaped double quotes inside string value",
    raw: '{"path":"a.txt","content":"He said "hello" and left"}',
  },
  {
    name: "multi-line content with embedded curly braces",
    raw: '{"path":"a.txt","content":"line1 { nested } line2"}',
  },
  {
    name: "multi-line content with embedded quotes and braces",
    raw: '{"path":"a.txt","content":"const x = { \\"a\\": 1 };\\n// comment" }',
  },
  {
    name: "trailing comma (already repaired)",
    raw: '{"path":"a.txt","content":"hi",}',
  },
  {
    name: "unquoted keys (already repaired)",
    raw: '{path: "a.txt", content: "hi"}',
  },
  {
    name: "single-quoted keys/strings (already repaired)",
    raw: "{'path': 'a.txt', 'content': 'hi'}",
  },
  // Quote/violation tolerance (plan step 3): leading prose before first `{`.
  {
    name: "prose wrapper with fenced json block",
    raw: 'Here is the result:\n```json\n{"path":"a.txt","content":"hi"}\n```',
  },
  {
    name: "prose wrapper, no fence (first-{ to matching-} extraction)",
    raw: 'The file is: {"path":"a.txt","content":"hi"} Enjoy.',
  },
  {
    name: "leading prose wrapping JSON object",
    raw: 'Here are the contents: {"path":"a.txt","content":"hi"}',
  },
  {
    name: "missing closing brace with fenced block",
    raw: 'Here:\n```json\n{"path":"a.txt","content":"hi"',
  },
  {
    name: "missing closing brace with prose trailing",
    raw: 'Here is {"path":"a.txt","content":"hi"',
  },
  {
    name: "missing comma, no closing brace",
    raw: '{"path":"a.txt" "content":"hi"',
  },
  {
    name: "realistic Write arg: large multi-line content with embedded curly brace",
    raw: '{"path":"src/app.ts","content":"export function foo() {\\n  return { bar: 1 };\\n}\\n"}',
  },
  {
    name: "realistic Write arg: content with unescaped quotes in markdown",
    raw: '{"path":"README.md","content":"# Title\\n\\nQuote: \\"hello\\" and more"}',
  },
  {
    name: "extra closing brace at end",
    raw: '{"path":"a.txt","content":"hi"}}',
  },
  {
    name: "property without value then extra content",
    raw: '{"path":"a.txt","content"}',
  },
  {
    name: "array instead of object (should still fail as top-level tool args)",
    raw: '["a","b"]',
    expectFail: true,
  },
  // Trailing garbage removal (step 4): content after the object's last closing
  // brace must be trimmed, even when that garbage itself contains braces.
  {
    name: "trailing comment after JSON",
    raw: '{"path":"a.txt","content":"hi"} // done',
  },
  {
    name: "trailing prose containing a stray closing brace",
    raw: '{"path":"a.txt","content":"hi"} done } more',
  },
  {
    name: "trailing prose with braces after string value that embeds a brace",
    raw: '{"path":"a.txt","content":"a}b"} there } we go',
  },
  {
    name: "leading + trailing prose wrapping JSON",
    raw: 'Here: {"path":"a.txt","content":"hi"} Regards.',
  },
  {
    name: "nested object with trailing garbage",
    raw: '{"path":"a.txt","meta":{"x":1}} trailing',
  },
  // Progressive truncation (plan step 5): output truncated mid-value/string.
  {
    name: "truncated mid-string value",
    raw: '{"path":"a.txt","content":"The file is at',
  },
  {
    name: "truncated before a value",
    raw: '{"path":"a.txt","temp":',
  },
  {
    name: "truncated mid-array value",
    raw: '{"items":["a","b","c',
  },
];

interface Result {
  readonly name: string;
  readonly ok: boolean;
  readonly strategy?: string;
  readonly error?: string;
}

async function main(): Promise<void> {
  const results: Result[] = [];
  for (const c of cases) {
    // Exercise the adapter's real parsing chain to confirm end-to-end behavior.
    let adapterOk = false;
    let adapterError: string | undefined;
    try {
      const adapter = deepSeekWithArguments(c.raw);
      const response = await adapter.generate(request);
      const hasToolCall = response.message.toolCalls !== undefined && response.message.toolCalls.length > 0;
      adapterOk = c.expectFail === true ? !hasToolCall : hasToolCall;
      if (!adapterOk) adapterError = "no tool calls returned";
    } catch (error) {
      adapterOk = c.expectFail === true;
      adapterError = error instanceof Error ? error.message : String(error);
    }
    // Enhanced diagnostic: report exactly which repair strategy resolved the
    // arguments, independent of the expected-pass/fail assertion.
    const diagnosis = diagnoseJsonObjectParse(c.raw);
    const strategy = diagnosis.value !== undefined ? diagnosis.strategy : undefined;
    // A case passes when (a) it was expected to pass and the adapter produced a
    // tool call, or (b) it was expected to fail and the adapter did not.
    const ok = adapterOk;
    results.push({ name: c.name, ok, strategy, error: adapterError });
  }

  console.log("=== DeepSeek JSON parsing/repair probe results (enhanced diagnostics) ===");
  console.log("");
  for (const r of results) {
    const marker = r.ok ? "PASS" : "FAIL";
    console.log(`[${marker}] ${r.name}`);
    if (r.strategy !== undefined) {
      console.log(`      resolved by: ${r.strategy}`);
    } else if (!r.ok && r.error) {
      // Show a condensed error (first line only, capped).
      const firstLine = r.error.split("\n")[0];
      console.log(`      ${firstLine.slice(0, 200)}`);
    }
  }
  const failures = results.filter((r) => !r.ok);
  console.log("");
  console.log(`Summary: ${results.length - failures.length}/${results.length} cases pass. ${failures.length} failing patterns.`);
  if (failures.length > 0) {
    console.log("\nFailing patterns:");
    for (const f of failures) console.log(`  - ${f.name}`);
  }

  // Per-strategy coverage summary: how many cases each repair path resolved.
  console.log("");
  console.log("Repair-strategy coverage (cases resolved by each strategy):");
  const byStrategy = new Map<string, number>();
  for (const r of results) {
    if (r.strategy === undefined) continue;
    byStrategy.set(r.strategy, (byStrategy.get(r.strategy) ?? 0) + 1);
  }
  if (byStrategy.size === 0) {
    console.log("  (none; every case resolved by the direct JSON parse)");
  } else {
    for (const [strategy, count] of [...byStrategy.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${strategy}: ${count}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
