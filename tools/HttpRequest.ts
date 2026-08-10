import { validateHttpUrl } from "./Http";

export interface HttpRequestResult { status: number; statusText: string; headers: Record<string, string>; body: string; }
export interface HttpRequestOptions { url: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; headers?: Record<string, string>; body?: string; }

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Sends a validated HTTP request and returns status, headers, and text body. */
export default async function httpRequest(options: HttpRequestOptions): Promise<HttpRequestResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("HTTP request options must be an object.");
  const url = validateHttpUrl(options.url, "url");
  const method = options.method ?? "GET";
  if (typeof method !== "string" || !METHODS.has(method)) throw new TypeError("method must be one of GET, POST, PUT, PATCH, or DELETE.");
  if (options.body !== undefined && typeof options.body !== "string") throw new TypeError("body must be a string when provided.");
  const headers = validateHeaders(options.headers);
  const response = await fetch(url, { method, headers, body: options.body });
  return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
}

export function validateHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("headers must be an object with string names and values.");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!name || /[\r\n\0]/.test(name) || typeof headerValue !== "string" || /[\r\n\0]/.test(headerValue)) {
      throw new TypeError("headers must have non-empty string names and string values without control characters.");
    }
    headers[name] = headerValue;
  }
  return headers;
}
