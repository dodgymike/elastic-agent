/** Result returned by an HTTP request. */
export interface HttpRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/** Parameters for an HTTP request. `body` is sent verbatim when provided. */
export interface HttpRequestOptions {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Sends an HTTP request and returns its status, response headers, and text body.
 * This complements the read-only Http tool for APIs that require enrollment,
 * authenticated mutations, or other non-GET operations.
 */
export default async function httpRequest({
  url,
  method = "GET",
  headers = {},
  body,
}: HttpRequestOptions): Promise<HttpRequestResult> {
  const response = await fetch(url, { method, headers, body });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}
