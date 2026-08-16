/**
 * Agent-bus command detection — the precise rule set used to refuse
 * agent-bus related commands issued through `ExecuteCommand`.
 *
 * AGENT BUS OWNERSHIP
 * -------------------
 * All agent-bus activity is owned by the dedicated `AgentBus` tool (whoami /
 * watch / send) and the `AgentBusEnrol` tool (enroll). Those tools talk to the
 * bus ONLY through the local `./agent-busctl` CLI, which holds the enrolled
 * identity and never exposes secrets back to us. Because invoking
 * `agent-busctl`/`agentbus` from a raw shell command could read or send over
 * the bus outside the sanctioned tool paths (and could operate on the identity
 * store), `ExecuteCommand` must refuse every command that executes one of these
 * binaries and direct the caller to the dedicated tools instead.
 *
 * DETECTION ALGORITHM (exact matching rules)
 * ------------------------------------------
 * 1. Normalize: the command string is trimmed of surrounding whitespace. Only
 *    the first command of each shell segment is inspected (see rule 6).
 * 2. Tokenize with `tokenizeShellWords` so single/double quotes and backslash
 *    escapes are honored — we never execute the command, only split it into
 *    shell words without running anything.
 * 3. Walk the leading words, skipping "environment-assignment" words of the
 *    form `NAME=value` and leading option words that start with `-`. The first
 *    non-option, non-assignment word is the *command word* (the executable).
 * 4. The command word names an agent-bus binary if its basename — the substring
 *    after the last `/` (an absolute path, a `./`-prefixed path, or a bare
 *    name) — is exactly one of:
 *        `agent-busctl` | `agentbus` | `agent-bus`
 *    Path prefixes are allowed (`./agent-busctl`, `bin/agentbus`,
 *    `/usr/local/bin/agent-bus`), and the basename is matched case-sensitively
 *    (these binaries are conventionally lowercase). A word that merely CONTAINS
 *    the string is NOT matched (see edge cases).
 * 5. Refusal is not limited to any action set: ANY subcommand issued against an
 *    agent-bus binary (`enrol`, `whoami`, `watch`, `send`, unknown flags, ...)
 *    is refused. All of them fall under tool ownership, and `enrol` in
 *    particular must go through `AgentBusEnrol`.
 * 6. Compound commands: when the command joins several segments with `&&`, `||`,
 *    `;`, `&`, or a newline, each segment is inspected independently. If ANY
 *    segment executes an agent-bus binary, the entire command is refused
 *    (fail-closed — we never allow a non-agent-bus command to smuggle an
 *    agent-bus invocation alongside it).
 *
 * EDGE CASES (deliberate allowance)
 * ---------------------------------
 * - `echo agent-busctl`, `grep agentbus file`, `cat .agent-bus.local`: NOT
 *   refused — the tokens appear as ordinary arguments, not as the executable.
 *   References to the roster/config path `.agent-bus.local` are read-only data,
 *   not an invocation.
 * - `git agent-busctl`: NOT refused — `agent-busctl` is a `git` subcommand
 *   argument, not a standalone executable; this is git command routing concern,
 *   not an agent-bus action.
 * - `AGENT_BUSCTL=/opt/bin agent-busctl whoami`: REFUSED — the leading env
 *   assignment is skipped and `agent-busctl` is correctly identified as the
 *   executable.
 * - `base64 data.json` or any command that merely reads `data.json`: handled by
 *   the general safety classifier (which bans `data.json`); the agent-bus
 *   detector does not special-case data reads.
 * - An option whose bare VALUE names an agent-bus binary (e.g. `--bus
 *   agent-bus`): REFUSED. The tokenizer treats any non-option, non-assignment
 *   word as a potential command word; `agent-bus` is a standalone word, so it
 *   is treated as a command invocation. Fail-closed: we never let an
 *   agent-bus name slip through as an ambiguous "value". (Such a bare option
 *   is not a valid standalone ExecuteCommand anyway.)
 * - Empty / non-string command, or a command whose executable is unrelated:
 *   `{ action: "none" }` — the caller proceeds with normal handling.
 *
 * The detector performs no I/O, no reads, and no process spawn: it is pure
 * string logic, so it is safe to run before any file/identity read or HTTP
 * call in the ExecuteCommand path.
 */
import { tokenizeShellWords } from "../git-command-router.js";

/** Result of the agent-bus command detection. */
export type AgentBusCommandDetection =
  | { readonly action: "none" }
  | { readonly action: "refuse"; readonly reason: string };

/** Executable basenames that name an agent-bus binary (case-sensitive). */
const AGENT_BUS_EXECUTABLE_NAMES = new Set(["agent-busctl", "agentbus", "agent-bus"]);

/**
 * Return the basename of a candidate executable word — the substring after the
 * last `/`. A bare name (no slash) is returned unchanged; `./agent-busctl`
 * yields `agent-busctl`; a trailing-slash or empty path yields the empty
 * string (never a match).
 */
export function agentBusExecutableBasename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/** True when `word` is a leading env assignment such as `NAME=value`. */
function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** True when the command word's basename names an agent-bus binary. */
export function isAgentBusExecutable(commandWord: string): boolean {
  return AGENT_BUS_EXECUTABLE_NAMES.has(agentBusExecutableBasename(commandWord));
}

/** Split a normalized command into its independent shell segments. */
export function splitCommandSegments(command: string): string[] {
  return command.split(/\s*(?:&&|\|\||;|&|\n)\s*/).filter((segment) => segment.trim().length > 0);
}

/**
 * Inspect ONE already-tokenized command segment and return its command word
 * (the executable), or null when none can be determined.
 */
export function commandWordOfSegment(segment: string): string | null {
  for (const word of tokenizeShellWords(segment)) {
    if (isEnvAssignment(word)) continue; // env assignment, not the executable
    if (word.startsWith("-")) continue; // option/flag, not the executable
    return word;
  }
  return null;
}

/**
 * Detect whether a Bash command executes an agent-bus binary.
 *
 * Rules summary:
 *   - A segment is refused when its command word's basename is exactly
 *     `agent-busctl`, `agentbus`, or `agent-bus` (any path prefix allowed).
 *   - Any action against such a binary is refused (`enrol`, `whoami`, `watch`,
 *     `send`, or an unknown flag), because all agent-bus activity is owned by
 *     the `AgentBus`/`AgentBusEnrol` tools.
 *   - Compound commands are fail-closed: if any segment invokes an agent-bus
 *     binary the whole command is refused.
 *   - Non-executable references (`echo agent-busctl`, `grep agentbus ...`,
 *     `cat .agent-bus.local`) are allowed.
 *
 * @param command the raw ExecuteCommand source (string) to inspect.
 */
export function detectAgentBusCommand(command: unknown): AgentBusCommandDetection {
  if (typeof command !== "string" || command.trim() === "") {
    return { action: "none" };
  }

  for (const segment of splitCommandSegments(command.trim())) {
    const commandWord = commandWordOfSegment(segment);
    if (commandWord !== null && isAgentBusExecutable(commandWord)) {
      return {
        action: "refuse",
        reason:
          "Refused: agent-bus actions are handled by the AgentBus tool. " +
          "Please use the AgentBus tool (or AgentBusEnrol for enrollment) instead of ExecuteCommand " +
          `for agent-busctl/agentbus/agent-bus ('${commandWord}').`,
      };
    }
  }

  return { action: "none" };
}
