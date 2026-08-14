# HttpRequest tool usage

## Purpose

Send an HTTP request with an explicit method, headers, and body, including
authenticated or mutating requests when required.

## When to use

Use `HttpRequest` for HTTP requests that need an explicit method, headers, or a
request body, including authenticated or mutating requests. Prefer `Http` for a
bare GET.

## Required parameters

- `url` (string): absolute HTTP(S) URL.

## Optional parameters

- `method` (string): `GET` | `POST` | `PUT` | `PATCH` | `DELETE` (default `GET`).
- `headers` (object): string-to-string header map.
- `body` (string): request body text.

## Result

- `status` (number): HTTP status code.
- `statusText` (string): HTTP status text.
- `headers` (object): response headers.
- `body` (string): response text body.

## Error handling

- Validation errors (URL, method, headers, body type): `TypeError`.
- HTTP error statuses are **not** thrown; always inspect `status`.
- Network/fetch failures propagate.

## Critical operating constraints

- URL validation is the same as the `Http` tool: absolute, `http`/`https`, with
  a host, no surrounding whitespace, and no embedded credentials.
- `method` must be one of the allowed values.
- Header names and values must be non-empty strings without CR/LF/NUL control
  characters.
- `body` must be a string when provided.
- Put credentials in `headers` (e.g. `Authorization`), never in the URL.

## Examples

1. Simple GET:

   ```js
   await HttpRequest({ url: "https://example.com/api/status" });
   ```

2. POST JSON:

   ```js
   await HttpRequest({
     url: "https://example.com/api/tasks",
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ title: "hello" }),
   });
   ```

3. Authenticated request:

   ```js
   await HttpRequest({
     url: "https://example.com/api/private",
     method: "GET",
     headers: { Authorization: `Bearer ${token}` },
   });
   ```
