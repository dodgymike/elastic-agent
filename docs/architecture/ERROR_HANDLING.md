# Tool Error-Handling Conventions

This document defines the contract for the repository tools. It is intentionally
implementation-neutral: step 4 applies these rules without changing each tool's
successful-result shape unless that change is explicitly documented.

## 1. Error contract

- **Reject/throw operational failures.** Invalid inputs, unavailable
  dependencies, filesystem failures, transport failures, timeouts, malformed
  required responses, and interrupted subprocesses must reject. A failure must
  never be represented as a successful result with an `error` property.
- **Return ordinary non-exceptional outcomes.** A command or Git process that
  starts and exits normally returns its result even with a nonzero `exitCode`;
  callers need its captured `stdout` and `stderr`. HTTP tools return completed
  HTTP responses, including non-2xx responses, only where their documented
  contract treats status inspection as a caller responsibility. Service clients
  (Agent Bus and Spec Keeper) reject non-2xx responses because those APIs are
  used as successful-operation contracts.
- **Make errors actionable but safe.** State the tool, operation, and safe
  target/context, then the failure category. Do not put credential values,
  Authorization headers, enrollment recipes, raw secret-store content, or
  unbounded remote response bodies in errors or logs.
- **Preserve cause.** Wrap lower-level errors using `new Error(message,
  { cause })` (or a compatible error property) whenever context is added. Do
  not replace an error with `JSON.stringify(error)`, and do not use redundant
  `catch (error) { throw error; }` blocks.
- **Bound diagnostics.** Include response bodies only after redaction and a
  fixed length limit. Preserve the complete response body in a returned HTTP
  result when that is its stated success/non-2xx contract, but never duplicate
  it unboundedly in a thrown error.

## 2. Input validation

Validate synchronously at the public tool boundary, before I/O:

- Require the options object and all required fields; reject `null`, arrays,
  and incorrect primitive types with `TypeError`.
- Require non-blank strings after trimming where whitespace has no meaning.
  Preserve literal content fields and command parameters verbatim after type
  validation.
- Validate enum values (`method`, `action`) against explicit allow-lists.
- Validate lists as arrays and validate every member before invoking a
  dependency.
- Reject NUL bytes in filesystem paths, executable arguments that name paths,
  URLs, headers, and command source. Do not silently coerce values.
- Parse URLs with `new URL`; accept only `http:` and `https:` for network
  clients. Reject userinfo in URLs unless a tool explicitly supports it.
- Validate header names and values as strings without CR/LF to prevent header
  injection. Validate a supplied request body is a string when the API sends
  it verbatim.
- For writes, require string content, a boolean overwrite flag, and an exact
  lowercase/uppercase-normalized 64-hex-character SHA-256 precondition when
  replacing an existing file. Creation must be explicit in the documented
  write contract and must not bypass path validation.

## 3. Safe result conventions

- Filesystem reads return `{ content, read_hash }` only on success. Directory
  listing returns an array only on success. Writes resolve only after data is
  durably handed to the OS and all opened handles are closed.
- Process tools always collect UTF-8 `stdout` and `stderr` up to documented
  output limits and return `{ exitCode, stdout, stderr }` (plus command data
  where already part of the contract) for a normal exit, including nonzero
  status.
- HTTP results use plain serializable status, status text, normalized headers,
  and body text. They must not expose a live `Response` object, which is not a
  safe stable tool boundary.
- JSON service clients parse JSON when valid and otherwise retain text in the
  result where safe. A successful empty HTTP body becomes `null` for clients
  whose body is `unknown`.

## 4. Filesystem operations

- Resolve neither symlinks nor parent paths merely for validation; let the OS
  enforce permissions, while reporting operation and safe path context.
- Use atomic create/replace semantics where available. For overwrite,
  re-check the SHA-256 precondition immediately before replacement to avoid a
  time-of-check/time-of-use race. Never truncate the destination until the
  precondition passes.
- Convert expected Node filesystem errors (`ENOENT`, `EACCES`, `EISDIR`,
  `ENOTDIR`, `EEXIST`, `ENOSPC`) into descriptive tool errors with their
  original error as cause. Do not treat a missing requested read/list target
  as an empty result.
- Do not log file contents, directory entries beyond the returned result, or
  hashes unnecessarily.

## 5. Network operations

- Every fetch has a finite timeout using `AbortSignal.timeout` (or an
  equivalent abort controller). The standard default is **30 seconds**;
  authentication and enrollment requests use **15 seconds**. A caller-facing
  timeout option, if introduced, must be bounded between 1 and 120 seconds.
- Retry only transient, idempotent requests: network connection failures,
  timeouts, HTTP 408, 425, 429, and 5xx. Never automatically retry POST,
  PUT, PATCH, DELETE, enrollment redemption, authentication, staging, or
  commits unless a documented idempotency mechanism is supplied.
- Use at most **two retries** (three attempts total), exponential backoff of
  250 ms then 1,000 ms, and honor a valid `Retry-After` up to 30 seconds. Do
  not retry 4xx errors other than the listed transient statuses.
- On a failed service response, include method, safe URL/path, status, and
  bounded/redacted diagnostics in the error. Preserve the network or abort
  error as cause. Authentication errors must not include the response body.

## 6. Child processes and Git

- Spawn executables with argument arrays, never by interpolating untrusted
  values into a shell command. The general command tool is intentionally a
  Bash interpreter; retain positional-parameter passing and document that its
  `command` is trusted Bash source.
- Use a default **60-second** process timeout and terminate the child on
  expiry. Reject startup failure, timeout, signal termination, output-limit
  overflow, and stream errors with captured output where safe and the original
  cause where available.
- Validate `cwd` as a non-blank path and report invalid/missing directories
  clearly. Preserve nonzero normal exit as a result, rather than throwing.
- Git validates action-specific inputs before spawn, keeps `--` before paths,
  and rejects conflicting stage options. It does not retry Git commands.

## 7. Tool-specific application

| Tool | Failure/result policy |
| --- | --- |
| `Read` | Validate path; reject read/decode failures rather than returning `{ error }`. |
| `Write` | Validate all inputs; retain hash precondition; use atomic replacement and causal filesystem errors. |
| `ListDirectory` | Validate path; return entries only on success; remove diagnostic `console.log` output. |
| `Http` | Validate URL; timeout/retry safe GETs; return serializable response metadata and text for completed responses. |
| `HttpRequest` | Validate URL, method, headers, body; timeout; retry only GET; return completed response metadata/text. |
| `AgentBus` | Validate options and JSON serializability; timeout; retry GET only; reject non-2xx with bounded/redacted diagnostics. |
| `SpecKeeper` | Validate options before credential loading; timeout; retry GET only; protect secret-store/auth diagnostics; reject non-2xx causally. |
| `SpecKeeperEnroll` | Validate token type/non-blank; 15-second timeout; never retry redemption; validate required response schema without exposing recipe in errors. |
| `ExecuteCommand` | Validate command and parameter list; timeout/output limits; return normal exit results, reject abnormal execution. |
| `Git` | Complete action/cwd/path/message validation; timeout/output limits; return normal Git exit results, reject abnormal execution. |

## 8. Verification requirements for the implementation step

For every modified tool, add or exercise a success path and each applicable
failure class: invalid input, unavailable dependency/permission or spawn
failure, timeout/abort, malformed response or parse fallback, non-2xx policy,
and preservation of an underlying cause. Tests must assert that errors neither
leak secrets nor turn failures into success-shaped values.
