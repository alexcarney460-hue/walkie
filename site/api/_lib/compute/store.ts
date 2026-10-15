// Durable state for rental compute, behind one interface: MemoryStore (tests, demo) and PgStore (Neon Postgres in
// production, pg-store.ts + migrations.ts). Every read-modify-write runs inside `tx`, which serializes on the
// account row (`lockAccount`, SELECT … FOR UPDATE) and, for quota decisions, on one capacity lock. Balance is the sum
// of an append-only ledger in integer micro-dollars; every ledger row has a unique idempotency key.
import type { RentalState, StopReason, TierId } from "./types.js";

export interface Enrollment {
  readonly team_id: string;
  readonly key: string;
  readonly source: 'roster' | 'license' | 'tofu';
  readonly updated_at: number;
}

export interface Account {
  readonly id: string;
  readonly team_id: string;
  readonly token_hash: string;
  readonly classification?: "customer" | "internal" | "unverified";
  readonly authority?: string;
  readonly owner_key?: string;
  readonly status: "active" | "frozen";
  /** Set when an abuse check stopped a machine ("mining"): a person reviews before anything else happens. */
  readonly review: string | null;
  readonly created_at: number;
  /** First credited purchase, retained after the balance reaches zero. */
  readonly first_funded_at?: number | null;
}

/** `expire`: the unspent remainder of a credit lot written off at its expiry (lots.ts; Alex 2026-10-09). */
export type LedgerKind = "purchase" | "burn" | "refund" | "adjustment" | "expire";

export interface LedgerEntry {
  readonly account_id: string;
  readonly kind: LedgerKind;
  /** Positive adds credit, negative spends it. */
  readonly amount_micros: number;
  readonly idem_key: string;
  readonly rental_id?: string | null;
  /** A Stripe payment intent id for purchases (to find the account again on a dispute or refund). */
  readonly ref?: string | null;
  /** A purchase paid for real (Stripe livemode). Only such credit may launch a machine on a real provider. */
  readonly live?: boolean;
  /**
   * The credit lot a burn, refund or expire row draws on or returns to: the idem_key of the purchase or adjustment row
   * that created the lot (lots.ts). Null on lot rows themselves and on spends of credit that is in no lot.
   */
  readonly lot?: string | null;
  readonly created_at: number;
}

/** A credit lot (a positive purchase or adjustment row) with the ledger rows attributed to it (lots.ts). */
export interface CreditLotRow {
  /** The lot row's idem_key. */
  readonly id: string;
  readonly live: boolean;
  readonly amount_micros: number;
  readonly created_at: number;
  /** Sum of every row whose `lot` names this one: burns (negative), refunds (positive), expiries (negative). */
  readonly attributed_micros: number;
  /** How many expire rows name this lot. */
  readonly expire_rows: number;
}

/** What one rental's burns and refunds net to, per lot and bucket (lot null: credit that is in no lot). */
export interface RentalLotCharge { readonly lot: string | null; readonly live: boolean; readonly charged: number }

export interface RentalSafety {
  readonly cost_per_hour_micros?: number;
  readonly provider: string;
  readonly reserved: number;
  readonly claim: 'pending' | 'claimed' | 'uncertain' | 'confirmed' | 'cancelled';
  readonly key: string;
  readonly code?: string;
  readonly heartbeat_token?: string;
  readonly claimed_at?: number;
  /** First provider capacity refusal of this launch; retries stop CAPACITY_DEADLINE_MS after it (launch.ts). */
  readonly capacity_since?: number;
  /** A capacity refusal's backoff: no create before this. */
  readonly capacity_retry_at?: number;
  readonly lease_until?: number;
  /** Last confirmed provider tag deadline. Missing/old values retry on the next tick. */
  readonly tag_paid_until?: number;
  readonly tag_retry_at?: number;
  /** The customer owes nothing after this (a paid lease that expired unrenewed); later minutes are operator-funded. */
  readonly billing_until?: number;
  /** Minutes metered (at customer price) that the customer did not pay: after billing_until, or beyond its credit. */
  readonly unpaid_micros?: number;
  /** Egress beyond the allowance (at customer price) that the customer's credit did not cover. */
  readonly unpaid_egress_micros?: number;
  /** First heartbeat of the current run at or above CPU_HOT_PCT (cpu-watch.ts; alert only). */
  readonly cpu_hot_since?: number;
  /** Last `cpu_pegged` alert for this rental (at most one per 30 minutes). */
  readonly cpu_alert_at?: number;
  /** First heartbeat of the current run at or above CPU_HOT_PCT whatever the agent work (cpu-watch.ts; alert only). */
  readonly cpu_long_since?: number;
  /** Last `cpu_pegged_long` alert for this rental (at most one per 6 hours). */
  readonly cpu_long_alert_at?: number;
  readonly terminate_attempts?: number;
  readonly retry_at?: number;
  readonly alert?: string;
}
export interface Rental {
  readonly safety?: RentalSafety;
  readonly id: string;
  readonly account_id: string;
  readonly team_id: string;
  readonly tier: TierId;
  readonly name: string;
  readonly state: RentalState;
  readonly price_per_hour_micros: number;
  readonly idle_minutes: number;
  readonly created_at: number;
  /** Position within its rent request: queue order is (created_at, ord). */
  readonly ord: number;
  /** The Sqwakie release the machine installs (pinned at rent; a start may name a newer one). */
  readonly walkie_version: string;
  /** When it entered needs_code (capacity reserved, waiting for the owner's daemon to send a fresh join code). */
  readonly needs_code_at: number | null;
  /** When it began burning (provision requested). */
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly end_reason: StopReason | null;
  readonly instance_id: string | null;
  readonly heartbeat_hash: string | null;
  readonly last_heartbeat_at: number | null;
  readonly last_busy_at: number | null;
  /** First heartbeat of the current run of "GPU pegged with no Sqwakie job" (mining heuristic). */
  readonly gpu_hot_since: number | null;
  readonly egress_bytes: number;
  /** GiB of egress beyond the allowance already charged. */
  readonly egress_billed_gib: number;
  readonly node_id: string | null;
  /** Total charged so far and the started-minute count it covers. */
  readonly charged_micros: number;
  readonly billed_minutes: number;
  readonly launch_attempts: number;
}

