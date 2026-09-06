# Memory privacy and trust policy (MI-02)

Status: implemented for MI-02. The default backend remains unchanged.

## Data-handling boundary

`memory/privacy.ts` is the single boundary used before persistence,
summarization requests, retrieval rendering, and log/error output:

- `applyMemoryPrivacy` / `sanitizeMemoryJson` normalize values to a bounded,
  JSON-safe shape and reject unserializable input (bigint, cycles, functions)
  with a structured reason.
- `redactMemoryText` removes synthetic secret patterns (provider API keys,
  cloud access keys, private-key blocks, bearer-style tokens, inline
  credential assignments) from strings before they reach persistent state,
  summaries, rendered context, or logs.

Regex redaction is defense-in-depth, not a guarantee. Callers must not write
real credentials into memory payloads.

## What is intentionally retained

- Concise observations, outcomes, decisions, constraints, and evidence
  references.
- Provenance/trust category per record (`user-constraint`, `tool-evidence`,
  `model-claim`, `legacy-import`, `external-content`).
- Ordinary useful facts and non-secret code references.

## What is never retained

- Raw tool dumps, credentials, private internal reasoning, and unrestricted
  environment/configuration objects.
- Model-derived or external text is never treated as authoritative: only
  `user-constraint` records are authoritative, and only when the caller
  explicitly marks them so. Model/external text cannot grant permissions, turn
  failures into verified success, or redefine the current user request.

## Default diagnostics

Adapter errors are metadata-only (provider, code, request type, model,
message); full prompts are no longer printed. `llm.log` and the opt-in
`prompt.log` are redacted through the same boundary and remain bounded.

## State files

New memory directories are created `0700` and new memory files `0600`.
Existing path components that are symlinks, or existing leaves owned by another
user, fail explicitly through `UnsafeMemoryStatePathError` without revealing
file contents. The same rule applies to future import/export paths.

## Policy revision

Stored documents carry `privacyPolicyVersion` (currently `1`) so later
migrations can identify records needing reprocessing.
