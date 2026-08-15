// One-shot helper: register the new AgentBus identity/store params in
// tools/AgentBus.ts tool declaration inside main.ts. This operates only on the
// in-workspace main.ts file and performs a single, exact string replacement.
const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "main.ts");
const oldText =
  'body: {}, baseUrl: { type: "string" }, accessToken: { type: "string" }, userAgent: { type: "string" },';
const newText =
  'body: {}, baseUrl: { type: "string" }, accessToken: { type: "string" }, identity: { type: "string", description: "Agent identity; defaults to AGENT_BUS_AGENT_ID or the enrolled agentId." }, store: { type: "string", description: "Path to the local credentials roster used for default base URL and identity." }, userAgent: { type: "string" },';

const content = fs.readFileSync(file, "utf8");
if (!content.includes(oldText)) {
  console.error("NOT FOUND");
  process.exit(2);
}
fs.writeFileSync(file, content.split(oldText).join(newText));
console.log("OK");
