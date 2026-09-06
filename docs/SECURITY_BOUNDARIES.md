# Security boundaries and migration

The security epic introduces breaking changes to protect tool execution. They
apply to the CLI and its HTTP/shell transports; a model cannot override them by
changing tool arguments or asking the classifier for a different verdict.

## Prompt templates

`renderPrompt` accepts named `${placeholder}` substitutions only. Values must
be own scalar data properties. Expressions, property access, getters, unknown
names, and unfinished placeholders are rejected. Values are substituted once,
so `${...}` inside a user request remains literal text.

Custom templates must replace these former expressions:

| Former expression | Named value supplied by the caller |
| --- | --- |
| `${JSON.stringify(feedback)}` | `${feedbackJson}` |
| `${formatPlan(remainingSteps)}` | `${remainingPlan}` |
| `${index + 1}` | `${stepNumber}` |
| `${steps.length}` | `${stepCount}` |

## Filesystem and classification

`--disable-classifier` disables only the LLM classifier. Deterministic denials
remain active; ambiguous calls fail closed when LLM review is disabled.
Unexpected classifier exceptions block reads as well as mutations.

Docker detection selects prompt wording, never extra filesystem permissions.
Use explicit `--start-dir` / `--safe-dirs` roots and the existing source-edit
configuration. Safe-directory entries are canonical absolute paths; relative
aliases are not retained when cwd changes.

The dispatcher rechecks policy immediately before execution and passes resolved
filesystem paths to handlers. New leaves are resolved through their nearest
existing ancestor. Dangling links, symlink loops, protected targets, and
hardlinked regular-file targets are rejected. Protected directory components
also block reads of credential stores whose leaf filenames look harmless.
Recursive Grep checks individual paths before opening, skips protected entries
and hardlinks, and opens with `O_NOFOLLOW`. Directory listings may still reveal
names; they do not authorize reading protected contents.

**Limit:** path revalidation does not provide an atomic OS filesystem boundary
for in-process tools. A hostile process racing directory replacement can still
create a check/use race. Use a dedicated isolated workspace without untrusted
concurrent filesystem writers. Protecting arbitrary sensitive text embedded in
otherwise permitted source files requires additional data-handling policy.

## HTTP destinations

Generic `Http` and `HttpRequest` tools deny all origins by default. The operator
can permit exact origins, including scheme and port:

```sh
AGENT_HTTP_ALLOWED_ORIGINS=https://example.com,http://127.0.0.1:8080
AGENT_HTTP_PRIVATE_ORIGINS=http://127.0.0.1:8080
```

An origin must appear in the first list. If any resolved address is non-public,
it must also appear in the second list. The private list is an explicit grant
to reach that service, not a bypass for other origins. No wildcards or URL paths
are accepted. Configure these environment variables before starting the agent;
do not put credentials in them.

The native transport pins an approved DNS answer to the actual socket, checks
every redirect, and does not use automatic redirects or proxy environment
settings. Cross-origin redirects with custom headers, bodies, or non-GET
methods are refused. The transport rejects routing/hop-by-hop header overrides.
HTTP(S) URL credentials remain forbidden.

Requests have a 30-second total deadline, a cumulative 1 MiB response ceiling,
and at most five redirects. Abort cancels the active request. Both tools return
plain `status`, `statusText`, `headers`, and `body` fields; `Http` no longer
returns a native `Response` object. Non-2xx responses remain inspectable results.

Dedicated authenticated integrations retain their own transport configuration;
these generic-tool allowlists do not change their destinations or authentication.

## Shell execution

`AGENT_SHELL_MODE=sandbox` is the default. It requires Linux, `/usr/bin/bwrap`,
and permission to create user, mount, PID, and network namespaces. Bubblewrap
receives explicit namespace flags and drops capabilities. A setup failure
returns a tool error; it never retries the command on the host.

