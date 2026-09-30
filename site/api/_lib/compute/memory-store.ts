// In-memory ComputeStore (tests and the demo). Transactions run one at a time and roll back on a throw, so it
// behaves like the Postgres store under SELECT … FOR UPDATE: tests of concurrency run against the same semantics.
import { ACTIVE_STATES } from "./types.js";
import type { Account, BindClaim, Enrollment, ComputeStore, LedgerEntry, Rental, RentalPatch, RentRequestRow, Tx } from "./store.js";

interface State {
  enrollments: Map<string, Enrollment>;
  accounts: Map<string, Account>;
  ledger: LedgerEntry[];
  rentals: Map<string, Rental>;
  requests: Map<string, RentRequestRow>;
  rates: Map<string, number>;
  controls: Map<string, unknown>;
}

/** Credit nobody paid real money for: test-mode purchases and positive adjustments. */

const queueOrder = (a: Rental, b: Rental): number => a.created_at - b.created_at || a.ord - b.ord || a.id.localeCompare(b.id);

const clone = (s: State): State => ({
  enrollments: new Map(s.enrollments), accounts: new Map(s.accounts), ledger: [...s.ledger], rentals: new Map(s.rentals),
  requests: new Map(s.requests), rates: new Map(s.rates), controls: new Map(s.controls),
});

export class MemoryStore implements ComputeStore {
  private bindClaims = new Map<string, BindClaim>();
  private state: State = { enrollments: new Map(), accounts: new Map(), ledger: [], rentals: new Map(), requests: new Map(), rates: new Map(), controls: new Map() };
  private chain: Promise<unknown> = Promise.resolve();

  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const work = clone(this.state);
      const original = new Map(this.bindClaims);
      const claims = new Map(original);
      const out = await fn(makeTx(work, claims));
      this.state = work;
      for (const [subscription, claim] of original) {
        if (!claims.has(subscription) && this.bindClaims.get(subscription)?.hash === claim.hash)
          this.bindClaims.delete(subscription);
      }
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Tests: the whole ledger. */
  ledger(): readonly LedgerEntry[] { return this.state.ledger; }
  async bindClaim(subscription: string): Promise<BindClaim | null> { return this.bindClaims.get(subscription) ?? null; }
  async saveBindClaim(subscription: string, claim: BindClaim): Promise<boolean> {
    if (this.bindClaims.has(subscription)) return false;
    this.bindClaims.set(subscription, claim);
    return true;
  }
  async clearBindClaim(subscription: string, hash: string): Promise<void> {
    if (this.bindClaims.get(subscription)?.hash === hash) this.bindClaims.delete(subscription);
  }
}

