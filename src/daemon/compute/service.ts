// Rental compute on this daemon (RENT-2, docs/plans/RENT-1.md §6.1): the team's compute account on the site, renting
// (one 1-hour add-machine code per machine, minted HERE by this owner node: the site has no team signing key and stores a code only until its launch claim settles), and a poller that hands fresh codes to machines leaving the site's queue and revokes each rented machine
// once its rental ends. Prices only: nothing here sees a cost (the site keeps it).
import { loadRenewToken } from "../../license/renew-token.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  ACTIVE_STATES, RENTAL_CODE_TTL_MS, type ComputeState, type CreditBlock, type LocalComputeState, type LocalRentReq, type Quotes, type RentalView,
  type RentResult,
} from "../../protocol/compute.ts";
import { RELEASE_TAG_RE, releaseTag } from "../../protocol/add-machine.ts";
import type { TransportControl } from "../direct/link.ts";
import { HttpError } from "../http.ts";
import { mintInviteCode, type MintedInvite } from "../invite-mint.ts";
import type { Logger } from "../logger.ts";
import { submitRequest } from "../requests.ts";
import { inviteSpendsRemaining, transportFields } from "../roster.ts";
import { VERSION } from "../version.ts";
import { loadAccount, loadAccounts, loadRentals, loadPending, savePending, newRecord, saveAccounts, saveRentals, needsAccountScan,
  markAccountsScanned, RentalsFileError, type Rentals, type RentalRecord, type StoredAccount } from "./files.ts";
import { invitedNodes, nodeForInvites, revocationConfirmed, revokeRentedNode, type RevokeDeps } from "./nodes.ts";
import { ComputeSite, ComputeSiteError, type StopReply } from "./site.ts";
import { rosterProof } from './team-proof.ts';
import { verifyHandoverNotice, handoverNoticeText } from './handover-notice.ts';
import { VENDOR_PUBLIC_KEY_B64 } from '../../license/vendor-key.ts';
import { postAudit } from '../admin/audit.ts';
import { canonicalJson } from '../../protocol/canonical.ts';

export const POLL_EVERY_MS = 60_000;
export const POLL_JITTER_MS = 10_000;
export const POLL_MAX_BACKOFF_MS = 30 * 60_000;
/** An ended rental with no machine seen yet is watched this long more (its last code could still be used). */
export const REVOKE_WATCH_MS = RENTAL_CODE_TTL_MS + 10 * 60_000;
/** A revocation the authority accepted is not sent again for this long while this daemon's roster doesn't show it yet (sync is on its way). */
export const ACCEPTED_WAIT_MS = 10 * 60_000;
/** A refused revocation is asked again after 1 round, 2, 4, … up to this long (the owners' alert stays up meanwhile). */
export const REFUSED_RETRY_MAX_MS = 60 * 60_000;

export interface ComputeOptions {
  /** The site (tests inject base + fetch; production: SITE_ORIGIN or computeBaseFromEnv). */
  readonly site?: ComputeSite;
  readonly intervalMs?: number;
  readonly random?: () => number;
  /** A release tag to pin rented machines to when this build isn't a release (tests; WALKIE_COMPUTE_VERSION). */
  readonly version?: string;
  /** Test signing key; production verifies against the pinned vendor key. */
  readonly noticePublicKey?: string;
}

export interface ComputeDeps extends RevokeDeps {
  readonly log: Logger;
  readonly transport: () => TransportControl | undefined;
  /**
   * When this daemon last pulled the roster authority's whole log and was level with it (the authority itself: now), or
   * null (not since it started, or behind). A rental that never showed a machine is closed only after such a sync that
   * is later than its last usable code, so an admission this daemon has not received yet is not missed. Absent: never closed.
   */
  readonly authoritySyncedAt?: () => number | null;
}

/** What the daemon returns for a site refusal: the site's code, a plain message, its numeric details. */
function asHttp(err: unknown): never {
  if (err instanceof ComputeSiteError) {
    const status = err.status === 0 ? 502 : err.status >= 500 ? 502 : err.status;
    throw new HttpError(status, err.code, messageFor(err), err.details);
  }
  throw err;
}

function messageFor(e: ComputeSiteError): string {
  switch (e.code) {
    case "insufficient_credit": return "not enough compute credit: each machine needs its first hour covered (buy credit: walkie compute credit buy 50|200|1000)";
    case "account_frozen": return "this team's compute account is frozen (a payment was disputed or refunded); contact Walkie support";
    case "invalid_token": return "the Walkie site doesn't recognise this machine's compute account (compute-account file)";
    case "rate_limited": return "the Walkie site is rate-limiting compute requests; try again in a minute";
    case "compute_not_configured": return "rental compute isn't switched on yet on the Walkie site";
    case "site_unreachable": return e.message;
    default: return e.message;
  }
}