Select the mode at launch with `--shell-mode sandbox` or
`--shell-mode trusted-host`. Precedence is CLI option, then `AGENT_SHELL_MODE`
(including the optional `.env`), then `sandbox`. Verbose startup output reports
the selected mode. Tool arguments cannot change it during a run.

If `ExecuteCommand` reports "Shell sandbox failed", the machine may lack
bubblewrap or permission to create namespaces. The error preserves captured
stderr for diagnosis. Enable namespace support to retain isolation, or explicitly
add `--shell-mode trusted-host` to your existing launch arguments and restart.
Host mode grants host filesystem/network access; it retains tool safety checks,
environment filtering, deadlines, and output limits. There is no automatic
fallback. A persistent opt-in can use `AGENT_SHELL_MODE=trusted-host` in the
launch environment or local `.env`.

The sandbox exposes standard system executable/library directories read-only,
selected workspace roots with their configured write permissions, private
`/tmp`, `/dev`, and `/proc`, and no host network namespace. Host home/run
locations are not mounted. Known credential/state/configuration paths are
masked, including hardlink aliases found during the mount scan. Git metadata is
masked; use the dedicated Git tool for repository operations. The scan is
bounded at 200,000 entries and fails closed on unsupported special files or
inspection failures. Roots that would expose a whole host/system tree are
rejected.

The environment contains only fixed PATH, HOME, TMPDIR, and LANG values. Provider
credentials, proxy settings, shell startup variables, and Node/loader overrides
are not inherited. The agent's existing flags determine permitted write roots;
without a write grant the CLI mounts its workspace read-only. Build dependencies
must already be installed because the sandbox has no network access.

For an operator who explicitly accepts host filesystem and network access,
`AGENT_SHELL_MODE=trusted-host` selects a non-sandboxed shell. The environment
filter, classifier, timeout, and output limit still apply, but they do **not**
provide isolation. A tool call cannot select this mode. Invalid mode names fail.

Both modes have a 120-second deadline and combined stdout/stderr ceiling of
1 MiB. Abort/limit failures terminate the process group with bounded escalation.
Background processes are not a supported tool result. Limits are configurable
through trusted embedding options, not model-supplied tool fields.

**Limits:** authorized writable mounts share changes with the host. Secret
masking is based on a bounded pre-launch metadata scan, not a transactional
snapshot or a secret-content detector. Do not concurrently add credentials to
mounted workspaces. Trusted system executable directories are assumed to be
administered appropriately. Dedicated Git/integration tools run through their
own implementations and are not covered by the ExecuteCommand sandbox. This is
not a claim that every possible agent operation is OS-isolated.

## Validation and activation

Run:

```sh
npm run build
npm run test:security-epic
```

The security suite exercises production helpers/transports with synthetic files,
local HTTP servers, and stubbed DNS. It checks template expression rejection,
filesystem escapes, protected recursive reads, policy bypass prevention,
HTTP DNS pinning/redirects/deadlines, and shell environment/limits/abort behavior.

On a host that supports bubblewrap, it additionally executes filesystem/network
isolation and an npm build smoke test. Require that gate before enabling the
sandbox in a deployment:

```sh
AGENT_REQUIRE_SANDBOX_TESTS=1 npm run test:security-epic
```

Local validation: `npm run build` and 20 affected suites passed, including
`test:security-epic`, prompt/replan tests, classifier/config tests, filesystem
regressions, scheduling, abort, routing, rendering, and review tests.
`git diff --check` passed. The real sandbox smoke is the explicit skip described
below; deployment validation remains pending. Test logs for this development
session are under `/tmp/elastic-security-checks/` and are not repository artifacts.

The development host used for this change rejects bubblewrap namespace setup.
Here the suite verified fail-closed behavior and explicitly skipped the real
isolation/build smoke. A passing local suite with that skip is not deployment
validation. No live provider or authenticated integration calls were used.

To roll back, revert the security implementation and its template migration
together; old expression templates do not work with the safe renderer. Reverting
also restores the former security weaknesses. No persisted-data migration or
external deployment was performed by this change.
