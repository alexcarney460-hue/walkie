// Go-live integration of lanes A-D (lanes/INTEGRATION.md): behaviour that needs more than one lane's code.
// - the minute tick settles queued rentals of a tier taken off sale (lane D's settleOffSale, lane A's tick), so their
//   first hour is released without waiting for the customer to stop them; in drain too (where nothing launches).
import { describe, expect, test } from "bun:test";
import { RENTED_MACHINE_RELEASES } from "../api/_lib/compute/releases.ts";
import { available } from "../api/_lib/compute/safety.ts";
import { rent as enqueue, state } from "../api/_lib/compute/service.ts";
import { tick } from "../api/_lib/compute/tick.ts";
import type { ComputeDeps } from "../api/_lib/compute/deps.ts";
import { codes, createAccount, fixtureTeam, fund, idem, world, type World } from "./compute-helpers.ts";

const USD = 1_000_000;
const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;
const agent = () => ({ idempotency_key: idem(), machines: [{ tier: "agent" as const, count: 1 }], codes: codes(1), walkie_version: RELEASE });
const offSale = (d: ComputeDeps, enabled: boolean): ComputeDeps => ({ ...d, enabled, config: { ...d.config, quotas: { cpu: 0, gpu: 0 } } });
const freeFunds = (w: World, account: string) => w.store.tx((t) => available(t, account, w.d.now()));

async function queuedBehindOne(w: World) {
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 20 * USD);
  await enqueue(w.d, a.account_id, agent());
  const queued = (await enqueue(w.d, a.account_id, agent())).rentals[0]!;
  expect(queued.state).toBe("queued");
  return { account: a.account_id, queued: queued.id, held: (await freeFunds(w, a.account_id)).total };
}

describe("the minute tick settles queued rentals of an off-sale tier", () => {
  for (const enabled of [true, false]) {
    test(`COMPUTE_ENABLED ${enabled ? "on" : "unset (drain)"}: ended unbilled, first hour released`, async () => {
      const w = world({ quotas: { cpu: 1, gpu: 0 } });
      const { account, queued, held } = await queuedBehindOne(w);
      const d = offSale(w.d, enabled);
      await tick(d);
      const r = (await state(d, account)).rentals.find((x) => x.id === queued);
      expect(r).toMatchObject({ state: "failed", end_reason: "launch_failed", spent_micros: 0 });
      // Drain launches nothing, so only the queued rental's hour comes back; enabled, the launch recheck also ends the
      // starting one (lane D), so the whole balance is free again.
      expect((await freeFunds(w, account)).total).toBe(enabled ? 20 * USD : held + 750_000);
      expect(w.logs.some((l) => l.event === "launch_off_sale" && l.fields.rental === queued)).toBe(true);
    });
  }
});

describe("lane C's licence-read failure reaches the operator as a confirmed alert (integration, lanes/C-FINAL.md round 10)", () => {
  test("alert_licence_read_failed maps to licence_read_failed, which is queued until delivered", async () => {
    const { alertFromLog, CONFIRMED_ALERTS } = await import("../api/_lib/compute/alerts.ts");
    expect(alertFromLog("alert_licence_read_failed", { team: "0123456789abcdef" })).toBe("licence_read_failed");
    expect(CONFIRMED_ALERTS.has("licence_read_failed" as never)).toBe(true);
  });
});

describe("lane C round 11's alerts reach the operator (integration)", () => {
  const TG = { COMPUTE_ALERT_TELEGRAM_TOKEN: "fixt" + "ure-bot", COMPUTE_ALERT_TELEGRAM_CHAT: "fixture-chat" };
  test("licence_bindings_overflow (one team fails closed) is a confirmed team-waiting alert", async () => {
    const { alertFromLog, alertPriority, CONFIRMED_ALERTS } = await import("../api/_lib/compute/alerts.ts");
    expect(alertFromLog("alert_licence_bindings_overflow", { team: "0123456789abcdef" })).toBe("licence_bindings_overflow");
    expect(CONFIRMED_ALERTS.has("licence_bindings_overflow" as never)).toBe(true);
    expect(alertPriority("licence_bindings_overflow" as never)).toBe(1);
  });
  test("licence_store_missing (a bind with no store) reaches Telegram with no store, deduplicated", async () => {
    const { sendAlert } = await import("../api/_lib/compute/alerts.ts");
    const delivered: string[] = [];
    const fetch = async (_: string, init?: RequestInit) => { delivered.push(String(init?.body)); return Response.json({ ok: true }); };
    const d = { store: null, env: TG, now: () => 1_796_000_000_000, log: () => {}, fetch, memory: true };
    await sendAlert(d, "licence_store_missing" as never, { team: "fedcba9876543210" });
    await sendAlert(d, "licence_store_missing" as never, { team: "fedcba9876543210" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("licence_store_missing");
  });
});
