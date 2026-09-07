import { readFile } from "node:fs/promises";

export interface HelpOptions {
  /** A tool name (AgentBus, Git, ExecuteCommand, ...) or agent-busctl[:subcommand]. */
  subject: string;
}

export interface HelpResult {
  subject: string;
  /** Repo-relative usage doc path when the subject resolved to a usage file. */
  source?: string;
  content: string;
}

function validateSubject(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("subject must be a non-empty string.");
  }
  if (value.includes("\0")) {
    throw new TypeError("subject cannot contain NUL characters.");
  }
  return value.trim();
}

/** Convert a PascalCase tool name to the usage-file kebab-case form. */
function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const AGENT_BUSCTL_REFERENCE = `# agent-busctl reference

Use the dedicated AgentBus tool for agent-busctl coordination:
- AgentBus({ action: "whoami" }) -> agent-busctl whoami
- AgentBus({ action: "watch", ... }) -> agent-busctl watch
- AgentBus({ action: "send", ... }) -> agent-busctl send
- AgentBus({ action: "agents" }) -> agent-busctl agents
- AgentBus({ action: "logout" }) -> agent-busctl logout
- AgentBusEnrol({ inviteFile }) -> agent-busctl enrol

Never run agent-busctl through ExecuteCommand; those calls are refused.`;

/**
 * Return the usage documentation for an available tool or a small built-in
 * reference for the agent-busctl CLI. Read-only; never executes the CLI.
 */
export default async function Help(options: HelpOptions): Promise<HelpResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Help options must be an object.");
  }
  const subject = validateSubject(options.subject);

  if (subject === "agent-busctl" || subject.startsWith("agent-busctl:")) {
    return { subject, content: AGENT_BUSCTL_REFERENCE };
  }

  const usageFile = `prompts/tools/${kebabCase(subject)}-usage.md`;
  try {
    const content = await readFile(usageFile, "utf8");
    return { subject, source: usageFile, content };
  } catch (error) {
    throw new Error(`Help could not find usage documentation for '${subject}' at '${usageFile}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
  }
}
