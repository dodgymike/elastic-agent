import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HttpPolicy {
  readonly allowedOrigins: readonly string[];
  /** Explicit opt-in for an allowed origin to resolve to non-public addresses. */
  readonly privateOrigins: readonly string[];
}
export interface HttpTransportOptions {
  readonly policy?: HttpPolicy;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Trusted embedding/test dependency; never accepted from tool arguments. */
  readonly resolveAddresses?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
}
export interface HttpTransportResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

function origins(value: string | undefined): string[] {
  return (value ?? "").split(",").filter(Boolean).map((item) => {
    const url = new URL(item.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) throw new Error("HTTP policy requires exact HTTP(S) origins.");
    return url.origin;
  });
}

/** Only operator configuration can grant destinations; model arguments cannot. */
export function httpPolicyFromEnvironment(env: NodeJS.ProcessEnv = process.env): HttpPolicy {
  return {
    allowedOrigins: origins(env.AGENT_HTTP_ALLOWED_ORIGINS),
    privateOrigins: origins(env.AGENT_HTTP_PRIVATE_ORIGINS),
  };
}

/** Conservative public-address classification, including mapped IPv6 rejection. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const first = parseInt(address.split(":")[0], 16);
    // Only ordinary global unicast. Exclude special-use 2001::/23,
    // documentation 2001:db8::/32 and 2002::/16 transition addresses.
    const second = parseInt(address.split(":")[1] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
      && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
      && first !== 0x3fff;
  }
  return false;
}

export function assertHttpDestination(url: URL, policy: HttpPolicy): void {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("HTTP destination must be HTTP(S) without embedded credentials.");
  }
  if (!policy.allowedOrigins.includes(url.origin)) {
    throw new Error(`HTTP origin ${url.origin} is not allowed. Configure AGENT_HTTP_ALLOWED_ORIGINS explicitly.`);
  }
}

/** Validate every resolved address and return one that the socket must use.
 * The request must not perform a second, unchecked DNS lookup.
 */
export function selectHttpAddress(url: URL, policy: HttpPolicy, addresses: readonly { address: string; family: number }[]) {
  assertHttpDestination(url, policy);
  if (!addresses.length || addresses.some((entry) => !isIP(entry.address)
    || (!isPublicAddress(entry.address) && !policy.privateOrigins.includes(url.origin)))) {
    throw new Error("HTTP destination resolves to a denied non-public address.");
  }
  return addresses[0];
}

/** Bounded transport: exact-origin permission, pinned DNS, checked redirects.
 * Native clients avoid proxy environment variables and automatic redirects.
 */
export async function requestHttp(
  input: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  options: HttpTransportOptions = {},
): Promise<HttpTransportResult> {
  const policy = options.policy ?? httpPolicyFromEnvironment();
  for (const name of Object.keys(init.headers ?? {})) {
    if (/^(host|connection|transfer-encoding|content-length|proxy-.*)$/i.test(name)) {
      throw new Error("HTTP routing and hop-by-hop headers cannot be overridden.");
    }
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("HTTP timeout and byte limit must be positive integers.");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("HTTP request aborted."));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("HTTP request deadline exceeded.")), timeoutMs);
  const signal = controller.signal;
  const cancelled = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  let usedBytes = 0;
  const run = async () => {
    let url = new URL(input);
    let method = init.method ?? "GET";
    let body = init.body;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (signal.aborted) throw signal.reason;
      assertHttpDestination(url, policy);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
        : await (options.resolveAddresses?.(hostname) ?? lookup(hostname, { all: true, verbatim: true }));
      if (signal.aborted) throw signal.reason;
      const pinned = selectHttpAddress(url, policy, addresses);
      const result = await new Promise<HttpTransportResult>((resolve, reject) => {
        const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = transport(url, {
          method, headers: init.headers, agent: false, signal,
          lookup: ((_name: string, opts: { all?: boolean }, callback: Function) => {
            if (opts.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          }) as any,
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            usedBytes += chunk.length;
            if (usedBytes > maxBytes) {
              reject(new Error("HTTP response exceeds byte limit."));
              req.destroy(new Error("HTTP response exceeds byte limit."));
              res.destroy();
            } else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("aborted", () => reject(new Error("HTTP response was interrupted.")));
          res.on("end", () => resolve({
            status: res.statusCode ?? 0, statusText: res.statusMessage ?? "",
            headers: Object.fromEntries(Object.entries(res.headers).filter(([, value]) => value !== undefined)
              .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value)])),
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
      });
      if (![301, 302, 303, 307, 308].includes(result.status) || !result.headers.location) return result;
      if (redirects === 5) throw new Error("HTTP redirect limit exceeded.");
      const next = new URL(result.headers.location, url);
      assertHttpDestination(next, policy);
      // Do not transfer custom headers or mutation bodies between origins.
      if (next.origin !== url.origin && (method !== "GET" || body !== undefined || Object.keys(init.headers ?? {}).length)) {
        throw new Error("Cross-origin redirect with headers or request body is denied.");
      }
      if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === "POST")) {
        method = "GET"; body = undefined;
      }
      url = next;
    }
    throw new Error("HTTP redirect limit exceeded.");
  };
  try { return await Promise.race([run(), cancelled]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
