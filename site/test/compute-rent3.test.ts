import { describe, expect, test } from "bun:test";
const S = new URL("..", import.meta.url).pathname;
const { FakeCloud } = await import(`${S}/api/_lib/compute/fake-cloud.ts`);
const { MemoryStore } = await import(`${S}/api/_lib/compute/memory-store.ts`);
const { parsePrivateConfig } = await import(`${S}/api/_lib/compute/private-config.ts`);
const { rent, state, heartbeat, stop } = await import(`${S}/api/_lib/compute/service.ts`);
const { tick } = await import(`${S}/api/_lib/compute/tick.ts`);
const { applyCreditEvent } = await import(`${S}/api/_lib/compute/credit.ts`);
const { createAccount, configJson, codes, idem, T0, fixtureTeam } = await import(`${S}/test/compute-helpers.ts`);

function realWorld(quotas = { cpu: 100, gpu: 100 }, cloud = new FakeCloud()) {
  // provider name "digitalocean" => isRealProvider true; backed by FakeCloud so nothing leaves the box
  const clock = { now: T0 };
  const store = new MemoryStore();
  void store.tx((t: import("../api/_lib/compute/store.ts").Tx) => t.setControl("last_tick", T0));
  const logs: string[] = [];
  const d: any = { store, config: parsePrivateConfig(configJson(quotas, {}, "digitalocean")),
    driver: (p: string) => (p === "digitalocean" ? cloud : null), now: () => clock.now, siteOrigin: "https://site.test",
    log: (e: string) => logs.push(e) };
  return { d, store, clock, cloud, logs };
}
const purchase = (account: string, block: number, livemode: boolean) => {
  const session = `cs_${idem()}`;
  return { id: `evt_${idem()}`, type: "checkout.session.completed", livemode,
    data: { object: { id: session, mode: "payment", payment_status: "paid", currency: "usd", amount_total: block * 100, payment_intent: `pi_${session}`, metadata: { walkie_compute_account: account, walkie_credit_usd: String(block) } } } };
};
const req = (tier: string, count = 1) => ({ idempotency_key: idem(), machines: [{ tier, count }], codes: codes(count), walkie_version: "v0.2.0-pre.7" });
const hbToken = (ud: string) => /printf '%s' '([A-Za-z0-9_-]{43})' > \/etc\/walkie-rental\/heartbeat-token/.exec(ud)![1]!;

describe("RENT-3 review regressions (all providers mocked)", () => {
  test("P1: real machine stops when paid credit runs out despite other credit", async () => {
    const w = realWorld();
    const a = await createAccount(w.d, fixtureTeam);
    await applyCreditEvent(w.d, purchase(a.account_id, 1000, false)); // test-mode credit (e.g. left from the test phase)
    await applyCreditEvent(w.d, purchase(a.account_id, 50, true));    // $50 real money
    const r = await rent(w.d, a.account_id, req("gpu-80", 1));
    expect(r.started).toBe(1);
    await tick(w.d);
    const prov = w.cloud.provisions[0];
    const tok = hbToken(prov.user_data);
    const rid = r.rentals[0].id;
    for (let m = 1; m <= 600; m++) { // 10 hours, minute ticks
      w.clock.now += 60_000;
      if ((await state(w.d, a.account_id)).rentals[0].state === "ended") break;
      await heartbeat(w.d, { rental_id: rid, token: tok, busy_seats: 1, pool_jobs: 0, cpu_pct: 50, egress_bytes: 0 });
      await tick(w.d);
    }
    const s = await state(w.d, a.account_id);
    const paid = await w.store.tx((t: any) => t.paidBalance(a.account_id));
    expect(s.rentals[0].state).toBe("ended");
    expect(paid).toBeGreaterThan(-200_000);
  });

  test("P2: parallel rents cannot reuse reserved paid credit", async () => {
    const w = realWorld();
    const a = await createAccount(w.d, fixtureTeam);
    await applyCreditEvent(w.d, purchase(a.account_id, 50, true));
    const results = await Promise.allSettled([rent(w.d, a.account_id, req("gpu-80", 5)), rent(w.d, a.account_id, req("gpu-80", 5))]);

    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });

  test("P3: reconciliation preserves a rental admitted while provider listing is in flight", async () => {
    const cloud = new FakeCloud();
    const w = realWorld({ cpu: 100, gpu: 100 }, cloud);
    const a = await createAccount(w.d, fixtureTeam);
    await applyCreditEvent(w.d, purchase(a.account_id, 50, true));
    const origList = cloud.list.bind(cloud);
    let hooked = false;
    (cloud as any).list = async () => { if (!hooked) { hooked = true; await rent(w.d, a.account_id, req("agent", 1)); } return origList(); };
    await tick(w.d);
    await tick(w.d);
    expect(cloud.provisions).toHaveLength(1);
    expect(cloud.terminations.length).toBe(0);
  });

  test("P4: first-hour egress is charged above its prorated allowance", async () => {
    const w = realWorld();
    const a = await createAccount(w.d, fixtureTeam);
    await applyCreditEvent(w.d, purchase(a.account_id, 50, true));
    const r = await rent(w.d, a.account_id, req("agent", 1));
    await tick(w.d);
    const tok = hbToken(w.cloud.provisions[0].user_data); const rid = r.rentals[0].id;
    for (let m = 1; m <= 60; m++) { w.clock.now += 60_000; await heartbeat(w.d, { rental_id: rid, token: tok, busy_seats: 1, pool_jobs: 0, cpu_pct: 5, egress_bytes: Math.floor(m / 60 * 1024 * 1024 ** 3) }); await tick(w.d); }
    await stop(w.d, a.account_id, { rental_id: rid });
    const s = await state(w.d, a.account_id);
    expect(s.rentals[0].spent_micros).toBeGreaterThan(750_000);
  });

  test("P5: config refuses a tier priced below 2x cost", () => {
    const j = JSON.parse(configJson({ cpu: 1, gpu: 1 }, {}, "digitalocean"));
    j.tiers["gpu-80"].cost_per_hour_micros = 8_820_000;
    expect(() => parsePrivateConfig(JSON.stringify(j))).toThrow();
  });
});
