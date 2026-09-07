# elastic-agent

An agent for software work, elastic-agent<br>
navigates repositories and gathers evidence to<br>
develop practical execution plans. It can<br>
read files, research permitted web sources, and<br>
execute tasks through checked tool calls,<br>
while recording outcomes and reusable knowledge.<br>
Memory keeps relevant context available,<br>
and configurable providers support the next<br>
cycle of investigation, implementation, and review.

## Get started

Requires **Node.js 22.9.0 or newer**. With nvm, run `nvm install && nvm use`.

```sh
npm ci
npm start -- --provider deepseek-v4 "Investigate the codebase and propose a plan"
```

Supported providers: `openai`, `bedrock-claude`, and `deepseek-v4`. Configure
provider credentials in the launch environment or an optional, untracked `.env`.
Run `npm start -- --help` for all options.

Useful options:

- `--review`: review the work after execution.
- `--session-id <id>`: reuse a memory session.
- `--start-dir <path>` / `--safe-dirs <paths>`: configure workspace access.
- `--allow-agent-source-modifications`: permit changes to agent source.
- `--quiet` / `--very-quiet`: reduce terminal output.

Shell execution defaults to Linux bubblewrap isolation. Hosts without working
namespaces can explicitly select `--shell-mode trusted-host`, which grants host
filesystem/network access. See [security boundaries](docs/security/SECURITY_BOUNDARIES.md)
for shell permissions and HTTP origin configuration.

## Memory

Choose a backend with `ELAGENT_MEMORY_TYPE`:

| Value | Behavior |
| --- | --- |
| `persistent` (default) | Legacy end-of-plan JSON storage. |
| `persistent-v2` | SQLite event storage with session reload and hybrid retrieval. |
| `in-memory` | Volatile session history. |
| `graph` | In-process graph memory. |
| `concat` / `both` | Persistent memory with an in-memory projection. |

Set `ELAGENT_MEMORY_DISABLE=1` to disable memory. For v2 storage, optionally set
`ELAGENT_MEMORY_EVENT_STORE_PATH`. Switching backends does not migrate old data.

Inspect relevant memories and the full initial planning prompt without executing
the task:

```sh
npm run build
ELAGENT_MEMORY_TYPE=persistent-v2 node dist/main.js \
  --interrogate-memory --session-id YOUR_SESSION \
  --provider deepseek-v4 "What did we learn about authentication?"
```

Semantic query expansion uses the configured LLM; set
`ELAGENT_MEMORY_SEMANTIC=0` for lexical-only recall. See
[memory interrogation](docs/memory/MEMORY_INTERROGATION.md) for details and limits.

## Logs and checks

- `agent.log`: concise plans and step outcomes, tagged by session/run.
- `llm.log`: detailed model interactions.
- `--log-prompts`: additionally write `prompt.log`.

```sh
npm test
npm run test:planning-loop
npm run test:memory-hybrid-interrogation
```

Additional focused test commands are listed in [package.json](package.json).

## Documentation

- [Repository layout and development](docs/architecture/REPOSITORY_LAYOUT.md)
- [Execution lifecycle](docs/architecture/SDLC.md) and [completion tracking](docs/architecture/EXECUTION_COMPLETION.md)
- [Prompt templates](docs/prompts.md)
- [Memory contract](docs/memory/MEMORY_V2_CONTRACT.md), [storage](docs/memory/MEMORY_EVENT_STORE.md), and [retention](docs/memory/MEMORY_RETENTION.md)
- [Planning improvements](docs/plans/PLANNING_IMPROVEMENTS.md)
- [Memory improvement tasks](docs/plans/memory-improvements/README.md)
- [Repository self-repair backlog](docs/plans/SELF_REPAIR_BACKLOG.md)