function makeTx(s: State, bindClaims: Map<string, BindClaim>): Tx {
  const rentalsOf = (accountId: string) => [...s.rentals.values()].filter((r) => r.account_id === accountId);
  return {
    async bindClaim(subscription) { return bindClaims.get(subscription) ?? null; },
    async bindClaimsByTeam(team) { return [...bindClaims].filter(([, claim]) => claim.team === team)
      .map(([subscription, claim]) => ({ ...claim, subscription })); },
    async clearBindClaim(subscription, hash) {
      if (bindClaims.get(subscription)?.hash === hash) bindClaims.delete(subscription);
    },
    async enrollment(team) { return s.enrollments.get(team) ?? null; },
    async setEnrollment(value) {
      s.enrollments.set(value.team_id, { ...value });
    },
    async lockControl() {},
    async lockSubscriptionBind() {},
    async lockLegacyBind() {},
    async lockTeamBind() {},
    async legacyEmpty() { return !s.enrollments.size && !s.accounts.size && !s.ledger.length &&
      !s.rentals.size && !s.requests.size && !s.rates.size &&
      [...s.controls.values()].every(value => value == null); },
    async control(key) { return s.controls.get(key); },
    async setControl(key, value) {
      s.controls.set(key, value);
    },
    async lockAccount(id) { return s.accounts.get(id) ?? null; },
    async lockCapacity() { /* transactions are already serial */ },
    async accountByTokenHash(hash) { return [...s.accounts.values()].find((a) => a.token_hash === hash) ?? null; },
    async accountByTeam(team, ownerKey) { return [...s.accounts.values()].find(a => a.team_id === team && a.owner_key === ownerKey) ?? null; },
    async accountsByTeam(team) { return [...s.accounts.values()].filter(a => a.team_id === team)
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)); },
    async accountsByTeamUnlocked(team) { return [...s.accounts.values()].filter(a => a.team_id === team)
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)); },
    async insertAccount(a) {
      if (s.accounts.has(a.id)) throw new Error("duplicate account");
      s.accounts.set(a.id, a);
    },
    async setAccount(id, patch) {
      const a = s.accounts.get(id);
      if (a) s.accounts.set(id, { ...a, ...patch, first_funded_at: a.first_funded_at ?? patch.first_funded_at });
    },
    async balance(accountId) {
      return s.ledger.filter((e) => e.account_id === accountId).reduce((sum, e) => sum + e.amount_micros, 0);
    },
    async paidBalance(accountId) {
      return s.ledger.filter((e) => e.account_id === accountId && e.live === true).reduce((sum, e) => sum + e.amount_micros, 0);
    },
    async rentalCharges(id, upTo = Number.MAX_SAFE_INTEGER) {
      const entries = s.ledger.filter(e => e.rental_id === id && e.created_at <= upTo && (e.kind === 'burn' || e.kind === 'refund'));
      return { paid: -entries.filter(e => e.live).reduce((n, e) => n + e.amount_micros, 0), other: -entries.filter(e => !e.live).reduce((n, e) => n + e.amount_micros, 0) };
    },
    async addLedger(e) {
      if (s.ledger.some((x) => x.idem_key === e.idem_key)) return false;
      s.ledger.push(e);
      if ((e.kind === 'purchase' || e.kind === 'adjustment') && e.amount_micros > 0) {
        const account = s.accounts.get(e.account_id);
        if (account && account.first_funded_at == null) s.accounts.set(e.account_id, { ...account, first_funded_at: e.created_at });
      }
      return true;
    },
    async accountByPurchaseRef(ref) {
      return s.ledger.find((e) => e.kind === "purchase" && e.ref === ref)?.account_id ?? null;
    },
    async rentRequest(accountId, key) { return s.requests.get(`${accountId}/${key}`) ?? null; },
    async insertRentRequest(r) { s.requests.set(`${r.account_id}/${r.idem_key}`, r); },
    async insertRental(r) {
      if (s.rentals.has(r.id)) throw new Error("duplicate rental");
      s.rentals.set(r.id, r);
    },
    async updateRental(id, patch: RentalPatch) {
      const r = s.rentals.get(id);
      if (r) s.rentals.set(id, { ...r, ...patch });
    },
    async rental(id) { return s.rentals.get(id) ?? null; },
    async rentals(accountId, endedLimit = 50) {
      const all = rentalsOf(accountId);
      const active = all.filter((r) => ACTIVE_STATES.has(r.state)).sort(queueOrder);
      const ended = all.filter((r) => !ACTIVE_STATES.has(r.state)).sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0)).slice(0, endedLimit);
      return [...active, ...ended];
    },
    async rentalsSince(since) {
      return [...s.rentals.values()].filter(r => r.started_at !== null && (r.ended_at === null || r.ended_at >= since));
    },
    async activeRentals() {
      return [...s.rentals.values()].filter((r) => ACTIVE_STATES.has(r.state)).sort(queueOrder);
    },
    async hit(key, windowStart, max) {
      const k = `${key}@${windowStart}`;
      const n = (s.rates.get(k) ?? 0) + 1;
      s.rates.set(k, n);
      return n <= max;
    },
  };
}
