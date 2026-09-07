import { requestHttp, type HttpTransportOptions, type HttpTransportResult } from "./http-transport.js";

export type HttpResult = HttpTransportResult;

export interface HttpOption {
  url: string;
}

/** Calls an HTTP(S) URL and returns both the response and its text body. */
export default async function http(options: HttpOption, transport: HttpTransportOptions = {}): Promise<HttpResult> {
  if (!options || typeof options !== "object") throw new TypeError("Http options must be an object.");
  const url = validateHttpUrl(options.url, "url");
  return requestHttp(url, {}, transport);
}

export function validateHttpUrl(value: unknown, field = "url"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty HTTP(S) URL.`);
  }
  if (value !== value.trim()) throw new TypeError(`${field} must not have leading or trailing whitespace.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field} must be a valid absolute HTTP(S) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${field} must use the http or https protocol.`);
  }
  if (!parsed.hostname) throw new TypeError(`${field} must include a host.`);
  if (parsed.username || parsed.password) throw new TypeError(`${field} must not contain credentials.`);
  return parsed.toString();
}
