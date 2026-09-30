// Rental compute on this daemon (RENT-2, docs/plans/RENT-1.md §6.1): the team's compute account on the site, renting
// (one 1-hour add-machine code per machine, minted HERE by this owner node: the site has no team signing key and stores a code only until its launch claim settles), and a poller that hands fresh codes to machines leaving the site's queue and revokes each rented machine
// once its rental ends. Prices only: nothing here sees a cost (the site keeps it).
import { loadRenewToken } from "../../license/renew-token.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  ACTIVE_STATES, RENTAL_CODE_TTL_MS, type CreditBlock, type LocalComputeState, type LocalRentReq, type Quotes, type RentalView,
  type RentResult,
} from "../../protocol/compute.ts";
import { RELEASE_TAG_RE, releaseTag } from "../../protocol/add-machine.ts";
import type { TransportControl } from "../direct/link.ts";
import { HttpError } from "../http.ts";
import { mintInviteCode, type MintedInvite } from "../invite-mint.ts";
import type { Logger } from "../logger.ts";
import { VERSION } from "../version.ts";
import { loadAccount, loadAccounts, loadRentals, loadPending, savePending, newRecord, saveAccounts, saveRentals, needsAccountScan,
  markAccountsScanned, type RentalRecord, type StoredAccount } from "./files.ts";
import { invitedNodes, nodeForInvites, revokeRentedNode, type RevokeDeps } from "./nodes.ts";
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
    return { ...states[0]!, balance_micros: balance, burn_per_hour_micros: burn, hours_left: burn ? balance / burn : null,
      status: states.some(s => s.status === 'frozen') ? 'frozen' : 'active',
      rentals: this.withKnownNodes(states.flatMap(s => s.rentals)),
      accounts: states.map(s => ({ account_id: s.account_id, status: s.status, balance_micros: s.balance_micros,
        burn_per_hour_micros: s.burn_per_hour_micros, hours_left: s.hours_left })) };
  }

  /**
   * The node each rental became as the CHAIN says (the admission that used one of this daemon's invite ids for it);
   * the site's own node_id (what the rented box reported) only when the chain doesn't say yet.
   */
  private withKnownNodes(rentals: readonly RentalView[]): RentalView[] {
    const recs = loadRentals(this.home);
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
    return needsAccountScan(this.home) || loadPending(this.home).length > 0 || Object.values(loadRentals(this.home)).some((r) => !r.closed);
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
    for (const pending of loadPending(this.home)) {
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
      const nodes = invitedNodes(this.d.core);
      for (const [id, rec] of Object.entries(recs)) {
        if (rec.closed) continue;
        recs[id] = await this.settle(id, rec, byId.get(id), nodes, now);
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

  private async supplyCode(acc: StoredAccount, r: RentalView): Promise<void> {
    const handle = this.d.core.myHandle();
    if (!handle) return;
    const inv = await this.mint(handle);
    await this.record([r], { [r.id]: 0 }, [inv]);
    try {
      const res = await this.site.start(acc.token, r.id, inv.code);
      await this.record([res.rental], { [r.id]: 0 }, [inv]);
      this.d.log.info("compute_started_from_queue", { rental: r.id, invite: inv.id });
    } catch (err) {
      // The site may have moved it back to the queue meanwhile: the next round tries again with a new code.
      this.d.log.warn("compute_start_failed", { rental: r.id, err: err instanceof ComputeSiteError ? err.code : (err as Error).message });
    }
  }

  /** One record against the site's view: the node it became, and its revocation once it ended. */
  private async settle(id: string, rec: RentalRecord, site: RentalView | undefined, nodes: ReadonlyMap<string, string>, now: number): Promise<RentalRecord> {
    const state = site?.state ?? rec.state;
    const ended = state === "ended" || state === "failed" || (!site && rec.state !== "unknown");
    const node = rec.node_id ?? nodeForInvites(nodes, rec.invite_ids);
    const endedAt = ended ? (rec.ended_at ?? site?.ended_at ?? now) : null;
    let next: RentalRecord = { ...rec, state: ended && !site ? "ended" : state, node_id: node, ended_at: endedAt };
    if (!ended) return next;
    if (node && !rec.revoked) {
      const out = await revokeRentedNode(this.d, node);
      this.d.log.info("compute_node_revoked", { rental: id, node, outcome: out });
      next = { ...next, revoked: out !== "unknown_node" };
    }
    // Done once revoked; else watched until its last code can no longer be used (a late join is still revoked).
    const watchOver = endedAt !== null && now - endedAt > REVOKE_WATCH_MS;
    return next.revoked || watchOver ? { ...next, closed: true } : next;
  }
}
