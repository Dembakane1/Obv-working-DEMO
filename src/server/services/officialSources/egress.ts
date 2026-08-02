/**
 * Official-source egress client — the ONLY way connector code performs
 * outbound HTTP.
 *
 * Threat model: the server fetches URLs derived from the source registry
 * and connector configuration. Even though end users never supply URLs,
 * this client refuses everything outside a source's registered host
 * allowlist and pins DNS resolution so a rebinding host cannot swap in a
 * private address between validation and connection:
 *
 *   - scheme: https only (plain http only with the loopback test hatch);
 *   - host: exact match against the source's registered allowed_hosts;
 *   - no embedded credentials in URLs; no userinfo;
 *   - DNS: every resolved address must be public; the socket connects to
 *     the exact validated address (custom lookup), defeating rebinding;
 *   - redirects: never followed automatically; same-host https redirects
 *     are re-validated and followed at most twice, cross-host refused;
 *   - response size is capped while streaming (default 4 MB) and the
 *     request times out (default 15s);
 *   - no Accept-Encoding is sent, so responses arrive uncompressed and a
 *     decompression bomb has no lever;
 *   - Authorization headers are injected from environment references and
 *     never appear in errors, logs, snapshots, or return values.
 *
 * A connector must never have access to banking credentials: this module
 * reads ONLY the env var named by the source's credential_env.
 */
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { OfficialSourceError, plainHttpAllowed, privateSourceHostsAllowed, redactSecrets } from "./core";
import type { OfficialSource } from "../../../shared/types";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;

/** Headers preserved into snapshots for provenance — nothing else. */
const PROVENANCE_HEADERS = ["content-type", "last-modified", "etag", "date", "x-cache", "cache-control"];

export interface EgressResponse {
  httpStatus: number;
  contentType: string | null;
  headers: Record<string, string>;   // allowlisted provenance headers only
  bodyText: string;
  finalUrl: string;
}

// ------------------------------------------------------- address checks

/** True for loopback / private / link-local / CGN / multicast / metadata
 *  addresses and pseudo-hostnames. Works for both hostnames-as-literals
 *  and resolved addresses. */
export function isBlockedAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  const v4 = mapped ? mapped[1] : h;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!octets) return false;
  if (octets.slice(1).some((o) => Number(o) > 255)) return true; // malformed → refuse
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return (
    a === 0 || a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||           // link-local incl. cloud metadata
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224                              // multicast / reserved
  );
}

/** Validate scheme/host/allowlist for one URL against a source. */
export function assertAllowedSourceUrl(source: OfficialSource, raw: string): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new OfficialSourceError("Source endpoint is not a valid absolute URL");
  }
  if (target.username || target.password) {
    throw new OfficialSourceError("Source endpoint must not embed credentials");
  }
  if (target.protocol !== "https:" && !(target.protocol === "http:" && plainHttpAllowed())) {
    throw new OfficialSourceError("Source endpoints must use HTTPS");
  }
  const host = target.hostname.toLowerCase();
  const allowed = source.allowedHosts.map((entry) => entry.toLowerCase());
  if (!allowed.includes(host)) {
    throw new OfficialSourceError(
      `Host "${host}" is not on this source's allowlist — connectors may only contact registered official hosts`,
      403
    );
  }
  if (isBlockedAddress(host) && !privateSourceHostsAllowed()) {
    throw new OfficialSourceError("Source endpoints must be publicly reachable hosts", 403);
  }
  return target;
}

/** Resolve the host and validate EVERY address; return one validated
 *  address to pin the socket to. Rebinding protection: the connection
 *  goes to this exact address, not a second resolution. */
async function resolvePinnedAddress(hostname: string): Promise<{ address: string; family: number }> {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    // Literal address — already validated by assertAllowedSourceUrl.
    return { address: hostname.replace(/^\[|\]$/g, ""), family: hostname.includes(":") ? 6 : 4 };
  }
  let results: Array<{ address: string; family: number }>;
  try {
    results = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new OfficialSourceError("source host could not be resolved", 502);
  }
  if (results.length === 0) throw new OfficialSourceError("source host could not be resolved", 502);
  if (!privateSourceHostsAllowed()) {
    for (const r of results) {
      if (isBlockedAddress(r.address)) {
        throw new OfficialSourceError(
          "Source host resolves to a private or reserved address — refused",
          403
        );
      }
    }
  }
  return results[0];
}

