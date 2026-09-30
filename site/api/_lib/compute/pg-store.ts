// Postgres ComputeStore (Neon via the Vercel Marketplace in production; DATABASE_URL). Uses the `postgres` driver:
// every `tx` is one BEGIN … COMMIT; `lockAccount` is SELECT … FOR UPDATE; `lockCapacity` takes a transaction-scoped
// advisory lock in a statement of its own (so later statements' snapshots see everything committed before it).
// bigint columns come back as strings from the driver: `num` converts them and refuses anything unsafe.
import postgres from "postgres";
import { MIGRATIONS } from "./migrations.js";
import type { Account, BindClaim, Enrollment, ComputeStore, LedgerEntry, Rental, RentalPatch, RentRequestRow, Tx } from "./store.js";

type Sql = postgres.Sql;
type Row = Record<string, unknown>;

const CAPACITY_LOCK = 7_318_004_211; // any fixed bigint: one advisory lock for quota decisions
const MIGRATION_LOCK = 7_318_004_212;
const BIND_CLAIM_SCHEMA_LOCK = 7_318_004_213;
const ACTIVE = ["queued", "needs_code", "starting", "running", "stopping"];

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error("non-integer numeric column");
  return n;
}
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toAccount(r: Row): Account {
  return {
    classification: r.classification as Account["classification"],
    authority: strOrNull(r.authority) ?? undefined, owner_key: strOrNull(r.owner_key) ?? undefined,
    id: r.id as string, team_id: r.team_id as string, token_hash: r.token_hash as string,
    status: r.status as Account["status"], review: strOrNull(r.review), created_at: num(r.created_at),
    first_funded_at: numOrNull(r.first_funded_at),
  };
}

function toRental(r: Row): Rental {
  return {
    safety: r.safety as Rental["safety"],
    id: r.id as string, account_id: r.account_id as string, team_id: r.team_id as string, tier: r.tier as Rental["tier"],
    name: r.name as string, state: r.state as Rental["state"], price_per_hour_micros: num(r.price_per_hour_micros),
    idle_minutes: num(r.idle_minutes), created_at: num(r.created_at), ord: num(r.ord), walkie_version: r.walkie_version as string, needs_code_at: numOrNull(r.needs_code_at),
    started_at: numOrNull(r.started_at), ended_at: numOrNull(r.ended_at), end_reason: strOrNull(r.end_reason) as Rental["end_reason"],
    instance_id: strOrNull(r.instance_id), heartbeat_hash: strOrNull(r.heartbeat_hash),
    last_heartbeat_at: numOrNull(r.last_heartbeat_at), last_busy_at: numOrNull(r.last_busy_at),
    gpu_hot_since: numOrNull(r.gpu_hot_since), egress_bytes: num(r.egress_bytes), egress_billed_gib: num(r.egress_billed_gib), node_id: strOrNull(r.node_id),
    charged_micros: num(r.charged_micros), billed_minutes: num(r.billed_minutes), launch_attempts: num(r.launch_attempts),
  };
}

/** Columns updateRental may set (a fixed allow-list: patch keys never reach SQL unchecked). */
const RENTAL_COLUMNS: ReadonlySet<string> = new Set([
  "safety", "name", "state", "idle_minutes", "needs_code_at", "started_at", "ended_at", "end_reason", "instance_id", "heartbeat_hash",
  "last_heartbeat_at", "last_busy_at", "gpu_hot_since", "egress_bytes", "egress_billed_gib", "node_id", "charged_micros", "billed_minutes", "launch_attempts",
]);

