const fs = require("fs");
const path = require("path");

const root = process.cwd();
const file = path.join(root, "main.ts");
// helper
const storeName = "." + "agent" + "-bus" + ".local";
const storeText = storeName;

const oldText =
  'body: {}, baseUrl: { type: "string" }, accessToken: { type: "string" }, userAgent: { type: "string" },';

const newText =
  'body: {}, baseUrl: { type: "string" }, accessToken: { type: "string" }, identity: { type: "string", description: "Agent identity; defaults to AGENT_BUS_AGENT_ID or the enrolled agentId in ' +
  storeText +
  '." }, store: { type: "string", description: "Path to the ' +
  storeText +
  ' roster; defaults to AGENT_BUS_STORE or <cwd>/' +
  storeText +
  '." }, userAgent: { type: "string" },';

let content;
try {
  content = fs.readFileSync(file, "utf8");
} catch (error) {
  console.error("READ FAILED: " + error.message);
  process.exit(1);
}

if (!content.includes(oldText)) {
  console.error("NOT FOUND");
  process.exit(2);
}

content = content.split(oldText).join(newText);
fs.writeFileSync(file, content);
console.log("REPLACED OK");
