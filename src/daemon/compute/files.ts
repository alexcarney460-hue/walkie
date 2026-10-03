// This machine's compute files (RENT-2), both 0600 in the Walkie home, written atomically (as license-renew-token):
//   compute-account   {account_id, team, token, accounts?}: the team's compute accounts on the site. Tokens are bearer
//                     credential: it is sent to the site only, never logged, printed or put on the chain.
//   compute-rentals.json  what this daemon rented: each rental's invite chain ids (never the codes), so the machine
//                     that joined with one is known, and revoked once the rental ends.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RentalState, TierId, SiteRentReq } from "../../protocol/compute.ts";

export const COMPUTE_ACCOUNT_FILE = "compute-account";
export const COMPUTE_RENTALS_FILE = "compute-rentals.json";
/** Records kept at most (closed ones are pruned first, oldest first). */
export const MAX_RENTAL_RECORDS = 2_000;

const StoredAccount = z.object({
  account_id: z.string().regex(/^ca_[0-9a-f]{16}$/),
  team: z.string().regex(/^[0-9a-f]{16}$/),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  handover_pending_until: z.number().int().optional(),
}).strict();
export type StoredAccount = z.infer<typeof StoredAccount>;
const AccountsFile = StoredAccount.extend({ accounts: z.array(StoredAccount).min(1), needs_scan: z.boolean().optional() });

const RentalRecord = z.object({
  tier: TierId,
  /** Invite chain ids (sha256 of the secret, 32 hex) of the codes this rental was given. */
  invite_ids: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(20),
  /** The site's last-seen state, or "unknown" before the first poll. */
  state: z.union([RentalState, z.literal("unknown")]),
  created_at: z.number().int(),
  ended_at: z.number().int().nullable(),
  /** The node that joined with one of `invite_ids` (from the chain), once seen. */
  node_id: z.string().regex(/^[0-9a-f]{16}$/).nullable(),
  /** The roster shows that node revoked (confirmed). A revocation that is only queued or refused is NOT this. */
  revoked: z.boolean(),
  /**
   * While an ended rental's machine is still on the team: "pending" (the revocation is queued or not confirmed yet) or
   * "refused" (with the plain reason owners are shown). Absent once revoked, and for a rental with nothing to revoke.
   */
  revoke: z.object({
    state: z.enum(["pending", "refused"]),
    reason: z.string().max(400).optional(),
    /** "pending": when the authority accepted a request that this daemon's roster doesn't show yet (not re-sent for a while). */
    accepted_at: z.number().int().optional(),
    /** "refused": how many times it was refused, and when to ask again (backed off, up to an hour; the alert stays meanwhile). */
    attempts: z.number().int().min(1).optional(),
    retry_at: z.number().int().optional(),
  }).strict().optional(),
  /** Nothing more to do for this rental. */
  closed: z.boolean(),
}).strict();
export type RentalRecord = z.infer<typeof RentalRecord>;

const RentalsFile = z.object({ v: z.literal(1), rentals: z.record(z.string().regex(/^r_[0-9a-f]{16}$/), RentalRecord) }).strict();
export type Rentals = Readonly<Record<string, RentalRecord>>;

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function accountPath(home: string): string { return join(home, COMPUTE_ACCOUNT_FILE); }
export function rentalsPath(home: string): string { return join(home, COMPUTE_RENTALS_FILE); }

/** The stored account, or null (none, unreadable or not a valid record). */
export function loadAccount(home: string): StoredAccount | null {
  return loadAccounts(home)[0] ?? null;
}

export function saveAccount(home: string, a: StoredAccount): void {
  saveAccounts(home, [a]);
}

export function loadAccounts(home: string): StoredAccount[] {
  const raw = readJson(accountPath(home));
  const many = AccountsFile.safeParse(raw);
  if (many.success) return many.data.accounts;
  const one = StoredAccount.safeParse(raw);
  return one.success ? [one.data] : [];
}

export function saveAccounts(home: string, accounts: readonly StoredAccount[]): void {
  if (!accounts.length) throw new Error('compute accounts empty');
  const parsed = accounts.map(a => StoredAccount.parse(a));
  if (new Set(parsed.map(a => a.account_id)).size !== parsed.length || new Set(parsed.map(a => a.team)).size !== 1)
    throw new Error('compute account list invalid');
  writeAtomic(accountPath(home), JSON.stringify(AccountsFile.parse({ ...parsed[0], accounts: parsed, needs_scan: true })) + "\n");
}

export function needsAccountScan(home: string): boolean {
  const parsed = AccountsFile.safeParse(readJson(accountPath(home)));
  return parsed.success && parsed.data.needs_scan === true;
}

export function markAccountsScanned(home: string): void {
  const parsed = AccountsFile.parse(readJson(accountPath(home)));
  writeAtomic(accountPath(home), JSON.stringify({ ...parsed, needs_scan: false }) + "\n");
}

/** The rentals file is there but is not this version's format: damaged, or written by a newer Walkie. */
export class RentalsFileError extends Error {
  constructor() {
    super("compute-rentals.json can't be read (damaged, or written by a newer Walkie): it is left as it is, and no rented machine is revoked until it is fixed or moved aside");
  }
}

/**
 * The records ({} when there is no file yet). A file that is there but unreadable THROWS instead of reading as empty: the
 * poller writes the records back after every round, and an empty read would wipe the links from active rentals to their
 * machines (the same fail-closed rule as loadPending).
 */
export function loadRentals(home: string): Rentals {
  const path = rentalsPath(home);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new RentalsFileError(); }
  const p = RentalsFile.safeParse(raw);
  if (!p.success) throw new RentalsFileError();
  return p.data.rentals;
}

/** Writes the records (validated), pruning the oldest closed ones past MAX_RENTAL_RECORDS. */
export function saveRentals(home: string, rentals: Rentals): void {
  let entries = Object.entries(rentals);
  if (entries.length > MAX_RENTAL_RECORDS) {
    const closed = entries.filter(([, r]) => r.closed).sort(([, a], [, b]) => a.created_at - b.created_at);
    const drop = new Set(closed.slice(0, entries.length - MAX_RENTAL_RECORDS).map(([id]) => id));
    entries = entries.filter(([id]) => !drop.has(id));
  }
  writeAtomic(rentalsPath(home), JSON.stringify(RentalsFile.parse({ v: 1, rentals: Object.fromEntries(entries) })) + "\n");
}

export function newRecord(tier: RentalRecord["tier"], inviteIds: readonly string[], now: number): RentalRecord {
  return { tier, invite_ids: [...inviteIds], state: "unknown", created_at: now, ended_at: null, node_id: null, revoked: false, closed: false };
}

const PendingRent = z.object({ body: SiteRentReq, invite_ids: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(50),
  account_id: z.string().regex(/^ca_[0-9a-f]{16}$/).optional() }).strict();
export type PendingRent = z.infer<typeof PendingRent>;
export function loadPending(home: string): PendingRent[] {
  const path = join(home, 'compute-pending.json');
  if (!existsSync(path)) return [];
  // Corruption must not silently lose the only invite/request association.
  return z.array(PendingRent).parse(readJson(path));
}
export function savePending(home: string, pending: readonly PendingRent[]): void {
  writeAtomic(join(home, 'compute-pending.json'), JSON.stringify(z.array(PendingRent).parse(pending)) + '\n');
}
