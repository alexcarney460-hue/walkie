// Alex (binding): the provider account and card exist ONLY for machines customers have paid for. A team with no PAID
// credit (nothing, test-mode Stripe credit, or free adjustments; internal and test teams included) can never make the
// real driver send a create call, through rent, the queue (tick) or start. The fetch is fake: nothing leaves the test.
import { describe, expect, test } from "bun:test";
import { applyCreditEvent } from "../api/_lib/compute/credit.ts";
import { DigitalOceanDriver, type Fetch } from "../api/_lib/compute/digitalocean.ts";
import type { ComputeDeps } from "../api/_lib/compute/deps.ts";
import { parsePrivateConfig } from "../api/_lib/compute/private-config.ts";
import { MemoryStore } from "../api/_lib/compute/memory-store.ts";
import { state } from "../api/_lib/compute/service.ts";
import { fixtureTeam, createAccount, rent, start } from "./compute-helpers.ts";
import { tick } from "../api/_lib/compute/tick.ts";
import { codes, configJson, idem, T0 } from "./compute-helpers.ts";

function doWorld() {
  const calls: { method: string; url: string }[] = [];
  let next = 1000;
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ method: init.method ?? "GET", url });
    if (init.method === "POST") return new Response(JSON.stringify({ droplet: { id: next++ } }), { status: 202 });
    return new Response(JSON.stringify({ droplets: [], links: {} }), { status: 200 });
  };
  const driver = new DigitalOceanDriver("dop_v1_" + "0".repeat(64), fetchFn);
  const clock = { now: T0 };
  const store = new MemoryStore();
  void store.tx(t => t.setControl("last_tick", T0));
  const d: ComputeDeps = {
    store, config: parsePrivateConfig(configJson({ cpu: 1, gpu: 16 }, {}, "digitalocean")),
    driver: (p) => (p === "digitalocean" ? driver : null), now: () => clock.now, siteOrigin: "https://site.test", log: () => {},
  };
  const creates = () => calls.filter((c) => c.method === "POST");
  return { d, store, clock, creates };
}

const purchase = (account: string, block: number, livemode: boolean, session = `cs_${idem()}`) => ({
  id: `evt_${idem()}`, type: "checkout.session.completed", livemode,
  data: { object: { id: session, mode: "payment", payment_status: "paid", currency: "usd", amount_total: block * 100, payment_intent: `pi_${session}`, metadata: { walkie_compute_account: account, walkie_credit_usd: String(block) } } },
});
const req = (tier: "agent" | "gpu-80", count = 1) => ({ idempotency_key: idem(), machines: [{ tier, count }], codes: codes(count), walkie_version: "v0.2.0-pre.7" });

describe("a real provider launches only against paid credit", () => {
  test("no credit, test-mode credit and free adjustments never reach a DigitalOcean create", async () => {
    const w = doWorld();
    const a = await createAccount(w.d, fixtureTeam);
    expect(await rent(w.d, a.account_id, req("agent")).catch((e) => e.code)).toBe("insufficient_credit");
    expect(await applyCreditEvent(w.d, purchase(a.account_id, 1000, false))).toBe("credited"); // Stripe TEST mode
    await w.store.tx((t) => t.addLedger({ account_id: a.account_id, kind: "adjustment", amount_micros: 500_000_000, idem_key: "free", created_at: T0 }));
    expect((await state(w.d, a.account_id)).balance_micros).toBe(1_500_000_000);
    const e = await rent(w.d, a.account_id, req("gpu-80", 3)).catch((x) => x);
    expect(e).toMatchObject({ status: 402, code: "insufficient_credit", extra: { needed_micros: 3 * 8_820_000, balance_micros: 0 } });
    expect(await rent(w.d, a.account_id, req("agent")).catch((x) => x.code)).toBe("insufficient_credit");
    for (let i = 0; i < 5; i++) { w.clock.now += 60_000; await tick(w.d); }
    expect(w.creates()).toEqual([]);
  });

  test("the queue and start refuse too once paid credit no longer covers the machine", async () => {
    const w = doWorld();
    const a = await createAccount(w.d, fixtureTeam);
    await applyCreditEvent(w.d, purchase(a.account_id, 50, true));
    const r = await rent(w.d, a.account_id, req("agent", 2)); // provider limit 1: one starts, one queues
    expect(r).toMatchObject({ started: 1, queued: 1 });
    expect(w.creates()).toHaveLength(1);
    // The paid credit is spent (e.g. a refund reversed it); only free credit remains.
    await w.store.tx(async (t) => {
      await t.addLedger({ account_id: a.account_id, kind: "burn", live: true, amount_micros: -(await t.paidBalance(a.account_id)), idem_key: "spent", created_at: T0 });
      await t.addLedger({ account_id: a.account_id, kind: "adjustment", amount_micros: 100_000_000, idem_key: "gift", created_at: T0 });
    });
    const s0 = await state(w.d, a.account_id);
    const queued = s0.rentals.find((x) => x.state === "queued")!;
    // Free the slot; the tick must not move the queued machine toward a launch, and start must refuse it.
    await w.store.tx((t) => t.updateRental(s0.rentals.find((x) => x.state === "starting")!.id, { state: "ended", ended_at: T0 }));
    await tick(w.d);
    expect((await state(w.d, a.account_id)).rentals.find((x) => x.id === queued.id)!.state).toBe("ended");
    await w.store.tx((t) => t.updateRental(queued.id, { state: "needs_code", needs_code_at: T0 }));
    expect(await start(w.d, a.account_id, queued.id, codes(1)[0]!).catch((x) => x.code)).toBe("insufficient_credit");
    expect(w.creates()).toHaveLength(1);
  });

  test("paid (livemode) credit launches: the guard is not a blanket refusal", async () => {
    const w = doWorld();
    const a = await createAccount(w.d, fixtureTeam);
    await applyCreditEvent(w.d, purchase(a.account_id, 50, true));
    const r = await rent(w.d, a.account_id, req("agent"));
    expect(r.started).toBe(1);
    expect(w.creates()).toEqual([{ method: "POST", url: "https://api.digitalocean.com/v2/droplets" }]);
  });
});
