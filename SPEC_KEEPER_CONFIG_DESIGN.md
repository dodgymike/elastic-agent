# Spec Keeper default configuration loading — design

**Plan step:** 3 of 8
**Scope:** Define how the agent loads Spec Keeper defaults from a local
`.spec-keeper` file, how those defaults interact with environment variables and
the prompt fallback, and what the client must do when required values are
missing. Implementation is deferred to later steps.

## 1. Problem

`tools/SpecKeeper.ts` today resolves its non-secret settings inline:

- `projectSlug`: explicit call option → `SPEC_KEEPER_PROJECT_SLUG` → the
  `Project` field in `.spec.local.json` (the secret store).
- `apiBase`: explicit call option → `SPEC_KEEPER_API_BASE` → the `API base`
  field in `.spec.local.json` → hard-coded `https://api.spec.elasticninja.com`.
- Credential store path: `SPEC_KEEPER_CONFIG_PATH` → `.spec.local.json`.

There is no non-secret, project-local defaults file. The documented defaults
(`elastic-agent`, the hosted API base, `.spec.local.json`) exist only in the
usage prompt and `SPEC_KEEPER.md`, not as a single loadable, testable
configuration layer. `main.ts` also passes `process.env.SPEC_KEEPER_PROJECT_SLUG`
directly into `syncSpecKeeperEpic`, which is fragile and makes the config source
hard to report.

## 2. Objectives

1. Load a local, non-secret `.spec-keeper` file as the primary defaults source.
2. Define precedence exactly: local `.spec-keeper` file > environment defaults
   > prompt fallback (with explicit per-call arguments remaining the highest
   layer, preserving existing tool behavior).
3. Support `projectSlug`, `credentialStore`, `apiBase`, and default epic/task
   settings.
4. Fail with a clear, actionable message only when required values are absent
   after all fallback layers have been consulted.
5. Keep secrets out of `.spec-keeper`; credentials stay in the secret store.

## 3. File discovery

- Canonical path: `<cwd>/.spec-keeper` (the repository root when the agent runs
  from the repo).
- Optional meta override for tooling/tests: `SPEC_KEEPER_DEFAULTS_PATH`, which
  changes where the defaults file is read from. This only locates the file; it
  does not participate in value precedence.
- Format: strict JSON (same as `.spec.local.json`). No YAML/TOML dependencies.
- `.spec-keeper` is intentionally **non-secret and safe to commit**. It must
  never contain tokens, passwords, or client IDs. `.spec.local.json` remains
  the secret store and stays gitignored.

### Example file

```json
{
  "projectSlug": "elastic-agent",
  "apiBase": "https://api.spec.elasticninja.com",
  "credentialStore": ".spec.local.json",
  "defaultEpic": {
    "key": "elastic-agent-bootstrap",
    "title": "Elastic Agent bootstrap",
    "description": "Bootstrap work for the elastic-agent.",
    "status": "in_progress"
  },
  "defaultTask": {
    "epicKey": "elastic-agent-bootstrap",
    "keyPrefix": "EA-",
    "status": "in_progress"
  }
}
```

## 4. Configuration model

Canonical shape produced by the loader (`specKeeperConfig.ts` in step 4):

```ts
export interface SpecKeeperEpicDefaults {
  key?: string;          // stable epic key for fetch-or-create
  title?: string;        // fallback title when creating
  description?: string;  // fallback description when creating
  status?: string;       // default status for a newly created epic
}

export interface SpecKeeperTaskDefaults {
  key?: string;          // stable task key for fetch-or-create
  epicKey?: string;      // epic to attach new tasks to when no epic is selected
  keyPrefix?: string;    // prefix for generated task keys when no stable key
  title?: string;        // fallback title when creating
  description?: string;  // fallback description when creating
  status?: string;       // default status for a newly created task
}

export interface SpecKeeperDefaultsConfig {
  projectSlug?: string;
  apiBase?: string;
  credentialStore?: string;
  defaultEpic?: SpecKeeperEpicDefaults;
  defaultTask?: SpecKeeperTaskDefaults;
}
```

Key normalization accepts the same concept in camelCase and snake_case, and the
well-known human-readable variants already used by the secret store:

