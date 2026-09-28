// Automatic license renewal (docs/BUSINESS.md "Renewal"). On the roster authority only: once a day
// (with jitter) the authority checks in with the license service (`/api/license/status`, FINAL Codex 4)
// and POSTs `{lic_id, renewal_token}` to `/api/license/renew` when the chain's license expires within
// RENEW_WINDOW_MS OR the service reports a newer grant (a seat or price change made in the billing
// portal). The returned key is activated if it verifies, names this team and the same license, and the
// chain's license hasn't changed while the request was in flight (audit M7). The renewal token comes
// from the token file written at activation (renew-token.ts); without one there is no call. Every
// failure is logged and retried the next day; none is ever fatal. `walkie license refresh` runs the
// same exchange on demand.
import type { Core } from "../daemon/core.ts";
import { HttpError } from "../daemon/http.ts";
import type { Logger } from "../daemon/logger.ts";
import { activateOnAuthority } from "./activate.ts";
import { licenseForTeam } from "./format.ts";
import { DAY_MS } from "./plans.ts";
import { loadRenewToken, type StoredToken } from "./renew-token.ts";
import { LicenseService, replyKey, type ServiceReply } from "./service.ts";

export const RENEW_WINDOW_MS = 7 * DAY_MS;
export const RENEW_EVERY_MS = DAY_MS;
/** Each wait is RENEW_EVERY_MS plus up to this much, and the first one is 1 min plus up to this much. */
export const RENEW_JITTER_MS = 60 * 60_000;
const FIRST_DELAY_MS = 60_000;

export type RenewOutcome =
  | "not_authority" | "no_license" | "not_due" | "no_token" | "renewed" | "refreshed" | "unchanged" | "superseded" | "refused" | "failed";

export interface RenewOptions {
  /** The license service client (default: the pinned production origin). */
  readonly service?: LicenseService;
  readonly now?: () => number;
  readonly random?: () => number;
}

/** What the tick found before deciding: the chain's license and this machine's token for it. */
type Ready = { readonly core: Core; readonly lic: NonNullable<Core["roster"]["license"]>; readonly tok: StoredToken; readonly team: string };

function ready(core: Core, log: Logger): Ready | RenewOutcome {
  if (!core.isAuthority()) return "not_authority";
  const lic = core.roster.license;
  if (!lic) return "no_license";
  const team = core.teamId as string;
  const tok = loadRenewToken(core.paths.home);
  if (!tok || tok.lic_id !== lic.payload.lic_id || tok.team !== team) {
    log.warn("license_renew_no_token", { lic_id: lic.payload.lic_id });
    return "no_token";
  }
  return { core, lic, tok, team };
}

/**
 * One renewal exchange: POST renew, verify, activate. `why` names the trigger for the log. Throws on
 * a malformed answer (the caller logs it); returns "refused" on a 4xx/5xx.
 */
async function exchange(r: Ready, service: LicenseService, log: Logger, why: "expiry" | "newer" | "manual"): Promise<RenewOutcome> {
  const { core, lic, tok, team } = r;
  const res = await service.renew(lic.payload.lic_id, tok.token);
  if (res.status < 200 || res.status > 299) {
    log.warn("license_renew_refused", { status: res.status, lic_id: lic.payload.lic_id, why });
    return "refused";
  }
  const key = replyKey(res);
  if (!key) throw new Error("renewal response has no key");
  const fresh = core.licenseVerifier(key);
  if (!fresh.ok) throw new Error(`renewed key rejected: ${fresh.reason}`);
  if (!licenseForTeam(fresh.payload, team)) throw new Error("renewed key is not a license for this team");
  if (fresh.payload.lic_id !== lic.payload.lic_id) throw new Error("renewed key is for another license");
  // M7: the owner may have activated another license while we waited; never replace it with this answer.
  if (core.roster.license?.event_id !== lic.event_id) {
    log.info("license_renew_superseded", { lic_id: lic.payload.lic_id });
    return "superseded";
  }
  const p = fresh.payload, cur = lic.payload;
  // Stripe hasn't started the next period yet: the same grant with a new issue time adds nothing to the chain.
  if (p.expires_at <= cur.expires_at && p.seats === cur.seats && p.plan === cur.plan) return "unchanged";
  const ev = activateOnAuthority(core, key);
  log.info("license_renewed", { lic_id: fresh.payload.lic_id, expires_at: fresh.payload.expires_at, seats: p.seats, event: ev?.id ?? null, why });
  return ev ? (why === "expiry" ? "renewed" : "refreshed") : "unchanged";
}

