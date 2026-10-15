// Automatic license renewal (docs/BUSINESS.md "Renewal"). On the roster authority only: once a day
// (with jitter) the authority checks in with the license service (`/api/license/status`, FINAL Codex 4)
// and POSTs `{lic_id, renewal_token}` to `/api/license/renew` when the chain's license expires within
// RENEW_WINDOW_MS OR the service reports a newer grant (a seat or price change made in the billing
// portal). The returned key is activated if it verifies, names this team and the same license, and the
// chain's license hasn't changed while the request was in flight (audit M7). The renewal token comes
// from the token file written at activation (renew-token.ts); without one there is no call. A token the
// released compute-locked site bound without an authority stops renewing on the token alone once the team
// has compute state: the site answers 403 invalid_renewal, and the exchange retries once with this
// authority's roster proof signed over the renew message (lane C, go-live review O P1-3). Every
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
import { rosterProof } from "../daemon/compute/team-proof.ts";

export const RENEW_WINDOW_MS = 7 * DAY_MS;
export const RENEW_EVERY_MS = DAY_MS;
/** Each wait is RENEW_EVERY_MS plus up to this much, and the first one is 1 min plus up to this much. */
export const RENEW_JITTER_MS = 60 * 60_000;
const FIRST_DELAY_MS = 60_000;
/** How long a renewal proof's signature is valid (the site accepts at most 5 minutes). */
const PROOF_TTL_MS = 240_000;

export type RenewOutcome =
  | "not_authority" | "no_license" | "not_due" | "no_token" | "renewed" | "refreshed" | "unchanged" | "superseded" | "refused"
  | "proof_refused" | "fork_open" | "failed";

/** The site paused renewal because a conflicting authority branch (a fork) awaits the operator. */
const FORK_OPEN_HINT = "the license service paused renewal: a conflicting roster authority branch was presented for this team " +
  "(a fork), and Sqwakie support must resolve it before the shared renewal token renews again. Renewal resumes by itself " +
  "once it is resolved. If this machine is the team's rightful roster authority, email support.";

/** Why a renewal signed with this machine's roster proof is still refused, and what the owner can do. */
const PROOF_REFUSED_HINT = "the license service refused the renewal even with this machine's signed roster proof: the team uses " +
  "compute, and its compute enrollment does not accept this machine as the team's roster authority yet. If this machine " +
  "is the current roster authority, start a compute credit checkout here once (paying is not required) so the enrollment " +
  "moves to it. If that checkout is refused, or the team has compute credit, the move needs a review: email support, and " +
  "renewal resumes once it is resolved. If this machine is not the current roster authority, run `walkie license refresh` " +
  "on the one that is. The renewal token may also no longer match.";

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

/** This authority's roster proof, signed for one renewal of `licId` (the site's renewMessage). */
function renewProof(core: Core, team: string, licId: string): Record<string, unknown> {
  const expires_at = core.clock() + PROOF_TTL_MS;
  return { ...rosterProof(core), expires_at,
    renew_signature: core.keys.sign(`walkie-license-renew-v1\n${team}\n${licId}\n${expires_at}`) };
}

/**
 * One renewal exchange: POST renew, verify, activate. `why` names the trigger for the log. Throws on
 * a malformed answer (the caller logs it); returns "refused" on a 4xx/5xx, "proof_refused" when the
 * retry signed with this machine's roster proof is refused as well, and "fork_open" while the site pauses
 * renewal for an unresolved authority fork.
 */
async function exchange(r: Ready, service: LicenseService, log: Logger, why: "expiry" | "newer" | "manual"): Promise<RenewOutcome> {
  const { core, lic, tok, team } = r;
  let res = await service.renew(lic.payload.lic_id, tok.token);
  if (res.status === 403 && res.body?.error === "invalid_renewal") {
    log.info("license_renew_proof_retry", { lic_id: lic.payload.lic_id, why });
    res = await service.renew(lic.payload.lic_id, tok.token, renewProof(core, team, lic.payload.lic_id));
    if (res.status === 403 && res.body?.error === "invalid_renewal") {
      log.warn("license_renew_proof_refused", { lic_id: lic.payload.lic_id, why, hint: PROOF_REFUSED_HINT });
      return "proof_refused";
    }
  }
  if (res.status === 409 && res.body?.error === "authority_fork_open") {
    log.warn("license_renew_fork_open", { lic_id: lic.payload.lic_id, why, hint: FORK_OPEN_HINT });
    return "fork_open";
  }
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
  if (outcome === "proof_refused") throw new HttpError(409, "renewal_authority_refused", PROOF_REFUSED_HINT);
  if (outcome === "fork_open") throw new HttpError(409, "authority_fork_open", FORK_OPEN_HINT);
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