| Canonical       | Accepted file keys |
|---|---|
| `projectSlug`   | `projectSlug`, `project_slug`, `project`, `Project` |
| `apiBase`       | `apiBase`, `api_base`, `API base`, `API Base` |
| `credentialStore` | `credentialStore`, `credential_store`, `credential store`, `configPath` |
| `defaultEpic`   | `defaultEpic`, `default_epic` |
| `defaultTask`   | `defaultTask`, `default_task` |
| epic `key`      | `key`, `epicKey`, `epic_key` |
| task `key`      | `key`, `taskKey`, `task_key` |
| task `epicKey`  | `epicKey`, `epic_key` |
| task `keyPrefix`| `keyPrefix`, `key_prefix` |
| `title`         | `title` |
| `description`   | `description` |
| `status`        | `status` |

Unknown keys are ignored. Values that are empty strings or whitespace-only are
treated as absent for that layer (so a blank value does not shadow a lower
layer).

## 5. Precedence

Precedence is resolved **per field**, highest first.

### 5.1 Non-secret operational settings (`projectSlug`, `apiBase`, `userAgent`)

1. Explicit per-call arguments (`SpecKeeperOptions.projectSlug`, `.apiBase`,
   `.userAgent`).
2. Local `.spec-keeper` file.
3. Environment defaults (`SPEC_KEEPER_PROJECT_SLUG`, `SPEC_KEEPER_API_BASE`,
   `SPEC_KEEPER_USER_AGENT`).
4. Secret-store compatibility fallback (`Project`, `API base` fields) —
   **deprecated**. Kept only so existing installations without `.spec-keeper`
   continue to work; new deployments should put these values in `.spec-keeper`
   or the environment.
5. Built-in prompt fallback:
   - `projectSlug`: `elastic-agent`
   - `apiBase`: `https://api.spec.elasticninja.com`
   - `userAgent`: `elastic-agent-spec-keeper/1.1`

### 5.2 Credential store path (`credentialStore`)

1. `.spec-keeper` `credentialStore`.
2. Environment `SPEC_KEEPER_CONFIG_PATH`.
3. Built-in prompt fallback `.spec.local.json`.

This path is then handed to the existing secret-store loader, so credentials
continue to come from `.spec.local.json` (or the configured alternative).

### 5.3 Credentials (`accessToken`, `refreshToken`, `username`, `password`, `clientId`, `region`)

1. Explicit per-call arguments.
2. Environment (`SPEC_KEEPER_ACCESS_TOKEN`, `SPEC_KEEPER_REFRESH_TOKEN`,
   `SPEC_KEEPER_USERNAME`, `SPEC_KEEPER_PASSWORD`, `SPEC_KEEPER_CLIENT_ID`,
   `SPEC_KEEPER_REGION`).
3. Secret store at the resolved `credentialStore` path.

`.spec-keeper` is **never** consulted for credentials, and credentials are never
written into `.spec-keeper`.

## 6. Required values and failure behavior

Required values are checked only after all layers have been merged.

- **Project-scoped resource routes** (`/tasks`, `/epics`, etc.) require a valid,
  URL-safe `projectSlug`. The built-in fallback normally supplies
  `elastic-agent`; if it is ever removed or explicitly emptied, the client
  throws:

  > `Spec Keeper projectSlug is required for project resource routes. Configure
  > it in .spec-keeper (projectSlug), SPEC_KEEPER_PROJECT_SLUG, or restore the
  > built-in default 'elastic-agent'.`

- **Authentication** requires an access token, or region + client ID plus a
  refresh token or username/password. The existing clear errors are retained:
  missing region/client ID or missing refresh-token/username/password each have
  a specific message.

- **`apiBase`** has a built-in default, so it is never absent. If provided, it
  is validated to start with `http://` or `https://` and trailing slashes are
  trimmed before use.

- **`credentialStore`** has a built-in default. A missing store file is not an
  error at load time; it becomes an error only if authentication is attempted
  with no other credential source.

### Missing vs malformed `.spec-keeper`

- **Missing file** (including `ENOENT` for the configured path): silently fall
  through to environment and built-in layers; log the config source so the
  fallback is visible.
- **Malformed file** (invalid JSON, non-object root, or a field with an invalid
  type): do not expose file contents. Log a clear, actionable warning (for
  example `Spec Keeper .spec-keeper is invalid: <reason>; using environment and
  built-in defaults.`) and continue with lower layers. If a required value is
  still absent, the resulting required-value error must mention the malformed
  file as a possible cause.