// ------------------------------------------------------------- request

interface FetchOptions {
  method?: "GET";
  /** Extra request headers. Authorization is redacted from all errors. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  /** Acceptable content-type prefixes; anything else is refused. */
  acceptContentTypes?: string[];
}

function pickProvenanceHeaders(res: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PROVENANCE_HEADERS) {
    const value = res.headers[name];
    if (typeof value === "string") out[name] = value.slice(0, 300);
  }
  return out;
}

async function requestOnce(
  source: OfficialSource,
  url: URL,
  opts: FetchOptions
): Promise<{ res: EgressResponse | null; redirectTo: string | null }> {
  const pinned = await resolvePinnedAddress(url.hostname);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const mod = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: opts.method ?? "GET",
        headers: {
          accept: "application/json, application/geo+json, text/csv, text/plain",
          "user-agent": "OBV-OfficialSources/1.0 (evidence-retrieval; contact: operator)",
          ...(opts.headers ?? {}),
          // No accept-encoding: responses arrive uncompressed, so the
          // byte cap below bounds real memory, not a compressed shell.
          "accept-encoding": "identity",
        },
        timeout: timeoutMs,
        // Pin the connection to the validated address; keep SNI/Host for
        // the registered hostname so TLS verifies the real certificate.
        lookup: (_host, lookupOpts, cb) => {
          if ((lookupOpts as { all?: boolean }).all) {
            (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(
              null, [{ address: pinned.address, family: pinned.family }]
            );
          } else {
            cb(null, pinned.address, pinned.family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Redirects are surfaced, never auto-followed.
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ res: null, redirectTo: typeof res.headers.location === "string" ? res.headers.location : null });
          return;
        }
        const contentType = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null;
        if (opts.acceptContentTypes && contentType) {
          const base = contentType.split(";")[0].trim().toLowerCase();
          if (!opts.acceptContentTypes.some((t) => base === t || base.startsWith(t))) {
            res.resume();
            reject(new OfficialSourceError(`Source responded with unexpected content type "${base}"`, 502));
            return;
          }
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy(new OfficialSourceError("source response exceeded the size limit", 502));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            res: {
              httpStatus: status,
              contentType,
              headers: pickProvenanceHeaders(res),
              bodyText: Buffer.concat(chunks).toString("utf8"),
              finalUrl: url.toString(),
            },
            redirectTo: null,
          });
        });
        res.on("error", (err) => reject(err));
      }
    );
    req.on("timeout", () => req.destroy(new OfficialSourceError("source request timed out", 504)));
    req.on("error", (err) => reject(err));
    req.end();
  });
}

/** Fetch one official URL for a source, with allowlisting, pinning,
 *  redirect validation, and caps. Throws OfficialSourceError with a
 *  sanitized message; never includes credentials. */
export async function fetchOfficial(
  source: OfficialSource,
  rawUrl: string,
  opts: FetchOptions = {}
): Promise<EgressResponse> {
  let url = assertAllowedSourceUrl(source, rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let outcome: { res: EgressResponse | null; redirectTo: string | null };
    try {
      outcome = await requestOnce(source, url, opts);
    } catch (err) {
      if (err instanceof OfficialSourceError) throw err;
      const label = redactSecrets(err instanceof Error ? err.message : String(err));
      throw new OfficialSourceError(`source retrieval failed (${label.slice(0, 120)})`, 502);
    }
    if (outcome.res) return outcome.res;
    if (!outcome.redirectTo) {
      throw new OfficialSourceError("Source redirected without a destination", 502);
    }
    // Redirect validation: resolve relative targets, then require the
    // SAME registered host and https; anything else is refused.
    const next = new URL(outcome.redirectTo, url);
    if (next.hostname.toLowerCase() !== url.hostname.toLowerCase()) {
      throw new OfficialSourceError("Source redirected to a different host — refused", 502);
    }
    url = assertAllowedSourceUrl(source, next.toString());
  }
  throw new OfficialSourceError("Source redirected too many times", 502);
}

/** Safe JSON parse with a depth/size already bounded by the byte cap.
 *  Returns null on malformed input (callers record a schema-drift
 *  warning rather than crash). */
export function parseJsonSafely(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
