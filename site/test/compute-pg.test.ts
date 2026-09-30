// PgStore against a real Postgres: a throwaway cluster (initdb + pg_ctl on a unix socket in a temp dir) when the
// Postgres binaries are installed, or COMPUTE_TEST_DATABASE_URL. Skipped (with a message) when neither is available.
// Proves the SQL, the migrations and the locking: concurrent ticks charge each minute exactly once, concurrent
// identical rents launch once, and concurrent rents from two accounts never exceed the quota.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { PgStore } from "../api/_lib/compute/pg-store.ts";
import { MIGRATIONS } from "../api/_lib/compute/migrations.ts";
import { heartbeat, state } from "../api/_lib/compute/service.ts";
import { fixtureTeam, createAccount, rent } from "./compute-helpers.ts";
import { tick } from "../api/_lib/compute/tick.ts";
import { TAG_RENTAL } from "../api/_lib/compute/driver.ts";
import { codes, fund, idem, MIN, T0, world } from "./compute-helpers.ts";

function findBin(name: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${name} || ls /opt/homebrew/opt/postgresql@17/bin/${name} /opt/homebrew/opt/postgresql@16/bin/${name} /usr/lib/postgresql/*/bin/${name} 2>/dev/null | head -1`], { encoding: "utf8" });
  const p = r.stdout.trim().split("\n")[0];
  return p ? p : null;
}

let dir: string | null = null;
let url: string | null = process.env.COMPUTE_TEST_DATABASE_URL ?? null;
let sql: postgres.Sql | null = null;
const PORT = 20_000 + Math.floor(Math.random() * 20_000);

beforeAll(() => {
  if (url) { sql = postgres(url, { max: 10, onnotice: () => {} }); return; }
  const initdb = findBin("initdb"), pgctl = findBin("pg_ctl");
  if (!initdb || !pgctl) return;
  dir = mkdtempSync(join(tmpdir(), "compute-pg-"));
  const data = join(dir, "data");
  if (spawnSync(initdb, ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { encoding: "utf8" }).status !== 0) { dir = null; return; }
  const start = spawnSync(pgctl, ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-p ${PORT} -k ${dir} -c listen_addresses=''`, "start"], { encoding: "utf8" });
  if (start.status !== 0) { dir = null; return; }
  sql = postgres({ host: dir, port: PORT, user: "postgres", database: "postgres", max: 10, onnotice: () => {} });
  url = "local";
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (dir) {
    const pgctl = findBin("pg_ctl");
    if (pgctl) spawnSync(pgctl, ["-D", join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  }
});

const TEAM = fixtureTeam;
const req = (tier: "agent" | "gpu-20", count: number, key = idem(), now = T0) => ({ idempotency_key: key, machines: [{ tier, count }], codes: codes(count, now), walkie_version: "v0.2.0-pre.7" });

describe("PgStore", () => {
  test("against real Postgres", async () => {
    if (!sql) {
      process.stderr.write("compute-pg: no Postgres binaries and no COMPUTE_TEST_DATABASE_URL; skipped\n");
      return;
    }
    const store = new PgStore(sql);
    expect(await store.migrate()).toEqual(MIGRATIONS.map(m => m.id));
    expect(await store.migrate()).toEqual([]);

    // Durable enrollment and alert claims agree across concurrent transactions.
    const { generateKeys } = await import('../../src/daemon/keys.ts');
    const { createAccount: enrollAccount } = await import('../api/_lib/compute/service.ts');
    const { ownershipMessage } = await import('../api/_lib/compute/ownership.ts');
    const { sendAlert } = await import('../api/_lib/compute/alerts.ts');
    const enrollmentWorld = world({ store });
    const { fixtureGenesis, fixtureKeys } = await import('./compute-helpers.ts');
    const team = fixtureTeam, expiry = T0 + 240_000;
    const enrollments = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => {
      const keys = i === 0 ? fixtureKeys : generateKeys();
      return enrollAccount(enrollmentWorld.d, team, { key: keys.pubkey, expires_at: expiry,
        signature: keys.sign(ownershipMessage(team, expiry)), genesis: fixtureGenesis });
    }));
    expect(enrollments.filter(r => r.status === 'fulfilled'),
      JSON.stringify(enrollments.filter(r => r.status === 'rejected').map(r => String(r.reason)))).toHaveLength(1);
    expect(await store.tx(t => t.enrollment(team))).not.toBeNull();
    let deliveries = 0;
    await Promise.all(Array.from({ length: 5 }, () => sendAlert({ store,
      env: { COMPUTE_ALERT_TELEGRAM_TOKEN: 'fixture', COMPUTE_ALERT_TELEGRAM_CHAT: 'fixture' }, now: () => T0, log: () => {},
      fetch: async () => { deliveries++; return Response.json({ ok: true }); },
    }, 'tick_stale', {})));
    expect(deliveries).toBe(1);

    // Metering under concurrency: 60 minutes of ticks, each fired 5 times at once, charge exactly 60 minutes.
    const w = world({ store, quotas: { cpu: 3, gpu: 1 } });
    const a = await createAccount(w.d, TEAM);
    await fund(store, a.account_id, 50_000_000);
    const r = (await rent(w.d, a.account_id, req("agent", 1, idem(), w.clock.now))).rentals[0]!;
    const token = /printf '%s' '([A-Za-z0-9_-]{43})'/.exec(w.cloud.provisions.find((p) => p.tags[TAG_RENTAL] === r.id)!.user_data)![1]!;
    for (let m = 0; m < 60; m++) {
      w.advance(MIN);
      await heartbeat(w.d, { rental_id: r.id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 20, egress_bytes: 0 });
      await Promise.all(Array.from({ length: 5 }, () => tick(w.d)));
    }
    const s = await state(w.d, a.account_id);
    expect(s.rentals[0]).toMatchObject({ state: "running", spent_micros: 750_000 });
    expect(s.balance_micros).toBe(50_000_000 - 750_000);

    // Idempotent rent under concurrency.
    const key = idem();
    const same = req("agent", 1, key, w.clock.now);
    const res = await Promise.all(Array.from({ length: 4 }, () => rent(w.d, a.account_id, same)));
    expect(res.filter((x) => !x.replay)).toHaveLength(1);
    expect(new Set(res.map((x) => x.rentals[0]!.id)).size).toBe(1);

    // Two accounts racing for the last CPU slot: exactly one starts, the other queues.
    const b = await createAccount(w.d, TEAM);
    await fund(store, b.account_id, 50_000_000);
    const [x, y] = await Promise.all([rent(w.d, a.account_id, req("agent", 1, idem(), w.clock.now)), rent(w.d, b.account_id, req("agent", 1, idem(), w.clock.now))]);
    expect([x.rentals[0]!.state, y.rentals[0]!.state].sort()).toEqual(["queued", "starting"]);

    // The ledger's idempotency key holds at the database.
    const dup = await store.tx((t) => t.addLedger({ account_id: a.account_id, kind: "adjustment", amount_micros: 1, idem_key: "dup-key", created_at: 1 }));
    const dup2 = await store.tx((t) => t.addLedger({ account_id: a.account_id, kind: "adjustment", amount_micros: 1, idem_key: "dup-key", created_at: 1 }));
    expect([dup, dup2]).toEqual([true, false]);

    // RENT-4: cleanup jobs survive a fresh store facade and competing enqueue transactions.
    const { enqueueCleanup, drainCleanup, hasCleanup } = await import('../api/_lib/compute/cleanup.ts');
    const orphan = w.cloud.plantOrphan({});
    await Promise.all(Array.from({ length: 5 }, () => store.tx(t => enqueueCleanup(t, 'fake', orphan))));
    const recovered = { ...w.d, store: new PgStore(sql!) };
    expect(await hasCleanup(recovered)).toBe(true);
    expect(await drainCleanup(recovered, Date.now() + 1000)).toBe(1);
    expect(w.cloud.state(orphan)).toBe('terminated');
    expect(await hasCleanup(recovered)).toBe(false);

    // The refund query excludes charges recorded after the boot window in both credit buckets.
    const refundId = 'r_eeeeeeeeeeeeeeee';
    await store.tx(async t => {
      await t.addLedger({ account_id: a.account_id, rental_id: r.id, kind: 'burn', amount_micros: -7,
        idem_key: refundId + ':early', live: true, created_at: 100 });
      await t.addLedger({ account_id: a.account_id, rental_id: r.id, kind: 'burn', amount_micros: -11,
        idem_key: refundId + ':late', live: false, created_at: 200 });
      expect(await t.rentalCharges(r.id, 150)).toEqual({ paid: 7, other: 0 });
    });
  }, 60_000);
});
