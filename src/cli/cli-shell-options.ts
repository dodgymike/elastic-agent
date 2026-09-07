import { Command, Option } from "commander";

/** Shared registration lets CLI tests exercise the actual parser without
 * importing src/main.ts and starting providers or integrations.
 */
export function addShellOptions(program: Command): Command {
  return program.addOption(new Option(
    "--shell-mode <mode>",
    "Shell execution mode: sandbox requires Linux bubblewrap; trusted-host uses host filesystem/network access (overrides AGENT_SHELL_MODE)",
  ).choices(["sandbox", "trusted-host"]));
}