export class ComputeService {
  readonly site: ComputeSite;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = true;
  private polling: Promise<void> | null = null;
  /** Serializes account creation and record writes (one daemon, one file). */
  private chain: Promise<unknown> = Promise.resolve();
  /** Rentals and pending rents already refused for a lost owner role (logged once each, WALK-74). */
  private readonly refused = new Set<string>();

  constructor(private readonly d: ComputeDeps, private readonly opts: ComputeOptions = {}) {
    this.site = opts.site ?? new ComputeSite();
  }

  private get home(): string { return this.d.core.paths.home; }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The stored account for this team, created on the site the first time (the token is shown once, kept here). */
  ensureAccount(): Promise<StoredAccount> {
    return this.serial(async () => {
      const team = this.d.core.teamId;
      if (!team) throw new HttpError(409, "no_team", "not in a team yet");
      const have = loadAccount(this.home);
      if (have && have.team === team) return have;
      if (!this.d.core.isAuthority()) throw new HttpError(409, 'compute_authority_required', 'Create the compute account on the roster authority. Enrollment happens automatically.');
      const expires_at = this.d.core.clock() + 240_000;
      const renewal = loadRenewToken(this.home);
      const license = this.d.core.roster.license;
      const licenseProof = renewal && license && renewal.team === team && renewal.lic_id === license.payload.lic_id
        ? { lic_id: renewal.lic_id, renewal_token: renewal.token } : {};
      const proof = { ...licenseProof, ...rosterProof(this.d.core), key: this.d.core.keys.pubkey, expires_at,
        signature: this.d.core.keys.sign(`walkie-compute-account-v1\n${team}\n${expires_at}`) };
      const created = await this.site.createAccount(team, proof).catch(asHttp);
      const adopted = created.adopted_accounts ?? [{ account_id: created.account_id, token: created.token }];
      if (!adopted.some(a => a.account_id === created.account_id && a.token === created.token))
        throw new HttpError(502, 'bad_site_reply', 'the Walkie site returned an inconsistent account list');
      const accounts = adopted.map(a => ({ ...a, team,
        ...(created.handover_pending ? { handover_pending_until: created.handover_pending.completes_at } : {}) }));
      saveAccounts(this.home, accounts);
      const acc = accounts[0]!;
      this.d.log.info("compute_account_created", { account: acc.account_id });
      return acc;
    });
  }

  private accounts(): StoredAccount[] { return loadAccounts(this.home).filter(a => a.team === this.d.core.teamId); }

  private account(accountId?: string): StoredAccount | null {
    if (accountId && !/^ca_[0-9a-f]{16}$/.test(accountId)) throw new HttpError(400, 'invalid_account', 'invalid compute account id');
    return accountId ? this.accounts().find(a => a.account_id === accountId) ?? null : this.accounts()[0] ?? null;
  }

  quotes(): Promise<Quotes> { return this.site.quotes().catch(asHttp); }

  async objectHandover(): Promise<{ objected: true }> {
    const team = this.d.core.teamId;
    if (!team || this.d.core.me()?.role !== 'owner') throw new HttpError(403, 'forbidden', 'current owner required');
    const expires_at = this.d.core.clock() + 240_000;
    const key = this.d.core.keys.pubkey;
    const roster = rosterProof(this.d.core);
    const status = await this.site.handoverStatus(team, { key, expires_at, roster,
      signature: this.d.core.keys.sign(`walkie-compute-handover-status-v1\n${team}\n${expires_at}`) }).catch(asHttp);
    if (status.objected) return { objected: true };
    return this.site.handoverObject(team, { key, expires_at, chain_id: status.chain_id, roster,
      signature: this.d.core.keys.sign(`walkie-compute-handover-object-v1\n${team}\n${status.chain_id}\n${expires_at}`) }).catch(asHttp);
  }

