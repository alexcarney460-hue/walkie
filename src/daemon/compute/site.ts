// The site's compute control plane as this daemon sees it (RENT-2, src/protocol/compute.ts). Every answer is parsed
// with the contract's strict schemas: a field the contract doesn't know (a cost, a provider) fails the parse and never
// reaches the CLI or the dashboard. The origin is pinned like the license service's (src/license/service.ts):
// WALKIE_COMPUTE_SITE is honored only in a source run with WALKIE_DEV=1 and a plain-http loopback URL; tests inject
// `fetch` and `base`. Requests never follow a redirect; the bearer token goes to the site and nowhere else.
import { z, type ZodType, type ZodTypeDef } from "zod";
import {
  ComputeState, CreditCheckout, Quotes, RentalView, RentResult, type CreditBlock, type SiteRentReq,
} from "../../protocol/compute.ts";
import { RELEASE_BUILD, type FetchLike } from "../../license/service.ts";
import { SITE_ORIGIN } from "../../license/site.ts";

const TIMEOUT_MS = 20_000;
/** A state with 1,000 rentals is ~400 KB; anything past this is not our site. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Numeric details of a site error the daemon passes on (e.g. a 402's needed/balance). Nothing else crosses. */
const ERROR_DETAILS = ["needed_micros", "balance_micros", "retry_after_s"] as const;

export interface ComputeSiteOptions { readonly base?: string; readonly fetch?: FetchLike }

/** The site answered with an error (or couldn't be reached: status 0). `details` holds numbers only. */
export class ComputeSiteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Readonly<Record<string, number>> = {}) {
    super(message);
  }
}

/** SITE_ORIGIN, unless a source run (never a release binary) with WALKIE_DEV=1 names a loopback WALKIE_COMPUTE_SITE. */
export function computeBaseFromEnv(env: Record<string, string | undefined> = process.env, release = RELEASE_BUILD): string {
  const v = env.WALKIE_COMPUTE_SITE?.trim();
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

const AccountReply = z.object({ account_id: z.string().regex(/^ca_[0-9a-f]{16}$/), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  adopted_accounts: z.array(z.object({ account_id: z.string().regex(/^ca_[0-9a-f]{16}$/), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })).optional(),
  handover_pending: z.object({ completes_at: z.number().int(), accounts: z.array(z.string().regex(/^ca_[0-9a-f]{16}$/)) }).optional() }).strict();
const StartReply = z.object({ rental: RentalView }).strict();
const StopReply = z.object({ stopped: z.number().int().min(0), rentals: z.array(RentalView) }).strict();
const HandoverStatus = z.object({ chain_id: z.string().regex(/^[0-9a-f]{64}$/),
  accounts: z.array(z.string().regex(/^ca_[0-9a-f]{16}$/)), completes_at: z.number().int().nullable(),
  expires_at: z.number().int(), objected: z.boolean(), notice: z.string().nullable() }).strict();
const HandoverObjection = z.object({ objected: z.literal(true) }).strict();
const HandoverAck = z.object({ acknowledged: z.literal(true) }).strict();
export type StopReply = z.infer<typeof StopReply>;

export class ComputeSite {
  readonly base: string;
  private readonly doFetch: FetchLike;

  constructor(opts: ComputeSiteOptions = {}) {
    this.base = (opts.base ?? SITE_ORIGIN).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((u, init) => fetch(u, init));
  }

  quotes(): Promise<Quotes> { return this.call("GET", "/api/compute/quotes", null, undefined, Quotes); }
  createAccount(teamId: string, proof?: { key: string; expires_at: number; signature: string; genesis?: unknown; authority_chain?: unknown; lic_id?: string; renewal_token?: string }): Promise<z.infer<typeof AccountReply>> {
    return this.call("POST", "/api/compute/account", null, { team_id: teamId, proof }, AccountReply);
  }
  state(token: string): Promise<ComputeState> { return this.call("GET", "/api/compute/state", token, undefined, ComputeState); }
  credit(token: string, block: CreditBlock): Promise<z.infer<typeof CreditCheckout>> {
    return this.call("POST", "/api/compute/credit", token, { block }, CreditCheckout);
  }
  rent(token: string, req: SiteRentReq): Promise<RentResult> { return this.call("POST", "/api/compute/rent", token, req, RentResult); }
  start(token: string, rentalId: string, code: string): Promise<z.infer<typeof StartReply>> {
    return this.call("POST", "/api/compute/start", token, { rental_id: rentalId, code }, StartReply);
  }
  stop(token: string, body: { rental_id: string } | { all: true }): Promise<StopReply> {
    return this.call("POST", "/api/compute/stop", token, body, StopReply);
  }
  handoverStatus(teamId: string, proof: { key: string; expires_at: number; signature: string; roster: unknown }) {
    return this.call('POST', '/api/compute/handover', null,
      { team_id: teamId, action: 'status', proof }, HandoverStatus);
  }
  handoverObject(teamId: string, proof: { key: string; expires_at: number; signature: string; chain_id: string; roster: unknown }) {
    return this.call('POST', '/api/compute/handover', null,
      { team_id: teamId, action: 'object', proof }, HandoverObjection);
  }
  handoverAck(teamId: string, proof: { key: string; expires_at: number; signature: string; chain_id: string; roster: unknown;
    notice_event: unknown; notice_event_id: string; notice_event_hash: string }) {
    return this.call('POST', '/api/compute/handover', null,
      { team_id: teamId, action: 'ack', proof }, HandoverAck);
  }

  private async call<T>(method: "GET" | "POST", path: string, token: string | null, body: unknown, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(['/api/compute/state', '/api/compute/account'].includes(path) ? { 'x-walkie-handover-notice': '1' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ComputeSiteError(0, "site_unreachable", `the Walkie site couldn't be reached (${(err as Error).name})`);
    }
    const parsed = parseJson(await readCapped(res));
    if (res.status < 200 || res.status > 299) throw siteError(res.status, parsed);
    const ok = schema.safeParse(parsed);
    if (!ok.success) throw new ComputeSiteError(502, "bad_site_reply", `the Walkie site's answer to ${path} didn't match this version's contract`);
    return ok.data;
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function siteError(status: number, body: unknown): ComputeSiteError {
  const o = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const code = typeof o.error === "string" && /^[a-z0-9_]{1,60}$/.test(o.error) ? o.error : `http_${status}`;
  const details: Record<string, number> = {};
  for (const k of ERROR_DETAILS) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) details[k] = v;
  }
  return new ComputeSiteError(status, code, `the Walkie site refused: ${code}`, details);
}

/** Reads at most MAX_RESPONSE_BYTES, whatever Content-Length claims. */
async function readCapped(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length") ?? "0") > MAX_RESPONSE_BYTES) throw new ComputeSiteError(502, "bad_site_reply", "the Walkie site's answer is too large");
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
      throw new ComputeSiteError(502, "bad_site_reply", "the Walkie site's answer is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
