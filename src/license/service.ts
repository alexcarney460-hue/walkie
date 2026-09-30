// The vendor's license service (site/api/license/{bind,renew}): the only calls Walkie makes home, both
// from the roster authority. The origin is pinned to SITE_ORIGIN (audit M6): WALKIE_LICENSE_URL is
// honored only for plain-http loopback AND WALKIE_DEV=1, and requests never follow a redirect.
// Tests inject `fetch` (and may name a base) through the constructor, never through the environment.
import { SITE_ORIGIN } from "./site.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface ServiceOptions {
  /** Test injection only (production: SITE_ORIGIN, or serviceBaseFromEnv in development). */
  readonly base?: string;
  readonly fetch?: FetchLike;
}

/** The reply: HTTP status and the parsed JSON object (null if the body isn't a JSON object). */
export interface ServiceReply { readonly status: number; readonly body: Record<string, unknown> | null }

/**
 * Set by scripts/build.ts (`--define WALKIE_EMBEDDED=true`) in release binaries: the development override
 * below is compiled out of them (FINAL Codex 7) and exists only in source runs.
 */
declare const WALKIE_EMBEDDED: boolean | undefined;
export const RELEASE_BUILD: boolean = typeof WALKIE_EMBEDDED !== "undefined" && WALKIE_EMBEDDED === true;

/**
 * SITE_ORIGIN, unless this is a source run (never a release binary), WALKIE_DEV=1 and WALKIE_LICENSE_URL
 * is http://127.0.0.1… or http://localhost… (its origin).
 */
export function serviceBaseFromEnv(env: Record<string, string | undefined> = process.env, release = RELEASE_BUILD): string {
  const v = env.WALKIE_LICENSE_URL?.trim();
  if (release || !v || env.WALKIE_DEV !== "1") return SITE_ORIGIN;
  try {
    const u = new URL(v);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol === "http:" && loopback && !u.username && !u.password) return u.origin;
  } catch {
    // not a URL: the pinned origin
  }
  return SITE_ORIGIN;
}

export class LicenseService {
  readonly base: string;
  private readonly doFetch: FetchLike;

  constructor(opts: ServiceOptions = {}) {
    this.base = (opts.base ?? SITE_ORIGIN).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((u, init) => fetch(u, init));
  }

  /** Exchanges an activation code for a license bound to `teamId` (first bind also returns the renewal token). */
  bind(code: string, teamId: string, proof?: unknown): Promise<ServiceReply> {
    return this.post("/api/license/bind", { code, team_id: teamId, ...(proof === undefined ? {} : { proof }) });
  }

  /** A fresh license for a bound subscription, authorized by its renewal token. */
  renew(licId: string, renewalToken: string): Promise<ServiceReply> {
    return this.post("/api/license/renew", { lic_id: licId, renewal_token: renewalToken });
  }

  /** The daily check-in (FINAL Codex 4): `{seats, plan, expires_at, newer}`; newer = a grant change after `issuedAt`. */
  status(licId: string, renewalToken: string, issuedAt: number): Promise<ServiceReply> {
    return this.post("/api/license/status", { lic_id: licId, renewal_token: renewalToken, issued_at: issuedAt });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<ServiceReply> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await readCapped(res);
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const obj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    return { status: res.status, body: obj };
  }
}

/** Reads at most MAX_RESPONSE_BYTES, whatever Content-Length claims (the body is streamed, then cut off). */
async function readCapped(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length") ?? "0") > MAX_RESPONSE_BYTES) throw new Error("license service response too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("license service response too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The `key` string of a reply, or null. */
export function replyKey(r: ServiceReply): string | null {
  const k = r.body?.key;
  return typeof k === "string" && k.length > 0 && k.length <= 4_096 ? k : null;
}
