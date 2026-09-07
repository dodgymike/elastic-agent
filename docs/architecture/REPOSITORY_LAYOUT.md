# Repository layout

Application code lives in `src/`; tests mirror its domains in `tests/`.

| Directory | Contents |
| --- | --- |
| `src/main.ts` | CLI entry point and execution orchestration |
| `src/cli/` | Argument parsing and startup checks |
| `src/planning/` | Plans, prompt construction, patches, and outcomes |
| `src/runtime/` | Execution loops, durable state, workspace setup, and logs |
| `src/llm/` | Provider adapters, model configuration, and model runtime |
| `src/memory/` | Memory backends, retrieval, retention, and evaluation |
| `src/tools/` | Tool implementations and registration |
| `src/safety/` | Tool policy, classification, and source protection |
| `src/ui/` | Terminal output and rendering |
| `src/integrations/` | External service clients |
| `src/storage/` | Database repositories |
| `tests/` | Domain tests, shared fixtures, and suite registry |
| `prompts/` | Runtime prompt templates; tool instructions in `prompts/tools/` |
| `docs/` | Architecture, operations, provider guides, and improvement plans |
| `scripts/` | Build, test, migration, and analysis entry points |
| `migrations/` | Ordered database migrations |

`README.md` and `CLAUDE.md` remain at the repository root. Runtime state,
logs, and local worktrees are not source code and remain in their existing locations.

## Build and run

Use Node.js 22.9.0 or newer and install dependencies with `npm ci`.

```sh
npm run build
node dist/main.js --help
npm start -- --provider deepseek-v4 "Investigate the repository"
```

`tsconfig.json` compiles application code into `dist/`. The executable stays
`dist/main.js`. Runtime templates are read from `prompts/`, so keep that directory
alongside the application when packaging it.

## Tests

```sh
npm test
npm run test:planning-loop
npm run test:agent-startup
```

`npm test` runs every registered test file once. Focused commands select a suite
from `tests/suites.json`. Add new test files to that registry; TypeScript tests
compile through `tsconfig.test.json` into ignored `.test-build/` output.
JavaScript tests run directly, and Python tests require `python3`.

The runner builds the application before testing and isolates model logs under
`.test-build/logs/`. The agent startup test uses a temporary workspace and a fake
provider to exercise CLI help, memory interrogation, planning research, execution
tool calls, and completion logs without credentials or network requests. Live
provider authentication and host sandbox support require their own environment.