This satisfies "fail only when required values are absent" while never silently
trusting a broken local file as the sole source.

## 7. Module API design

Implement in a new `specKeeperConfig.ts` in step 4 so it is independently
testable and shared by the client and the CLI flows.

```ts
export type SpecKeeperConfigSource = "argument" | "spec-keeper" | "environment"
  | "secret-store" | "builtin";

export interface ResolvedSpecKeeperDefaults {
  projectSlug?: string;          // undefined only for absolute /api/v1 routes
  apiBase: string;
  credentialStore: string;
  defaultEpic?: SpecKeeperEpicDefaults;
  defaultTask?: SpecKeeperTaskDefaults;
  sources: {
    projectSlug: SpecKeeperConfigSource;
    apiBase: SpecKeeperConfigSource;
    credentialStore: SpecKeeperConfigSource;
  };
  warnings: string[];
}

export function loadSpecKeeperDefaultsFile(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): { config: SpecKeeperDefaultsConfig; source: "file" | "missing"; warnings: string[] };

export function resolveSpecKeeperDefaults(
  explicit?: Partial<SpecKeeperOptions>,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ResolvedSpecKeeperDefaults;
```

`loadSpecKeeperDefaultsFile` parses and normalizes the file only.
`resolveSpecKeeperDefaults` merges all layers and returns the winning value plus
the winning source for logging. Testability is preserved by accepting `cwd` and
`env` fixtures; production callers omit them.

## 8. Integration points

- `tools/SpecKeeper.ts`
  - Replace inline `getProjectSlug`, api-base resolution, and credential-store
    path selection with `resolveSpecKeeperDefaults`.
  - Parameterize `loadSecretConfig(filename)` so the resolved credential store
    path is used.
  - Keep explicit call arguments highest so existing callers and tests are
    unchanged.
- `specKeeperFlow.ts`
  - No signature change required. The flow already forwards `...sendOptions` to
    the client; the client now resolves defaults itself.
  - Step 5 will consume `defaultEpic`/`defaultTask` when creating or matching
    epics and tasks.
- `main.ts`
  - Resolve defaults once near startup, log the config source and selected
    project slug (without secrets).
  - Stop passing `process.env.SPEC_KEEPER_PROJECT_SLUG` directly; pass the
    resolved value or omit it and let the client resolve.
  - The LLM-facing `SpecKeeper` tool keeps resolving per call, which is
    deterministic and safe.

## 9. Logging

For verification, every run must log (no secret values):

- config source per resolved field (`spec-keeper`, `environment`,
  `secret-store`, or `builtin`);
- the selected `projectSlug`, `apiBase`, and credential-store **path** (never
  its contents);
- one concise line per Spec Keeper operation (epic sync, plan update, task
  create/fetch/status change, review completion).

Existing redaction rules for request diagnostics remain in force.

## 10. Test plan (step 7)

Add `test/spec-keeper-config.test.ts` and an npm script
`test:spec-keeper-config`, covering:

1. Missing `.spec-keeper` → built-in fallback values and source `builtin`.
2. `.spec-keeper` overrides environment; environment overrides built-in.
3. Explicit call argument overrides `.spec-keeper`.
4. camelCase, snake_case, and human-readable key normalization.
5. Empty/whitespace values are treated as absent.
6. Malformed JSON → warning, fallback proceeds; required-value error mentions
   the malformed file when nothing else supplies the value.
7. Credential-store path precedence (`.spec-keeper` > `SPEC_KEEPER_CONFIG_PATH`
   > `.spec.local.json`).
8. Project-scoped route without a resolvable slug throws the new clear message;
   absolute `/api/v1/...` routes do not require a slug.
9. Existing `test/spec-keeper-routes.test.ts` and
   `test/spec-keeper-epic-flow.test.ts` continue to pass.

## 11. Security constraints

- `.spec-keeper` may contain only non-secret operational defaults.
- Do not copy `.spec.local.json` values into `.spec-keeper`, docs, or logs.
- The loader must never include file contents in error messages for the secret
  store; for `.spec-keeper` malformed errors, report only a type/shape reason,
  not raw values.
- The design keeps `.spec.local.json` gitignored and adds no new secret paths.
