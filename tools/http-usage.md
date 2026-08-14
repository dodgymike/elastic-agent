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
