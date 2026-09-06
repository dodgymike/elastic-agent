# FileHash tool usage

## Purpose

Compute a file digest without a shell. This makes the `read_hash` precondition
for Edit/Write/Delete self-service instead of requiring an ad-hoc node script.

## When to use

Use `FileHash` whenever the caller needs a SHA-256 (or other supported)
digest for a file before an `Edit`, `Write`, or `Delete` call. Use `PathInfo`
for metadata such as mode/mtime.

## Required parameters

- `path` (string): the file to hash.

## Optional parameters

- `algorithm` (string): `sha1`, `sha256`, `sha384`, or `sha512`; defaults to
  `sha256`.

## Result

- `algorithm` (string): the digest algorithm used.
- `hash` (string): the digest as lowercase hex.
- `size` (number): the file size in bytes.

## Formatted terminal output

The runtime announces the call as `FileHash({...})`. On success it renders a
green circle plus a short result summary; on failure a red circle and the error
message. No `[SUCCESS]` or `[ERROR]` text prefix is emitted.

## Error handling

- Invalid `path` or unsupported `algorithm`: `TypeError`.
- Missing/non-regular file or read failure rejects with an actionable error.

## Critical operating constraints

- Read-only; never creates, modifies, or removes anything.
- Protected-path policy applies: `data.json`, credential stores, and private
  keys are refused.

## Safe use

**Allowed**
- Hashing workspace files for the Edit/Write/Delete hash contract.

**Denied**
- Hashing `data.json`, credential stores, private keys, or paths outside the
  workspace.

**Dangerous examples (do not run)**
- `FileHash({ path: "data.json" })`
- `FileHash({ path: "~/.ssh/id_rsa" })`

**Required permissions**
- Read permission on the hashed file.

## Examples

1. Compute the default SHA-256:

   ```js
   await FileHash({ path: "tools/Read.ts" });
   ```

2. Compute a SHA-512:

   ```js
   await FileHash({ path: "README.md", algorithm: "sha512" });
   ```