/** Whether the service reports a grant newer than the chain's license (false on any failure, which is logged). */
async function newerGrant(r: Ready, service: LicenseService, log: Logger): Promise<boolean> {
  let res: ServiceReply;
  try {
    res = await service.status(r.lic.payload.lic_id, r.tok.token, r.lic.payload.issued_at);
  } catch (err) {
    log.warn("license_status_failed", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
  if (res.status < 200 || res.status > 299) {
    log.warn("license_status_refused", { status: res.status, lic_id: r.lic.payload.lic_id });
    return false;
  }
  const b = res.body;
  if (b?.newer === true) return true;
  // Belt and braces: the grant the service describes differs from the chain's in what the license carries.
  const cur = r.lic.payload;
  return (typeof b?.seats === "number" && b.seats !== cur.seats) || (typeof b?.plan === "string" && b.plan !== cur.plan);
}

/**
 * `walkie license refresh` / POST /v1/license/refresh: fetch the current grant now, whatever the expiry.
 * Throws HttpError for the caller (not the authority, no license, no token, service refusal).
 */
export async function refreshLicense(core: Core, service: LicenseService, log: Logger): Promise<{ outcome: RenewOutcome }> {
  const r = ready(core, log);
  if (typeof r === "string") {
    const text: Record<string, [number, string, string]> = {
      not_authority: [409, "not_authority", "licenses are refreshed on the team's roster authority: run `walkie license refresh` there"],
      no_license: [409, "no_license", "this team has no license to refresh (activate one first)"],
      no_token: [409, "no_renewal_token", "no renewal token on this machine: copy ~/.walkie/license-renew-token from the machine that activated the code, or email support"],
    };
    const [status, code, message] = text[r] ?? [500, "internal", r];
    throw new HttpError(status, code, message);
  }
  let outcome: RenewOutcome;
  try {
    outcome = await exchange(r, service, log, "manual");
  } catch (err) {
    log.warn("license_refresh_failed", { err: err instanceof Error ? err.message : String(err) });
    throw new HttpError(502, "license_service_unavailable", "the license service's answer wasn't a usable key for this team; try again later");
  }
  if (outcome === "refused") throw new HttpError(402, "subscription_inactive", "the license service refused the renewal: the subscription isn't active, or the token no longer matches");
  return { outcome };
}

export class LicenseRenewer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly service: LicenseService;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly core: Core, private readonly log: Logger, opts: RenewOptions = {}) {
    this.service = opts.service ?? new LicenseService();
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  start(): void {
    this.schedule(FIRST_DELAY_MS + this.random() * RENEW_JITTER_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(RENEW_EVERY_MS + this.random() * RENEW_JITTER_MS));
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One daily check-in (exported for tests and the daily timer). Never throws. */
  async tick(): Promise<RenewOutcome> {
    try {
      return await this.attempt();
    } catch (err) {
      this.log.warn("license_renew_failed", { err: err instanceof Error ? err.message : String(err) });
      return "failed";
    }
  }

  private async attempt(): Promise<RenewOutcome> {
    const r = ready(this.core, this.log);
    if (typeof r === "string") return r;
    if (r.lic.payload.expires_at - this.now() <= RENEW_WINDOW_MS) return exchange(r, this.service, this.log, "expiry");
    if (await newerGrant(r, this.service, this.log)) return exchange(r, this.service, this.log, "newer");
    return "not_due";
  }
}
