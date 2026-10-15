// In-memory ComputeStore (tests and the demo). Transactions run one at a time and roll back on a throw, so it
// behaves like the Postgres store under SELECT … FOR UPDATE: tests of concurrency run against the same semantics.
import { ACTIVE_STATES } from "./types.js";
import { ALERT_CLAIM_PREFIX, CREDIT_HOLD_PREFIX, FREEZE_HOLD_PREFIX } from "./store.js";
import type { Account, BindClaim, CreditLotRow, Enrollment, ComputeStore, FreezeHoldRow, LedgerEntry, Rental, RentalLotCharge, RentalPatch,
  RentRequestRow, Tx, TxOptions } from "./store.js";

interface State {
  enrollments: Map<string, Enrollment>;
  accounts: Map<string, Account>;
  ledger: LedgerEntry[];
  rentals: Map<string, Rental>;
  requests: Map<string, RentRequestRow>;
  rates: Map<string, number>;
  controls: Map<string, unknown>;
}

/** A credit lot row (lots.ts): a positive purchase or adjustment. */
const isLot = (e: LedgerEntry): boolean => (e.kind === "purchase" || e.kind === "adjustment") && e.amount_micros > 0;

const queueOrder = (a: Rental, b: Rental): number => a.created_at - b.created_at || a.ord - b.ord || a.id.localeCompare(b.id);

/** A freeze hold the tick can retry: pending, and naming a charge (a hold keyed by event id has nothing to look up). */
function retryableFreezeHold(key: string, value: unknown): boolean {
  if (!key.startsWith(FREEZE_HOLD_PREFIX) || typeof value !== "object" || value === null) return false;
  const v = value as { state?: unknown; charge?: unknown };
  return v.state === "pending" && typeof v.charge === "string";
}
/** PgStore's order: numeric updated_at ascending with a missing one first, then the key by code unit (COLLATE "C"). */
function freezeHoldOrder(a: FreezeHoldRow, b: FreezeHoldRow): number {
  const at = (row: FreezeHoldRow): number => {
    const u = (row.value as { updated_at?: unknown }).updated_at;
    return typeof u === "number" ? u : -Infinity;
  };
  const ua = at(a), ub = at(b);
  if (ua !== ub) return ua < ub ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** PgStore's heldCreditHolds filter: a held checkout first held by `before`, not yet marked alerted. */
function unalertedCreditHold(key: string, value: unknown, before: number): boolean {
  if (!key.startsWith(CREDIT_HOLD_PREFIX) || typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as { state?: unknown; first_at?: unknown; alerted_at?: unknown };
  return v.state === "held" && v.alerted_at === undefined && typeof v.first_at === "number" && v.first_at <= before;
}
const firstAt = (row: FreezeHoldRow): number => (row.value as { first_at: number }).first_at;
/** PgStore's queuedAlerts filter: an alert claim row holding an object whose numeric next_at is due. */
function dueQueuedAlert(key: string, value: unknown, now: number): boolean {
  if (!key.startsWith(ALERT_CLAIM_PREFIX) || typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const next = (value as { next_at?: unknown }).next_at;
  return typeof next === "number" && next <= now;
}
/** PgStore's queuedAlerts order key: a numeric field, or after every number when it is missing (NULLS LAST). */
const numberOr = (row: FreezeHoldRow, field: "priority" | "first_at"): number => {
  const v = (row.value as Record<string, unknown>)[field];
  return typeof v === "number" ? v : Infinity;
};
/** PgStore's queuedAlerts minPriority band: a numeric priority at least the minimum, or none at all. */
const inBand = (value: unknown, minPriority: number | undefined): boolean => {
  const p = (value as Record<string, unknown>).priority;
  return minPriority === undefined || typeof p !== "number" || p >= minPriority;
};
const queuedOrder = (a: FreezeHoldRow, b: FreezeHoldRow): number =>
  numberOr(a, "priority") - numberOr(b, "priority") || numberOr(a, "first_at") - numberOr(b, "first_at") || byKey(a, b);
const byKey = (a: FreezeHoldRow, b: FreezeHoldRow): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const clone = (s: State): State => ({
  enrollments: new Map(s.enrollments), accounts: new Map(s.accounts), ledger: [...s.ledger], rentals: new Map(s.rentals),
  requests: new Map(s.requests), rates: new Map(s.rates), controls: new Map(s.controls),
});

export class MemoryStore implements ComputeStore {
  private bindClaims = new Map<string, BindClaim>();
  private state: State = { enrollments: new Map(), accounts: new Map(), ledger: [], rentals: new Map(), requests: new Map(), rates: new Map(), controls: new Map() };
  private chain: Promise<unknown> = Promise.resolve();

  /** Transactions run one at a time here, so TxOptions' bounds have nothing to bound. */
  async tx<T>(fn: (t: Tx) => Promise<T>, _opts?: TxOptions): Promise<T> {
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
    async account(id) { return s.accounts.get(id) ?? null; },
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
    async creditLots(accountId) {
      const rows = s.ledger.filter((e) => e.account_id === accountId);
      return rows.filter(isLot).map((lot): CreditLotRow => {
        const own = rows.filter((e) => e.lot === lot.idem_key);
        return { id: lot.idem_key, live: lot.live === true, amount_micros: lot.amount_micros, created_at: lot.created_at,
          attributed_micros: own.reduce((n, e) => n + e.amount_micros, 0), expire_rows: own.filter((e) => e.kind === "expire").length };
      });
    },
    async rentalLotCharges(rentalId, upTo) {
      const out = new Map<string, RentalLotCharge>();
      for (const e of s.ledger) {
        if (e.rental_id !== rentalId || e.created_at > upTo || (e.kind !== "burn" && e.kind !== "refund")) continue;
        const lot = e.lot ?? null, live = e.live === true, key = `${live}/${lot ?? ""}`;
        const prior = out.get(key);
        out.set(key, { lot, live, charged: (prior?.charged ?? 0) - e.amount_micros });
      }
      return [...out.values()];
    },
    async dueLotAccounts(cutoff, limit) {
      const expired = new Set(s.ledger.filter((e) => e.kind === "expire" && e.lot).map((e) => e.lot as string));
      const first = new Map<string, number>();
      for (const e of s.ledger) {
        if (!isLot(e) || e.created_at > cutoff || expired.has(e.idem_key)) continue;
        first.set(e.account_id, Math.min(first.get(e.account_id) ?? Infinity, e.created_at));
      }
      return [...first].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, limit).map(([id]) => id);
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
    async pendingFreezeHolds(limit) {
      return [...s.controls].filter(([key, value]) => retryableFreezeHold(key, value))
        .map(([key, value]) => ({ key, value })).sort(freezeHoldOrder).slice(0, limit);
    },
    async heldCreditHolds(before, limit) {
      return [...s.controls].filter(([key, value]) => unalertedCreditHold(key, value, before))
        .map(([key, value]) => ({ key, value }))
        .sort((a, b) => firstAt(a) - firstAt(b) || byKey(a, b)).slice(0, limit);
    },
    async queuedAlerts(now, limit, minPriority) {
      return [...s.controls].filter(([key, value]) => dueQueuedAlert(key, value, now) && inBand(value, minPriority))
        .map(([key, value]) => ({ key, value })).sort(queuedOrder).slice(0, limit);
    },
  };
}