export interface RentRequestRow {
  readonly account_id: string;
  readonly idem_key: string;
  readonly rental_ids: readonly string[];
  readonly code_index: Readonly<Record<string, number>>;
  readonly created_at: number;
}

export type RentalPatch = Partial<Omit<Rental, "id" | "account_id" | "team_id" | "tier" | "created_at" | "price_per_hour_micros">>;

export interface Tx {
  enrollment(team: string): Promise<Enrollment | null>;
  setEnrollment(value: Enrollment): Promise<void>;
  bindClaim(subscription: string): Promise<BindClaim | null>;
  bindClaimsByTeam(team: string): Promise<readonly (BindClaim & { subscription: string })[]>;
  clearBindClaim(subscription: string, hash: string): Promise<void>;
  lockControl(key: string): Promise<void>;
  /** Subscription advisory lock; take before the team bind lock. */
  lockSubscriptionBind(id: string): Promise<void>;
  /** Read-only advisory lock for license binds; also serializes with schema migrations. */
  lockLegacyBind(key: string): Promise<void>;
  /** Per-team advisory lock for migrated binds, without a control-row write. */
  lockTeamBind(key: string): Promise<void>;
  /** Check the legacy store using this transaction's connection, after lockLegacyBind. */
  legacyEmpty(): Promise<boolean>;
  control(key: string): Promise<unknown>;
  setControl(key: string, value: unknown): Promise<void>;
  /** The account, locked for the rest of the transaction; null when there is none. */
  lockAccount(id: string): Promise<Account | null>;
  /** The account without a lock (reads only: state() under a readOnly snapshot). */
  account(id: string): Promise<Account | null>;
  /** Serializes quota decisions across accounts for the rest of the transaction. */
  lockCapacity(): Promise<void>;
  accountByTokenHash(hash: string): Promise<Account | null>;
  accountByTeam(team: string, ownerKey: string): Promise<Account | null>;
  accountsByTeam(team: string): Promise<Account[]>;
  /** Read-only team account scan used while compute is disabled. */
  accountsByTeamUnlocked(team: string): Promise<Account[]>;
  insertAccount(a: Account): Promise<void>;
  setAccount(id: string, patch: Partial<Pick<Account, "status" | "review" | "token_hash" | "owner_key" | "authority" | "first_funded_at">>): Promise<void>;
  balance(accountId: string): Promise<number>;
  /**
   * Paid-eligible ledger bucket: live purchases, paid burns and their refunds.
   * A real provider launches only against this (Alex: our provider account and card exist
   * only for machines customers have paid for; no internal, test or free machines).
   */
  paidBalance(accountId: string): Promise<number>;
  rentalCharges(rentalId: string, upTo?: number): Promise<{ paid: number; other: number }>;
  /** False when a row with the same idem_key already exists (nothing written). */
  addLedger(e: LedgerEntry): Promise<boolean>;
  /** The account's credit lots in insertion order, each with the sum and expire count of the rows attributed to it. */
  creditLots(accountId: string): Promise<readonly CreditLotRow[]>;
  /** A rental's net charges (burns minus refunds) at or before `upTo`, per lot and bucket. */
  rentalLotCharges(rentalId: string, upTo: number): Promise<readonly RentalLotCharge[]>;
  /**
   * Accounts with a credit lot credited at or before `cutoff` (so expired by now) that no expire row names yet, oldest
   * such lot first (ties in account order), at most `limit`: the tick's expiry sweep (lots.ts).
   */
  dueLotAccounts(cutoff: number, limit: number): Promise<readonly string[]>;
  accountByPurchaseRef(ref: string): Promise<string | null>;
  rentRequest(accountId: string, idemKey: string): Promise<RentRequestRow | null>;
  insertRentRequest(r: RentRequestRow): Promise<void>;
  insertRental(r: Rental): Promise<void>;
  updateRental(id: string, patch: RentalPatch): Promise<void>;
  rental(id: string): Promise<Rental | null>;
  /** One account's rentals: every active one plus the most recent ended ones (newest first, then active). */
  rentals(accountId: string, endedLimit?: number): Promise<Rental[]>;
  /** Every rental in an active state, all accounts, oldest first (the queue order). */
  activeRentals(): Promise<Rental[]>;
  /** All rentals whose provisioned lifetime overlaps the day, including ended rentals. */
  rentalsSince(since: number): Promise<Rental[]>;
  /** Fixed-window rate limit: counts one hit for `key` in the window starting `windowStart`; false once over `max`. */
  hit(key: string, windowStart: number, max: number): Promise<boolean>;
  /**
   * Freezes held because Stripe could not resolve their charge yet (credit.ts: `compute-freeze-hold:<charge>`, state
   * "pending"), for the tick to retry: only holds that name a charge, oldest `updated_at` first (a missing one first, ties
   * in key order), at most `limit`. Each retry bumps `updated_at`, so a hold that keeps failing cannot starve the others.
   */
  pendingFreezeHolds(limit: number): Promise<readonly FreezeHoldRow[]>;
  /**
   * Paid checkouts held for the operator (credit.ts: `compute-credit-hold:<session>`, state "held") first held at or
   * before `before` and not yet marked `alerted_at` (alert-retry.ts), oldest numeric `first_at` first, ties in key order,
   * at most `limit`. A row without a numeric first_at is never listed.
   */
  heldCreditHolds(before: number, limit: number): Promise<readonly FreezeHoldRow[]>;
  /**
   * Confirmed alerts not delivered yet (alerts.ts: an `alert:<digest>` claim row holding an object, not a delivery
   * time) whose numeric `next_at` is at or before `now`: lowest numeric `priority` first (alerts.ts alertPriority; a row
   * without one last), then oldest numeric `first_at` (a row without one last), ties in key order, at most `limit`.
   * With `minPriority`, only rows whose numeric priority is at least it, or that have none (alert-retry.ts's reserved
   * slots for team-waiting alerts).
   */
  queuedAlerts(now: number, limit: number, minPriority?: number): Promise<readonly FreezeHoldRow[]>;
}

