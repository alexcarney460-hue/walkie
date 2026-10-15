// Go-live lane F: Tx.pendingFreezeHolds, the listing the tick's freeze retry reads, on MemoryStore and on a real Postgres
// (this file's own throwaway cluster from initdb + pg_ctl on a unix socket in a temp dir, its schema reset between
// tests, so no external database is ever used; the Postgres half is skipped with a message without the binaries).
// Both stores must agree: only compute-freeze-hold rows in state pending that name a charge, oldest updated_at first
// (a missing one first), ties in key order, at most `limit`. Then the whole retry on Postgres: a real held warning is
// resolved by the tick.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { applyCreditEvent, FreezeUnresolved, type StripeEvent } from "../api/_lib/compute/credit.ts";
import { MemoryStore } from "../api/_lib/compute/memory-store.ts";
import { PgStore } from "../api/_lib/compute/pg-store.ts";
import { state } from "../api/_lib/compute/service.ts";
import type { ComputeStore } from "../api/_lib/compute/store.ts";
import { tick } from "../api/_lib/compute/tick.ts";
import { createAccount, fixtureTeam, MIN, T0, world } from "./compute-helpers.ts";

function findBin(name: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${name} || ls /opt/homebrew/opt/postgresql@17/bin/${name} /opt/homebrew/opt/postgresql@16/bin/${name} /usr/lib/postgresql/*/bin/${name} 2>/dev/null | head -1`], { encoding: "utf8" });
  const p = r.stdout.trim().split("\n")[0];
  return p ? p : null;
}

let dir: string | null = null;
let sql: postgres.Sql | null = null;
const PORT = 20_000 + Math.floor(Math.random() * 20_000);

beforeAll(() => {
  const initdb = findBin("initdb"), pgctl = findBin("pg_ctl");
  if (!initdb || !pgctl) return;
  dir = mkdtempSync(join(tmpdir(), "compute-freeze-sweep-pg-"));
  const data = join(dir, "data");
  if (spawnSync(initdb, ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { encoding: "utf8" }).status !== 0) { dir = null; return; }
  const start = spawnSync(pgctl, ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-p ${PORT} -k ${dir} -c listen_addresses=''`, "start"], { encoding: "utf8" });
  if (start.status !== 0) { dir = null; return; }
  sql = postgres({ host: dir, port: PORT, user: "postgres", database: "postgres", max: 10, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (dir) {
    const pgctl = findBin("pg_ctl");
    if (pgctl) spawnSync(pgctl, ["-D", join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function pg(): Promise<PgStore | null> {
  if (!sql) {
    process.stderr.write("compute-freeze-sweep-store: no Postgres binaries (initdb, pg_ctl); Postgres half skipped\n");
    return null;
  }
  // Each test starts from an empty schema on this file's own throwaway cluster.
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  const store = new PgStore(sql);
  await store.migrate();
  return store;
}

const pending = (charge: string, updated_at?: number) => ({ charge, state: "pending", reason: "lookup_failed",
  event: "radar.early_fraud_warning.created", event_id: `evt_${charge.slice(3)}`, livemode: true, first_at: 1,
  ...(updated_at === undefined ? {} : { updated_at }), attempts: 1 });

/** Every row the listing must skip, and the pending ones in a scrambled order. */
const ROWS: readonly [string, unknown][] = [
  ["compute-freeze-hold:ch_a", pending("ch_a", 300)],
  ["compute-freeze-hold:ch_d", { ...pending("ch_d", 50), state: "resolved", payment_intent: "pi_d" }],
  ["compute-freeze-hold:ch_b", pending("ch_b", 100)],
  ["compute-freeze-hold:ch_e", { ...pending("ch_e", 40), state: "unmatched", reason: "no_payment_intent" }],
  // Keyed by event id, no charge: nothing a charge lookup can resolve.
  ["compute-freeze-hold:evt_f", { state: "pending", reason: "no_reference", event: "radar.early_fraud_warning.created",
    event_id: "evt_f", livemode: true, first_at: 1, updated_at: 10, attempts: 4 }],
  ["compute-freeze-hold:ch_c", pending("ch_c", 200)],
  ["compute-credit-hold:cs_live_g", pending("ch_g", 5)],
  ["xcompute-freeze-hold:ch_h", pending("ch_h", 1)],
  ["compute-freeze-hold:ch_i", pending("ch_i")],
  ["compute-freeze-hold:ch_j", pending("ch_j", 100)],
  // lockControl leaves a JSON null row behind for any key it locks.
  ["compute-freeze-hold:ch_k", null],
];

async function contract(store: ComputeStore): Promise<void> {
  await store.tx(async t => { for (const [key, value] of ROWS) await t.setControl(key, value); });
  const all = await store.tx(t => t.pendingFreezeHolds(20));
  expect(all.map(h => h.key)).toEqual(["ch_i", "ch_b", "ch_j", "ch_c", "ch_a"].map(c => `compute-freeze-hold:${c}`));
  expect(all[1]!.value).toEqual(pending("ch_b", 100));
  expect(all[0]!.value).toEqual(pending("ch_i"));
  expect((await store.tx(t => t.pendingFreezeHolds(2))).map(h => h.key))
    .toEqual(["compute-freeze-hold:ch_i", "compute-freeze-hold:ch_b"]);
}

describe("Tx.pendingFreezeHolds", () => {
  test("MemoryStore: pending holds with a charge, oldest updated_at first, ties by key, limited", async () => {
    await contract(new MemoryStore());
  });

  test("PgStore: the same rows in the same order", async () => {
    const store = await pg();
    if (store) await contract(store);
  });
});

describe("the tick's freeze retry on PgStore", () => {
  test("a held charge-only warning is resolved and its account frozen by the tick", async () => {
    const store = await pg();
    if (!store) return;
    const w = world({ store });
    const a = await createAccount(w.d, fixtureTeam);
    const pi = "pi_PgSweep1", charge = "ch_PgSweep1";
    const checkout: StripeEvent = { id: "evt_PgSweepCredit", type: "checkout.session.completed", livemode: true, data: { object: {
      id: "cs_live_PgSweep1", object: "checkout.session", amount_total: 5000, currency: "usd", mode: "payment", payment_intent: pi,
      payment_status: "paid", status: "complete", metadata: { walkie_compute_account: a.account_id, walkie_credit_usd: "50" } } } };
    expect(await applyCreditEvent(w.d, checkout)).toBe("credited");
    const warning: StripeEvent = { id: "evt_PgSweep1", type: "radar.early_fraud_warning.created", livemode: true,
      data: { object: { id: "issfr_PgSweep1", object: "radar.early_fraud_warning", charge, livemode: true } } };
    await expect(applyCreditEvent(w.d, warning, { paymentIntentOfCharge: async () => { throw new Error("stripe unreachable"); } }))
      .rejects.toBeInstanceOf(FreezeUnresolved);

    const calls: string[] = [];
    const charges = { paymentIntentOfCharge: async (c: string) => { calls.push(c); return c === charge ? pi : null; } };
    w.advance(MIN);
    await tick({ ...w.d, charges });
    expect(calls).toEqual([charge]);
    expect((await sql!`SELECT value FROM compute_control WHERE key = ${`compute-freeze-hold:${charge}`}`)[0]!.value)
      .toMatchObject({ state: "resolved", payment_intent: pi, attempts: 1, updated_at: T0 + MIN });
    expect((await sql!`SELECT value FROM compute_control WHERE key = ${`payment:${pi}`}`)[0]!.value)
      .toEqual({ frozen: true, event: "radar.early_fraud_warning.created" });
    expect((await state(w.d, a.account_id)).status).toBe("frozen");
    // The runbook's pending query no longer lists it, and the next tick reads nothing.
    expect(await sql!`SELECT key FROM compute_control WHERE key LIKE 'compute-freeze-hold:%' AND value->>'state' = 'pending'`).toHaveLength(0);
    w.advance(MIN);
    await tick({ ...w.d, charges });
    expect(calls).toEqual([charge]);
  });
});