function makeTx(s: Sql): Tx {
  return {
    async bindClaim(subscription) {
      const rows = await s`SELECT team, hash, sealed_token, authority, chain,
        to_jsonb(c)->'write_request' AS write_request FROM license_bind_claims c
        WHERE subscription = ${subscription}`;
      const value = rows[0];
      return value ? { team: String(value.team), hash: String(value.hash), sealed_token: String(value.sealed_token),
        ...(value.authority ? { authority: String(value.authority), chain: String(value.chain) } : {}),
        ...(value.write_request ? { write: value.write_request as BindClaim['write'] } : {}) } : null;
    },
    async bindClaimsByTeam(team) {
      const exists = await s`SELECT to_regclass('license_bind_claims') AS relation`;
      if (!exists[0]?.relation) return [];
      const rows = await s`SELECT subscription, team, hash, sealed_token, authority, chain,
        to_jsonb(c)->'write_request' AS write_request
        FROM license_bind_claims c WHERE team = ${team} FOR UPDATE`;
      return rows.map(value => ({ subscription: String(value.subscription), team: String(value.team),
        hash: String(value.hash), sealed_token: String(value.sealed_token),
        ...(value.authority ? { authority: String(value.authority), chain: String(value.chain) } : {}),
        ...(value.write_request ? { write: value.write_request as BindClaim['write'] } : {}) }));
    },
    async clearBindClaim(subscription, hash) {
      await s`DELETE FROM license_bind_claims WHERE subscription = ${subscription} AND hash = ${hash}`;
    },
    async enrollment(team) {
      const rows = await s`SELECT * FROM compute_enrollments WHERE team_id = ${team}`;
      const r = rows[0];
      return r ? { team_id: r.team_id as string, key: r.owner_key as string, source: r.source as Enrollment['source'], updated_at: num(r.updated_at) } : null;
    },
    async setEnrollment(e) {
      await s`INSERT INTO compute_enrollments (team_id, owner_key, source, updated_at)
        VALUES (${e.team_id}, ${e.key}, ${e.source}, ${e.updated_at}) ON CONFLICT (team_id)
        DO UPDATE SET owner_key = EXCLUDED.owner_key, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at`;
    },
    async lockControl(key) {
      await s`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      await s`INSERT INTO compute_control (key, value) VALUES (${key}, 'null'::jsonb) ON CONFLICT (key) DO NOTHING`;
      await s`SELECT value FROM compute_control WHERE key = ${key} FOR UPDATE`;
    },
    async lockSubscriptionBind(id) { await s`SELECT pg_advisory_xact_lock(hashtextextended(${'license-sub:' + id}, 0))`; },
    async lockLegacyBind(key) {
      await s`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      await s`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    },
    async lockTeamBind(key) { await s`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`; },
    async legacyEmpty() { return legacyEmptyOn(s); },
    async control(key) { const rows = await s`SELECT value FROM compute_control WHERE key = ${key}`; return rows[0]?.value ?? undefined; },
    async setControl(key, value) {
      if (value == null) {
        await s`INSERT INTO compute_control (key, value) VALUES (${key}, 'null'::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      } else {
        await s`INSERT INTO compute_control (key, value) VALUES (${key}, ${s.json(value as postgres.JSONValue)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      }
    },
    async lockAccount(id) {
      const rows = await s`SELECT * FROM compute_accounts WHERE id = ${id} FOR UPDATE`;
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async lockCapacity() {
      await s`SELECT pg_advisory_xact_lock(${CAPACITY_LOCK})`;
    },
    async accountByTokenHash(hash) {
      const rows = await s`SELECT * FROM compute_accounts WHERE token_hash = ${hash}`;
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async accountByTeam(team, ownerKey) {
      const rows = await s`SELECT * FROM compute_accounts WHERE team_id = ${team} AND owner_key = ${ownerKey} ORDER BY created_at LIMIT 1`;
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async accountsByTeam(team) {
      const rows = await s`SELECT * FROM compute_accounts WHERE team_id = ${team} ORDER BY created_at, id FOR UPDATE`;
      return rows.map(toAccount);
    },
    async accountsByTeamUnlocked(team) {
      const rows = await s`SELECT * FROM compute_accounts WHERE team_id = ${team} ORDER BY created_at, id`;
      return rows.map(toAccount);
    },
    async insertAccount(a) {
      await s`INSERT INTO compute_accounts (id, team_id, token_hash, status, review, created_at, authority, owner_key, classification)
              VALUES (${a.id}, ${a.team_id}, ${a.token_hash}, ${a.status}, ${a.review}, ${a.created_at}, ${a.authority ?? null}, ${a.owner_key ?? null}, ${a.classification ?? "unverified"})`;
    },
    async setAccount(id, patch) {
      if (patch.status !== undefined) await s`UPDATE compute_accounts SET status = ${patch.status} WHERE id = ${id}`;
      if (patch.review !== undefined) await s`UPDATE compute_accounts SET review = ${patch.review} WHERE id = ${id}`;
      if (patch.token_hash !== undefined) await s`UPDATE compute_accounts SET token_hash = ${patch.token_hash} WHERE id = ${id}`;
      if (patch.owner_key !== undefined) await s`UPDATE compute_accounts SET owner_key = ${patch.owner_key} WHERE id = ${id}`;
      if (patch.authority !== undefined) await s`UPDATE compute_accounts SET authority = ${patch.authority} WHERE id = ${id}`;
      if (patch.first_funded_at != null) await s`UPDATE compute_accounts SET first_funded_at = COALESCE(first_funded_at, ${patch.first_funded_at}) WHERE id = ${id}`;
    },
    async balance(accountId) {
      const rows = await s`SELECT COALESCE(SUM(amount_micros), 0)::bigint AS b FROM compute_ledger WHERE account_id = ${accountId}`;
      return num(rows[0]?.b ?? 0);
    },
    async paidBalance(accountId) {
      const rows = await s`SELECT COALESCE(SUM(amount_micros), 0)::bigint AS b FROM compute_ledger
        WHERE account_id = ${accountId} AND live`;
      return num(rows[0]?.b ?? 0);
    },
    async rentalCharges(id, upTo = Number.MAX_SAFE_INTEGER) {
      const rows = await s`SELECT COALESCE(-SUM(amount_micros) FILTER (WHERE live), 0)::bigint AS paid,
        COALESCE(-SUM(amount_micros) FILTER (WHERE NOT live), 0)::bigint AS other FROM compute_ledger
        WHERE rental_id = ${id} AND created_at <= ${upTo} AND kind IN ('burn', 'refund')`;
      return { paid: num(rows[0]?.paid ?? 0), other: num(rows[0]?.other ?? 0) };
    },
    async addLedger(e: LedgerEntry) {
      const rows = await s`INSERT INTO compute_ledger (account_id, kind, amount_micros, idem_key, rental_id, ref, live, created_at)
        VALUES (${e.account_id}, ${e.kind}, ${e.amount_micros}, ${e.idem_key}, ${e.rental_id ?? null}, ${e.ref ?? null}, ${e.live === true}, ${e.created_at})
        ON CONFLICT (idem_key) DO NOTHING RETURNING id`;
      if (rows.length === 1 && (e.kind === 'purchase' || e.kind === 'adjustment') && e.amount_micros > 0)
        await s`UPDATE compute_accounts SET first_funded_at = COALESCE(first_funded_at, ${e.created_at}) WHERE id = ${e.account_id}`;
      return rows.length === 1;
    },
    async accountByPurchaseRef(ref) {
      const rows = await s`SELECT account_id FROM compute_ledger WHERE kind = 'purchase' AND ref = ${ref} LIMIT 1`;
      return strOrNull(rows[0]?.account_id);
    },
    async rentRequest(accountId, key) {
      const rows = await s`SELECT * FROM compute_rent_requests WHERE account_id = ${accountId} AND idem_key = ${key}`;
      const r = rows[0];
      if (!r) return null;
      return {
        account_id: r.account_id as string, idem_key: r.idem_key as string, rental_ids: r.rental_ids as string[],
        code_index: r.code_index as Record<string, number>, created_at: num(r.created_at),
      };
    },
    async insertRentRequest(r: RentRequestRow) {
      await s`INSERT INTO compute_rent_requests (account_id, idem_key, rental_ids, code_index, created_at)
              VALUES (${r.account_id}, ${r.idem_key}, ${s.json([...r.rental_ids])}, ${s.json({ ...r.code_index })}, ${r.created_at})`;
    },
    async insertRental(r: Rental) {
      await s`INSERT INTO compute_rentals ${s({ ...r, safety: s.json({ ...r.safety }) } as unknown as Record<string, unknown>)}`;
    },
    async updateRental(id, patch: RentalPatch) {
      const cols = Object.keys(patch).filter((k) => RENTAL_COLUMNS.has(k));
      if (cols.length !== Object.keys(patch).length) throw new Error("unknown rental column");
      if (!cols.length) return;
      await s`UPDATE compute_rentals SET ${s({ ...patch, ...(patch.safety ? { safety: s.json({ ...patch.safety }) } : {}) } as Record<string, unknown>, ...cols)} WHERE id = ${id}`;
    },
    async rental(id) {
      const rows = await s`SELECT * FROM compute_rentals WHERE id = ${id}`;
      return rows[0] ? toRental(rows[0]) : null;
    },
    async rentals(accountId, endedLimit = 50) {
      const active = await s`SELECT * FROM compute_rentals WHERE account_id = ${accountId} AND state IN ${s(ACTIVE)} ORDER BY created_at, ord, id`;
      const ended = endedLimit > 0
        ? await s`SELECT * FROM compute_rentals WHERE account_id = ${accountId} AND state NOT IN ${s(ACTIVE)}
                  ORDER BY ended_at DESC NULLS LAST LIMIT ${endedLimit}`
        : [];
      return [...active, ...ended].map(toRental);
    },
    async rentalsSince(since) {
      const rows = await s`SELECT * FROM compute_rentals WHERE started_at IS NOT NULL AND (ended_at IS NULL OR ended_at >= ${since})`;
      return rows.map(toRental);
    },
    async activeRentals() {
      const rows = await s`SELECT * FROM compute_rentals WHERE state IN ${s(ACTIVE)} ORDER BY created_at, ord, id`;
      return rows.map(toRental);
    },
    async hit(key, windowStart, max) {
      const rows = await s`INSERT INTO compute_rate_limits (key, window_start, hits) VALUES (${key}, ${windowStart}, 1)
        ON CONFLICT (key, window_start) DO UPDATE SET hits = compute_rate_limits.hits + 1 RETURNING hits`;
      if (Math.random() < 0.01) await s`DELETE FROM compute_rate_limits WHERE window_start < ${windowStart - 86_400_000}`;
      return num(rows[0]?.hits ?? max + 1) <= max;
    },
  };
}

export class PgStore implements ComputeStore {
  private claimTableReady: Promise<void> | null = null;
  constructor(private readonly sql: Sql) {}

  static connect(url: string): PgStore {
    // Serverless functions: few connections, no prepared statements (Neon's pooler runs in transaction mode).
    return new PgStore(postgres(url, { max: 3, prepare: false, idle_timeout: 20, connect_timeout: 8, onnotice: () => {} }));
  }

  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    return (await this.sql.begin((s) => fn(makeTx(s as unknown as Sql)))) as T;
  }

  private async ensureBindClaimTable(): Promise<void> {
    if (!this.claimTableReady) {
      this.claimTableReady = this.sql.begin(async tx => {
        const s = tx as unknown as Sql;
        await s`SELECT pg_advisory_xact_lock(${BIND_CLAIM_SCHEMA_LOCK})`;
        await s`CREATE TABLE IF NOT EXISTS license_bind_claims (
          subscription text PRIMARY KEY, team text NOT NULL, hash text NOT NULL, sealed_token text NOT NULL,
          authority text, chain text, write_request jsonb
        )`;
        await s`ALTER TABLE license_bind_claims ADD COLUMN IF NOT EXISTS write_request jsonb`;
      }).then(() => undefined);
    }
    try { await this.claimTableReady; }
    catch (err) { this.claimTableReady = null; throw err; }
  }

  async bindClaim(subscription: string): Promise<BindClaim | null> {
    await this.ensureBindClaimTable();
    const rows = await this.sql`SELECT team, hash, sealed_token, authority, chain, write_request FROM license_bind_claims
      WHERE subscription = ${subscription}`;
    const value = rows[0];
    return value ? { team: String(value.team), hash: String(value.hash), sealed_token: String(value.sealed_token),
      ...(value.authority ? { authority: String(value.authority), chain: String(value.chain) } : {}),
      ...(value.write_request ? { write: value.write_request as BindClaim['write'] } : {}) } : null;
  }

  async saveBindClaim(subscription: string, claim: BindClaim): Promise<boolean> {
    await this.ensureBindClaimTable();
    const rows = await this.sql`INSERT INTO license_bind_claims (subscription, team, hash, sealed_token, authority, chain, write_request)
      VALUES (${subscription}, ${claim.team}, ${claim.hash}, ${claim.sealed_token}, ${claim.authority ?? null}, ${claim.chain ?? null},
        ${claim.write ? this.sql.json(claim.write as postgres.JSONValue) : null})
      ON CONFLICT (subscription) DO NOTHING RETURNING subscription`;
    return rows.length === 1;
  }

  async clearBindClaim(subscription: string, hash: string): Promise<void> {
    await this.ensureBindClaimTable();
    await this.sql`DELETE FROM license_bind_claims WHERE subscription = ${subscription} AND hash = ${hash}`;
  }

  async schemaVersion(): Promise<number> {
    try {
      const rows = await this.sql`SELECT COALESCE(MAX(id), 0) AS version FROM compute_migrations`;
      return num(rows[0]?.version ?? 0);
    } catch (err) {
      if ((err as { code?: unknown })?.code === '42P01') return 0;
      throw err;
    }
  }

  async legacyEmpty(): Promise<boolean> {
    return legacyEmptyOn(this.sql);
  }

  /** Applies pending migrations (idempotent, safe to run concurrently). */
  async migrate(): Promise<number[]> {
    return (await this.sql.begin(async (tx) => {
      const s = tx as unknown as Sql;
      await s`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      await s`CREATE TABLE IF NOT EXISTS compute_migrations (id integer PRIMARY KEY, applied_at bigint NOT NULL)`;
      const done = new Set((await s`SELECT id FROM compute_migrations`).map((r) => num(r.id)));
      const applied: number[] = [];
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        await s.unsafe(m.sql);
        await s`INSERT INTO compute_migrations (id, applied_at) VALUES (${m.id}, ${Date.now()})`;
        applied.push(m.id);
      }
      return applied;
    })) as number[];
  }

  async end(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

async function legacyEmptyOn(sql: Sql): Promise<boolean> {
  const tables = await sql`
    SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND left(c.relname, 8) = 'compute_'
  `;
  for (const row of tables) {
    const name = String(row.name);
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const predicate = name === 'compute_control' ? ' WHERE value IS DISTINCT FROM \'null\'::jsonb' : '';
    const result = await sql.unsafe(`SELECT EXISTS (SELECT 1 FROM public.${quoted}${predicate} LIMIT 1) AS populated`);
    if (result[0]?.populated === true) return false;
  }
  return true;
}
