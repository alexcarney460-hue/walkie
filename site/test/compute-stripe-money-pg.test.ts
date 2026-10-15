// The Stripe money holds (credit.ts) against a real Postgres: a throwaway cluster (initdb + pg_ctl on a unix socket in a
// temp dir) when the Postgres binaries are installed, or COMPUTE_TEST_DATABASE_URL. Skipped (with a message) otherwise.
// Proves a charge-only fraud warning is held as a durable row, resolved and applied on redelivery, that a paid checkout
// failing validation is held, and that the operator queries in the runbook find both.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { PgStore } from "../api/_lib/compute/pg-store.ts";
import { applyCreditEvent, FreezeUnresolved, type StripeEvent } from "../api/_lib/compute/credit.ts";
import { state } from "../api/_lib/compute/service.ts";
import { createAccount, fixtureTeam, world } from "./compute-helpers.ts";

function findBin(name: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${name} || ls /opt/homebrew/opt/postgresql@17/bin/${name} /opt/homebrew/opt/postgresql@16/bin/${name} /usr/lib/postgresql/*/bin/${name} 2>/dev/null | head -1`], { encoding: "utf8" });
  const p = r.stdout.trim().split("\n")[0];
  return p ? p : null;
}

let dir: string | null = null;
let sql: postgres.Sql | null = null;
const PORT = 20_000 + Math.floor(Math.random() * 20_000);

beforeAll(() => {
  const url = process.env.COMPUTE_TEST_DATABASE_URL;
  if (url) { sql = postgres(url, { max: 10, onnotice: () => {} }); return; }
  const initdb = findBin("initdb"), pgctl = findBin("pg_ctl");
  if (!initdb || !pgctl) return;
  dir = mkdtempSync(join(tmpdir(), "compute-money-pg-"));
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

const ev = (type: string, object: Record<string, unknown>): StripeEvent =>
  ({ id: `evt_${type.length}${Date.now()}`, type, livemode: true, api_version: "2026-08-26.dahlia", data: { object } });
const session = (account: string, pi: string, over: Record<string, unknown> = {}) => ({
  id: `cs_live_${pi.slice(3)}`, object: "checkout.session", amount_total: 5000, currency: "usd", mode: "payment", payment_intent: pi,
  payment_status: "paid", status: "complete", metadata: { walkie_compute_account: account, walkie_credit_usd: "50" }, ...over,
});

describe("Stripe money holds on PgStore", () => {
  test("a charge-only warning and an invalid paid checkout are durable rows the operator can find", async () => {
    if (!sql) {
      process.stderr.write("compute-stripe-money-pg: no Postgres binaries and no COMPUTE_TEST_DATABASE_URL; skipped\n");
      return;
    }
    const store = new PgStore(sql);
    await store.migrate();
    const w = world({ store });
    const a = await createAccount(w.d, fixtureTeam);
    const pi = "pi_PgMoney1", charge = "ch_PgMoney1";
    expect(await applyCreditEvent(w.d, ev("checkout.session.completed", session(a.account_id, pi)))).toBe("credited");

    const warning = ev("radar.early_fraud_warning.created", { id: "issfr_PgMoney1", object: "radar.early_fraud_warning", charge, livemode: true });
    const offline = { paymentIntentOfCharge: async () => { throw new Error("stripe unreachable"); } };
    await expect(applyCreditEvent(w.d, warning, offline)).rejects.toBeInstanceOf(FreezeUnresolved);
    await expect(applyCreditEvent(w.d, warning, offline)).rejects.toBeInstanceOf(FreezeUnresolved);
    const pending = await sql`SELECT key, value FROM compute_control
      WHERE key LIKE 'compute-freeze-hold:%' AND value->>'state' = 'pending'`;
    expect(pending.map(r => r.key)).toEqual([`compute-freeze-hold:${charge}`]);
    expect(pending[0]!.value).toMatchObject({ charge, attempts: 2, event: warning.type });
    expect((await state(w.d, a.account_id)).status).toBe("active");

    expect(await applyCreditEvent(w.d, warning, { paymentIntentOfCharge: async () => pi })).toBe("frozen");
    expect((await sql`SELECT value FROM compute_control WHERE key = ${`compute-freeze-hold:${charge}`}`)[0]!.value)
      .toMatchObject({ state: "resolved", payment_intent: pi, attempts: 2 });
    expect((await state(w.d, a.account_id)).status).toBe("frozen");

    const eur = session(a.account_id, "pi_PgMoney2", { currency: "eur", amount_total: 4600 });
    expect(await applyCreditEvent(w.d, ev("checkout.session.completed", eur))).toBe("ignored");
    const heldQuery = () => sql!`SELECT key, value FROM compute_control WHERE key LIKE 'compute-credit-hold:%' AND value->>'state' = 'held'`;
    const held = await heldQuery();
    expect(held.map(r => r.key)).toEqual([`compute-credit-hold:${eur.id}`]);
    expect(held[0]!.value).toMatchObject({ reason: "currency", account: a.account_id, payment_intent: "pi_PgMoney2", amount_total: 4600, deliveries: 1 });
    expect(await store.tx(t => t.balance(a.account_id))).toBe(50_000_000);

    // The operator refunds the held checkout in Stripe: the hold is marked handled and leaves the query.
    expect(await applyCreditEvent(w.d, ev("charge.refunded", { id: "ch_PgMoney2", object: "charge", payment_intent: "pi_PgMoney2" }))).toBe("frozen");
    expect(await heldQuery()).toHaveLength(0);
    expect((await sql`SELECT value FROM compute_control WHERE key = ${`compute-credit-hold:${eur.id}`}`)[0]!.value)
      .toMatchObject({ state: "refunded", freeze_event: "charge.refunded" });

    // A freeze event naming neither a payment intent nor a charge is held by its event id.
    const bare = { ...ev("charge.dispute.created", { id: "du_PgMoney3", object: "dispute" }), id: "evt_PgMoneyBare" };
    await expect(applyCreditEvent(w.d, bare)).rejects.toBeInstanceOf(FreezeUnresolved);
    expect((await sql`SELECT value FROM compute_control WHERE key = 'compute-freeze-hold:evt_PgMoneyBare'`)[0]!.value)
      .toMatchObject({ state: "pending", reason: "no_reference", attempts: 1 });
  });
});