/** Key prefix of the freeze holds credit.ts writes (compute-freeze-hold:<charge>, or :<event id> with no charge). */
export const FREEZE_HOLD_PREFIX = "compute-freeze-hold:";
export interface FreezeHoldRow { readonly key: string; readonly value: unknown }
/** Key prefix of every alert's dedupe claim row (alerts.ts: `alert:<digest>`; a queued confirmed alert lives in its row). */
export const ALERT_CLAIM_PREFIX = "alert:";
/** Key prefix of the held paid checkouts credit.ts writes (compute-credit-hold:<session>). */
export const CREDIT_HOLD_PREFIX = "compute-credit-hold:";

/**
 * Bounds for one transaction (PgStore: SET LOCAL lock_timeout / statement_timeout; MemoryStore has no waits). A wait or
 * a statement past its bound fails the transaction, which rolls back: see isBusy.
 */
export interface TxOptions {
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  /** A read-only transaction on one snapshot (REPEATABLE READ READ ONLY): consistent reads without row locks. */
  readonly readOnly?: boolean;
}
/** A transaction refused for its lock or statement bound (Postgres lock_not_available 55P03, query_canceled 57014). */
export function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "55P03" || code === "57014";
}

export interface ComputeStore {
  tx<T>(fn: (t: Tx) => Promise<T>, opts?: TxOptions): Promise<T>;
  /** Out-of-band durable claim: survives a bind transaction rollback and is written before Stripe. */
  bindClaim?(subscription: string): Promise<BindClaim | null>;
  /** False when another attempt already owns an unsettled claim; never replace its token. */
  saveBindClaim?(subscription: string, claim: BindClaim): Promise<boolean>;
  clearBindClaim?(subscription: string, hash: string): Promise<void>;
  /** Persistent stores report the highest applied schema migration. Test stores are current by construction. */
  schemaVersion?(): Promise<number>;
  /** Only for a pre-migration read-only store: prove every public compute table has no rows. */
  legacyEmpty?(): Promise<boolean>;
}

export interface BindClaim {
  readonly team: string;
  readonly hash: string;
  readonly sealed_token: string;
  readonly authority?: string;
  readonly chain?: string;
  /** The exact Stripe bind request, persisted before it is sent. */
  readonly write?: { readonly key: string; readonly metadata: Readonly<Record<string, string>> };
}