  async state(): Promise<LocalComputeState> {
    const accounts = this.accounts();
    if (!accounts.length) return { account_id: null, team_id: this.d.core.teamId ?? "", status: "none", balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] };
    const ready = accounts.filter(a => !a.handover_pending_until || this.d.core.clock() >= a.handover_pending_until);
    if (!ready.length) return { account_id: null, team_id: this.d.core.teamId ?? '', status: 'none', balance_micros: 0,
      burn_per_hour_micros: 0, hours_left: null, rentals: [], handover_pending_until: accounts[0]!.handover_pending_until };
    const states = await Promise.all(ready.map(a => this.site.state(a.token).catch(asHttp)));
    const balance = states.reduce((n, s) => n + s.balance_micros, 0);
    const burn = states.reduce((n, s) => n + s.burn_per_hour_micros, 0);
    const { recs, unreadable } = this.readRecords();
    const localAlerts = this.localAlerts(recs, unreadable);
    return { ...states[0]!, balance_micros: balance, burn_per_hour_micros: burn, hours_left: burn ? balance / burn : null,
      status: states.some(s => s.status === 'frozen') ? 'frozen' : 'active',
      ...(localAlerts.length ? { alerts: [...new Set([...(states[0]!.alerts ?? []), ...localAlerts])] } : {}),
      rentals: this.withKnownNodes(states.flatMap(s => s.rentals), recs),
      accounts: states.map(s => ({ account_id: s.account_id, status: s.status, balance_micros: s.balance_micros,
        burn_per_hour_micros: s.burn_per_hour_micros, hours_left: s.hours_left })) };
  }

  /** The records for what owners are shown. An unreadable file is reported (never thrown) so state still answers; the poller refuses to run on it. */
  private readRecords(): { recs: Rentals; unreadable: boolean } {
    try { return { recs: loadRentals(this.home), unreadable: false }; } catch (err) {
      if (err instanceof RentalsFileError) return { recs: {}, unreadable: true };
      throw err;
    }
  }

  /**
   * The alerts this daemon adds to the site's, from its own records (never from the site):
   * - compute_records_unreadable: the records file can't be read, so every other alert here is unknown and revocations are paused;
   * - revocation_refused / revocation_pending: an ended rental's machine is still on the team (see RentalRecord.revoke);
   * - revocation_waiting_for_authority_sync: an ended rental that never showed a machine is past its window but this daemon has
   *   not been level with the roster authority since (no shared transport to it, or it is offline), so it stays open.
   */
  private localAlerts(recs: Rentals, unreadable: boolean): NonNullable<ComputeState["alerts"]> {
    if (unreadable) return ["compute_records_unreadable"];
    const open = Object.values(recs).filter((r) => !r.closed);
    const now = this.d.core.clock();
    const syncedAt = this.d.authoritySyncedAt?.() ?? null;
    const unseenPastWindow = open.some((r) => !r.revoke && !r.revoked && r.ended_at !== null && now > r.ended_at + REVOKE_WATCH_MS
      && !(syncedAt !== null && syncedAt > r.ended_at + REVOKE_WATCH_MS));
    return [
      ...(open.some((r) => r.revoke?.state === "refused") ? ["revocation_refused" as const] : []),
      ...(open.some((r) => r.revoke?.state === "pending") ? ["revocation_pending" as const] : []),
      ...(unseenPastWindow ? ["revocation_waiting_for_authority_sync" as const] : []),
    ];
  }

  /**
   * The node each rental became as the CHAIN says (the admission that used one of this daemon's invite ids for it);
   * the site's own node_id (what the rented box reported) only when the chain doesn't say yet.
   */
  private withKnownNodes(rentals: readonly RentalView[], recs: Rentals): RentalView[] {
    const nodes = invitedNodes(this.d.core);
    return rentals.map((r) => {
      const rec = recs[r.id];
      const known = rec ? rec.node_id ?? nodeForInvites(nodes, rec.invite_ids) : null;
      return known ? { ...r, node_id: known } : r;
    });
  }

  async credit(block: CreditBlock, accountId?: string): Promise<{ url: string }> {
    await this.ensureAccount();
    const acc = this.account(accountId);
    if (!acc) throw new HttpError(404, 'not_found', 'compute account unavailable');
    if (acc.handover_pending_until && this.d.core.clock() < acc.handover_pending_until)
      throw new HttpError(403, 'handover_pending', 'compute handover is pending; credit purchases wait until it completes');
    return this.site.credit(acc.token, block).catch(asHttp);
  }

  private pinnedVersion(): string {
    const tag = releaseTag(VERSION) ?? this.opts.version ?? process.env.WALKIE_COMPUTE_VERSION?.trim();
    if (!tag || !RELEASE_TAG_RE.test(tag)) {
      throw new HttpError(409, "dev_build", `this Walkie (${VERSION}) isn't a release, so a rented machine can't be pinned to it; update to a release (walkie update) or set WALKIE_COMPUTE_VERSION=vX.Y.Z`);
    }
    return tag;
  }

  /**
   * Rents `req.machines` for `handle` (this machine's person: the rented machines are more of their machines). One
   * 1-hour code per machine; the site starts what fits and queues the rest (their codes are dropped: a fresh one is
   * minted when each leaves the queue). A network failure retries once with the same key and codes (idempotent).
   */
  async rent(handle: string, req: LocalRentReq): Promise<RentResult> {
    const version = this.pinnedVersion();
    try { loadRentals(this.home); } catch (err) { // before anything is paid for: the new rental could not be recorded
      if (err instanceof RentalsFileError) throw new HttpError(500, 'compute_records_unreadable', err.message);
      throw err;
    }
    await this.ensureAccount();
    const acc = this.account(req.account_id);
    if (!acc) throw new HttpError(404, 'not_found', 'compute account unavailable');
    if (acc.handover_pending_until && this.d.core.clock() < acc.handover_pending_until)
      throw new HttpError(403, 'handover_pending', 'compute handover is pending; new rentals wait until it completes');
    const total = req.machines.reduce((a, m) => a + m.count, 0);
    const minted: MintedInvite[] = [];
    for (let i = 0; i < total; i++) minted.push(await this.mint(handle));
    const body = {
      idempotency_key: randomBytes(18).toString("base64url"),
      machines: req.machines, codes: minted.map((m) => m.code), walkie_version: version,
      ...(req.idle_minutes !== undefined ? { idle_minutes: req.idle_minutes } : {}),
    };
    await this.serial(async () => savePending(this.home, [...loadPending(this.home), { body, invite_ids: minted.map(m => m.id), account_id: acc.account_id }]));
    // Minting and the pending save can outlive the role (WALK-107). Re-check with no await before the site call.
    // A refusal drops this pending rent: unlike a lost answer, these codes were never sent, and must not be sent later.
    const refused = this.cannotStart();
    if (refused) {
      await this.abandonMinted(body.idempotency_key, minted, refused);
      throw new HttpError(403, "forbidden", refused);
    }
    let res: RentResult;
    try {
      res = await this.site.rent(acc.token, body);
    } catch (err) {
      if (err instanceof ComputeSiteError && err.status >= 400 && err.status < 500) {
        await this.serial(async () => savePending(this.home, loadPending(this.home).filter(p => p.body.idempotency_key !== body.idempotency_key)));
        asHttp(err);
      }
      if (!(err instanceof ComputeSiteError && err.status === 0)) asHttp(err);
      res = await this.site.rent(acc.token, body).catch(asHttp);
    }
    await this.record(res.rentals, res.code_index, minted);
    await this.serial(async () => savePending(this.home, loadPending(this.home).filter(p => p.body.idempotency_key !== body.idempotency_key)));
    this.d.log.info("compute_rented", {
      started: res.started, queued: res.queued, replay: res.replay, rentals: res.rentals.map((r) => r.id),
      invites: Object.entries(res.code_index).map(([rid, i]) => ({ rental: rid, invite: minted[i]?.id ?? null })),
    });
    this.kick();
    return res;
  }

  private mint(handle: string): Promise<MintedInvite> {
    return mintInviteCode(this.d.core, this.d.transport(), handle, "member", { ttlMs: RENTAL_CODE_TTL_MS });
  }

  private record(rentals: readonly RentalView[], codeIndex: Readonly<Record<string, number>>, minted: readonly { id: string }[]): Promise<void> {
    return this.serial(async () => {
      const recs: Record<string, RentalRecord> = { ...loadRentals(this.home) };
      const now = this.d.core.clock();
      for (const r of rentals) {
        const i = codeIndex[r.id];
        const invite = i !== undefined ? minted[i]?.id : undefined;
        const prev = recs[r.id] ?? newRecord(r.tier, [], now);
        const ids = invite && !prev.invite_ids.includes(invite) ? [...prev.invite_ids, invite].slice(-20) : prev.invite_ids;
        recs[r.id] = { ...prev, invite_ids: ids, state: r.state };
      }
      saveRentals(this.home, recs);
    });
  }

  async stop(body: { rental_id: string; account_id?: string } | { all: true; account_id?: string }): Promise<StopReply> {
    const accounts = body.account_id ? [this.account(body.account_id)].filter((a): a is StoredAccount => !!a) : this.accounts();
    if (!accounts.length) throw new HttpError(404, "not_found", "this machine hasn't rented anything (no compute account here)");
    const target = 'all' in body ? { all: true as const } : { rental_id: body.rental_id };
    let responses: StopReply[];
    if ('all' in body) responses = await Promise.all(accounts.map(a => this.site.stop(a.token, target).catch(asHttp)));
    else {
      const states = await Promise.all(accounts.map(a => this.site.state(a.token).catch(asHttp)));
      const index = states.findIndex(s => s.rentals.some(r => r.id === body.rental_id));
      if (index < 0) throw new HttpError(404, 'not_found', 'rental unavailable');
      responses = [await this.site.stop(accounts[index]!.token, target).catch(asHttp)];
    }
    const res = { stopped: responses.reduce((n, r) => n + r.stopped, 0), rentals: responses.flatMap(r => r.rentals) };
    this.d.log.info("compute_stopped", { stopped: res.stopped, rentals: res.rentals.map((r) => r.id) });
    this.kick();
    return res;
  }

  // ---- poller ------------------------------------------------------------------------------------------------

  start(): void {
    this.stopped = false;
    this.schedule(this.jitter());
  }

  stopPoller(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Poll soon (after a rent or a stop). */
  private kick(): void {
    if (!this.stopped) this.schedule(1_000);
  }

  private jitter(): number {
    return Math.floor((this.opts.random ?? Math.random)() * POLL_JITTER_MS);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.pollOnce();
      this.failures = 0;
    } catch (err) {
      this.failures++;
      this.d.log.warn("compute_poll_failed", { err: err instanceof ComputeSiteError ? err.code : (err as Error).message, failures: this.failures });
    }
    if (this.stopped) return;
    const base = this.opts.intervalMs ?? POLL_EVERY_MS;
    const wait = this.failures ? Math.min(base * 2 ** Math.min(this.failures, 10), POLL_MAX_BACKOFF_MS) : base;
    this.schedule(wait + this.jitter());
  }

  /** Whether there is anything to poll for: an account and a record that isn't closed. No network otherwise. */
  pending(): boolean {
    if (!this.account()) return false;
    if (needsAccountScan(this.home) || loadPending(this.home).length > 0) return true;
    try { return Object.values(loadRentals(this.home)).some((r) => !r.closed); } catch (err) {
      if (err instanceof RentalsFileError) return true; // needs attention
      throw err;
    }
  }

  /** One round (tests call it directly). Concurrent calls share the round in flight. */
  pollOnce(): Promise<void> {
    this.polling ??= this.round().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async round(): Promise<void> {
    await this.checkHandoverNotice();
    const accounts = this.accounts().filter(a => !a.handover_pending_until || this.d.core.clock() >= a.handover_pending_until);
    if (!accounts.length) return; // poll funded idle accounts for signed handover notices
    loadRentals(this.home); // throws on a file this version can't read: nothing below may run on it and then write it back
    if (!this.notOwner()) this.refused.clear(); // an owner again: a later loss of the role is said again
    for (const pending of loadPending(this.home)) {
      // A rent this machine's person asked for as an owner is sent again only while they still are one (WALK-74): kept,
      // not dropped, so it is recovered (same key) if the role comes back. Read again immediately before each send
      // (WALK-107): an earlier replay in this round can outlive the role. Its codes stay with the pending rent.
      const reason = this.notOwner();
      if (reason) { this.refuseOnce(`pending:${pending.body.idempotency_key}`, "compute_rent_refused", { reason }); continue; }
      try {
        const acc = this.account(pending.account_id);
        if (!acc) throw new Error('pending compute account unavailable');
        const recovered = await this.site.rent(acc.token, pending.body);
        await this.record(recovered.rentals, recovered.code_index, pending.invite_ids.map(id => ({ id })));
        await this.serial(async () => savePending(this.home, loadPending(this.home).filter(p => p.body.idempotency_key !== pending.body.idempotency_key)));
      } catch (err) {
        // A failed replay must not block settlement/revocation of other rentals.
        this.d.log.warn('compute_recovery_pending', { err: err instanceof ComputeSiteError ? err.code : 'recovery_failed' });
      }
    }
    const states = await Promise.all(accounts.map(async acc => ({ acc, state: await this.site.state(acc.token) })));
    for (const { state } of states) {
      const notice = state.handover_notice && verifyHandoverNotice(state.handover_notice, this.d.core.teamId ?? '',
        this.opts.noticePublicKey ?? VENDOR_PUBLIC_KEY_B64);
      if (!notice) continue;
      const key = `compute-handover-notice:${notice.proposed_chain}`;
      if (this.d.core.store.getMeta(key)) continue;
      if (!this.d.core.me() || !this.d.core.roster.channels.has('general')) continue;
      if (postAudit(this.d.core, handoverNoticeText(notice))) this.d.core.store.setMeta(key, '1');
    }
    for (const { acc, state } of states) for (const r of state.rentals) if (r.state === "needs_code") await this.supplyCode(acc, r);
    const rentals = states.flatMap(({ state }) => state.rentals);
    const byId = new Map(rentals.map((r) => [r.id, r]));
    await this.serial(async () => {
      const recs: Record<string, RentalRecord> = { ...loadRentals(this.home) };
      const now = this.d.core.clock();
      // Read before the chain scan: every admission the authority had at that sync is in the scan that follows.
      const syncedAt = this.d.authoritySyncedAt?.() ?? null;
      const nodes = invitedNodes(this.d.core);
      for (const [id, rec] of Object.entries(recs)) {
        if (rec.closed) continue;
        recs[id] = await this.settle(id, rec, byId.get(id), nodes, now, syncedAt);
      }
      for (const r of rentals) if (!recs[r.id] && ACTIVE_STATES.has(r.state)) recs[r.id] = { ...newRecord(r.tier, [], now), state: r.state };
      saveRentals(this.home, recs);
      if (needsAccountScan(this.home)) markAccountsScanned(this.home);
    });
  }

  private async checkHandoverNotice(): Promise<void> {
    const team = this.d.core.teamId;
    if (!team || this.d.core.me?.()?.role !== 'owner' || !this.d.core.roster.channels?.has('general')) return;
    const key = this.d.core.keys.pubkey;
    const roster = rosterProof(this.d.core);
    const expires_at = this.d.core.clock() + 240_000;
    let status: Awaited<ReturnType<ComputeSite['handoverStatus']>>;
    try {
      status = await this.site.handoverStatus(team, { key, expires_at, roster,
        signature: this.d.core.keys.sign(`walkie-compute-handover-status-v1\n${team}\n${expires_at}`) });
    } catch (err) {
      if (err instanceof ComputeSiteError && err.code === 'handover_not_found') return;
      this.d.log.warn('compute_handover_status_failed', { err: err instanceof ComputeSiteError ? err.code : 'status_failed' });
      return;
    }
    if (status.completes_at !== null) {
      const accounts = this.accounts();
      if (accounts.some(a => a.handover_pending_until && a.handover_pending_until !== status.completes_at))
        saveAccounts(this.home, accounts.map(a => a.handover_pending_until ?
          { ...a, handover_pending_until: status.completes_at! } : a));
    }
    const notice = status.notice && verifyHandoverNotice(status.notice, team,
      this.opts.noticePublicKey ?? VENDOR_PUBLIC_KEY_B64);
    if (!notice || notice.proposed_chain !== status.chain_id) return;
    const marker = `compute-handover-notice:${notice.proposed_chain}`;
    if (!this.d.core.store.getMeta(marker)) {
      if (!postAudit(this.d.core, handoverNoticeText(notice))) return;
      this.d.core.store.setMeta(marker, '1');
    }
    const received = this.d.core.store.peerNotice(handoverNoticeText({ ...notice, completes_at: null, objected: false }),
      this.d.core.keys.nodeId);
    if (!received) return;
    const notice_event_hash = createHash('sha256').update(canonicalJson(received)).digest('hex');
    try {
      await this.site.handoverAck(team, { key, expires_at, roster, chain_id: status.chain_id,
        notice_event: received, notice_event_id: received.id, notice_event_hash,
        signature: this.d.core.keys.sign(`walkie-compute-handover-ack-v2\n${team}\n${status.chain_id}\n${received.id}\n${notice_event_hash}\n${expires_at}`) });
    } catch (err) {
      this.d.log.warn('compute_handover_ack_failed', { err: err instanceof ComputeSiteError ? err.code : 'ack_failed' });
    }
  }

  /**
   * Why this machine may no longer start rented machines, or null (WALK-74): renting is an owner's, so a queued rental
   * (or a pending rent) asked for by an owner who has since been removed or made a member starts nothing.
   */
  private notOwner(): string | null {
    const me = this.d.core.me?.();
    if (!me) return "this machine is no longer an admitted member of the team, so its rentals are not started";
    return me.role === "owner" ? null : `@${me.handle} is no longer a team owner (renting compute is an owner's), so this machine's rentals are not started`;
  }

  /** The same bar as the check before a queued start's mint: not an owner, or not in the team at all (WALK-107). */
  private cannotStart(): string | null {
    return this.notOwner() ?? (this.d.core.myHandle() ? null : "this machine is not in the team");
  }

  private refuseOnce(key: string, event: string, fields: Record<string, unknown>): void {
    if (this.refused.has(key)) return;
    if (this.refused.size >= 1024) this.refused.clear();
    this.refused.add(key);
    this.d.log.warn(event, fields);
  }

  private async supplyCode(acc: StoredAccount, r: RentalView): Promise<void> {
    const refused = this.cannotStart();
    // The rental waits on the site for a code: it is left there (never started here) and said once in the log.
    if (refused) { this.refuseOnce(`rental:${r.id}`, "compute_start_refused", { rental: r.id, reason: refused }); return; }
    const handle = this.d.core.myHandle()!;
    const inv = await this.mint(handle);
    await this.record([r], { [r.id]: 0 }, [inv]);
    // The person can be removed or demoted during the mint or the record (WALK-107). Do not start, and do not leave
    // the code usable: a re-promotion within the hour would otherwise admit a machine with it.
    const again = this.cannotStart();
    if (again) {
      await this.withdrawMinted(inv.id, inv.code);
      this.refuseOnce(`rental:${r.id}`, "compute_start_refused", { rental: r.id, reason: again });
      return;
    }
    try {
      const res = await this.site.start(acc.token, r.id, inv.code);
      await this.record([res.rental], { [r.id]: 0 }, [inv]);
      this.d.log.info("compute_started_from_queue", { rental: r.id, invite: inv.id });
    } catch (err) {
      // The site may have moved it back to the queue meanwhile: the next round tries again with a new code.
      // The code is not voided here: the start may have landed and the machine may still join with it.
      this.d.log.warn("compute_start_failed", { rental: r.id, err: err instanceof ComputeSiteError ? err.code : (err as Error).message });
    }
  }

  /**
   * An interactive rent was refused after its codes were minted and the pending rent saved. Drop that pending
   * rent, refuse every code locally, and return: the caller is answered before any roster request goes out.
   * The asks then run in the background, at most as many as this demotion still allows, and stop at the first
   * `not_owner` (a pre.12 authority, or a budget this machine's roster has not caught up with).
   */
  private async abandonMinted(idempotencyKey: string, minted: readonly MintedInvite[], reason: string): Promise<void> {
    await this.serial(async () => {
      savePending(this.home, loadPending(this.home).filter((p) => p.body.idempotency_key !== idempotencyKey));
    });
    for (const inv of minted) this.d.core.retireInvite(inv.id);
    await this.stripInvites(minted.map((inv) => inv.id));
    this.d.log.warn("compute_rent_refused", { reason });
    const me = this.d.core.me();
    const left = me ? inviteSpendsRemaining(me, this.d.core.clock()) : 0;
    const batch = minted.slice(0, Number.isFinite(left) ? left : minted.length);
    if (batch.length === 0) return;
    void this.spendAbandoned(batch).catch((err: unknown) => {
      this.d.log.warn("compute_invite_spend_failed", { err: err instanceof Error ? err.message : "spend_failed" });
    });
  }

  /** Ask the authority to mark each code used. Stops at the first `not_owner` and never throws. */
  private async spendAbandoned(batch: readonly MintedInvite[]): Promise<void> {
    for (const inv of batch) {
      if (await this.spendMintedInvite(inv.id, inv.code) === "not_owner") return;
    }
  }

  /**
   * The start was refused after `id` was minted. Drop it from every rental record first (a later settle must not
   * treat this machine as the one that joined on it), remember it locally, then ask the authority to mark it used.
   * `code` goes on the request only, so the authority can check this node minted it; it is not logged.
   * A failed ask is logged and does not throw: the poller still settles the other rentals, and this daemon already
   * refuses the code. Lost-rent codes are not passed here.
   */
  private async withdrawMinted(id: string, code: string): Promise<void> {
    this.d.core.retireInvite(id);
    await this.stripInvites([id]);
    await this.spendMintedInvite(id, code);
  }

  /** Take these invite ids off every local rental record (a later settle must not treat them as a join). */
  private stripInvites(ids: readonly string[]): Promise<void> {
    const drop = new Set(ids);
    return this.serial(async () => {
      const recs: Record<string, RentalRecord> = { ...loadRentals(this.home) };
      let changed = false;
      for (const [rid, rec] of Object.entries(recs)) {
        const next = rec.invite_ids.filter((x) => !drop.has(x));
        if (next.length === rec.invite_ids.length) continue;
        recs[rid] = { ...rec, invite_ids: next };
        changed = true;
      }
      if (changed) saveRentals(this.home, recs);
    });
  }

  /**
   * Ask the authority to restate this machine's own node with `id`, which marks that invite used.
   * Never throws. `not_owner` is the authority refusing the restate (including a pre.12 authority).
   */
  private async spendMintedInvite(id: string, code: string): Promise<"ok" | "queued" | "not_owner" | "failed" | "skipped"> {
    const me = this.d.core.me();
    const n = this.d.core.roster.nodes.get(this.d.core.nodeId);
    if (!me || !n || n.revoked) return "skipped";
    const body: Record<string, unknown> = {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      ...transportFields(n), ...(n.peer_sig_v1 ? { peer_sig_v1: true } : {}), invite: id, invite_code: code,
    };
    try {
      const res = await submitRequest(this.d.core, this.d.client, this.d.catchUp, "team.node", body);
      if ("queued" in res) {
        this.d.log.info("compute_invite_spend_queued", { invite: id });
        return "queued";
      }
      this.d.log.info("compute_invite_spent", { invite: id });
      return "ok";
    } catch (err) {
      const notOwner = err instanceof HttpError && /not_owner/.test(err.message);
      this.d.log.warn("compute_invite_spend_failed", { invite: id, err: err instanceof HttpError ? err.code : "spend_failed" });
      return notOwner ? "not_owner" : "failed";
    }
  }

  /**
   * One record against the site's view: the node it became, and its revocation once it ended. The record is closed only
   * when the roster confirms the machine revoked (a revocation that is merely queued, or refused, keeps it open and is
   * tried again every round: the machine is still admitted) or, for a rental whose machine never shows up on the team, once
   * its last code can no longer be used AND this daemon has since synced with the roster authority (a daemon that was
   * asleep or cut off during the rental has not received the admission yet, and must not close the record before it does).
   */
  private async settle(id: string, rec: RentalRecord, site: RentalView | undefined, nodes: ReadonlyMap<string, string>, now: number, syncedAt: number | null): Promise<RentalRecord> {
    const state = site?.state ?? rec.state;
    const ended = state === "ended" || state === "failed" || (!site && rec.state !== "unknown");
    const node = rec.node_id ?? nodeForInvites(nodes, rec.invite_ids);
    const endedAt = ended ? (rec.ended_at ?? site?.ended_at ?? now) : null;
    let next: RentalRecord = { ...rec, state: ended && !site ? "ended" : state, node_id: node, ended_at: endedAt };
    if (!ended) return next;
    if (node && !rec.revoked) next = await this.revokeEnded(id, node, next, now);
    // A machine still admitted (queued or refused) is never given up on. One that isn't on the roster, or never joined, is
    // watched until its last code can no longer be used (a late join is still revoked), and then until this daemon has
    // synced with the authority after that moment.
    const lastCodeUsable = (endedAt ?? now) + REVOKE_WATCH_MS;
    const watchDone = now > lastCodeUsable && syncedAt !== null && syncedAt > lastCodeUsable;
    return next.revoked || (watchDone && !next.revoke) ? { ...next, closed: true } : next;
  }

  /** Asks for the ended rental's machine to be revoked and records what the roster says; see RevokeOutcome. */
  private async revokeEnded(id: string, node: string, rec: RentalRecord, now: number): Promise<RentalRecord> {
    const prev = rec.revoke;
    // Not sent again while the authority's accepted request is on its way here, or while a refusal is backing off; the
    // roster is still checked every round, so a revocation done meanwhile (by an owner) is seen at once.
    const hold = prev !== undefined && (prev.state === "refused" ? (prev.retry_at ?? 0) > now
      : prev.accepted_at !== undefined && now - prev.accepted_at < ACCEPTED_WAIT_MS);
    const { outcome, reason, accepted } = await revokeRentedNode(this.d, node, hold);
    if (outcome === "held") return rec;
    const attempts = (prev?.state === "refused" ? prev.attempts ?? 0 : 0) + 1;
    const revoke = outcome === "refused"
      ? { state: "refused" as const, reason, attempts, retry_at: now + Math.min(POLL_EVERY_MS * 2 ** (attempts - 1), REFUSED_RETRY_MAX_MS) }
      : outcome === "queued" ? { state: "pending" as const, ...(accepted ? { accepted_at: now } : {}) } : undefined;
    // Rounds repeat while it waits: log a queued or refused revocation when it first happens or changes, not every round.
    const repeat = revoke !== undefined && prev?.state === revoke.state && prev.reason === revoke.reason;
    if (!repeat) this.d.log.info("compute_node_revoked", { rental: id, node, outcome, ...(reason ? { reason } : {}) });
    if (revoke?.state === "refused") this.alertRefused(id, node, reason ?? "refused");
    const { revoke: _was, ...rest } = rec;
    return { ...rest, revoked: revocationConfirmed(outcome), ...(revoke ? { revoke } : {}) };
  }

  /** One #general line per refused rental (the owners' record of why the machine is still on the team); retried until posted. */
  private alertRefused(id: string, node: string, reason: string): void {
    const marker = `compute-revoke-refused:${id}`;
    if (this.d.core.store.getMeta(marker)) return;
    const text = `A rented machine (rental ${id}, node ${node}) is still on the team after its rental ended and could not be removed automatically: ${reason}.`;
    if (postAudit(this.d.core, text)) this.d.core.store.setMeta(marker, "1");
  }
}
