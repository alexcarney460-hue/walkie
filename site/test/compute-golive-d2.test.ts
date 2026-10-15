// Go-live lane D, round 2 (lanes/REVIEW-D-codex.md P2-2, P2-3; REVIEW-D-opus.md P3-3, P3-5, P3-8):
// - a provider that keeps refusing for capacity is retried with backoff, then the rental ends unbilled and its first
//   hour is released (it never bounces forever holding credit), and a permanent misconfiguration 422 fails fast;
// - a tier taken off sale (quota 0) closes work it had already accepted, unbilled, in every pre-launch state;
// - a stop that lands during a refused create logs what the base logged (launch_uncertain), not a requeue;
// - quotes filter by quota whenever the private config is present, even with COMPUTE_ENABLED unset.
import { describe, expect, test } from "bun:test";
import { makeQuotes } from "../api/compute/quotes.ts";
import { CAPACITY_DEADLINE_MS, CAPACITY_MAX_ATTEMPTS, launchPending, settleOffSale } from "../api/_lib/compute/launch.ts";
import { CapacityError, DriverError, type ProvisionReq } from "../api/_lib/compute/driver.ts";
import { DigitalOceanDriver } from "../api/_lib/compute/digitalocean.ts";
import { RENTED_MACHINE_RELEASES } from "../api/_lib/compute/releases.ts";
import { available } from "../api/_lib/compute/safety.ts";
import { ComputeError, rent as enqueue, start as enqueueStart, state, stop } from "../api/_lib/compute/service.ts";
import { tick, STUCK_LAUNCH_MS } from "../api/_lib/compute/tick.ts";
import type { ComputeDeps } from "../api/_lib/compute/deps.ts";
import { codes, configJson, createAccount, fixtureTeam, fund, idem, joinCode, MIN, SIZES, world, type World } from "./compute-helpers.ts";

const USD = 1_000_000;
const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;
type Tier = "agent" | "agent-xl" | "gpu-20" | "gpu-48" | "gpu-80";

const rentReq = (machines: { tier: Tier; count: number }[]) =>
  ({ idempotency_key: idem(), machines, codes: codes(machines.reduce((s, m) => s + m.count, 0)), walkie_version: RELEASE });

async function funded(w: World, micros: number): Promise<string> {
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, micros);
  return a.account_id;
}

const creates = (w: World, id: string) => w.cloud.provisions.filter((p) => p.tags["walkie:rental"] === id).length;
const alerts = (w: World, id: string) => w.logs.filter((l) => l.event === "alert_provider_unavailable" && l.fields.rental === id).length;
const offSale = (d: ComputeDeps, quotas: Record<string, number>): ComputeDeps => ({ ...d, config: { ...d.config, quotas } });
const freeFunds = (w: World, account: string) => w.store.tx((t) => available(t, account, w.d.now()));

describe("capacity refusals are retried with backoff, then the rental ends unbilled", () => {
  test("a provider that never has room: 6 creates on a 1-2-4-8-16 minute backoff, then failed, spent 0, first hour released", async () => {
    const w = world({ quotas: { cpu: 2, gpu: 0 }, cloud: { slots: { [SIZES.agent]: 0 } } });
    const account = await funded(w, 2 * USD);
    const id = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    const at: number[] = [];
    for (let minute = 0; minute <= 45; minute++) {
      const before = creates(w, id);
      await tick(w.d);
      if (creates(w, id) > before) at.push(minute);
      if (minute === 2) {
        // Backing off: still waiting, unbilled, and its first hour still held.
        expect((await state(w.d, account)).rentals[0]).toMatchObject({ id, state: "starting", spent_micros: 0 });
        expect(await enqueue(w.d, account, rentReq([{ tier: "agent-xl", count: 1 }])).catch((e: unknown) => e))
          .toMatchObject({ status: 402, code: "insufficient_credit" });
      }
      w.advance(MIN);
    }
    expect(at).toEqual([0, 1, 3, 7, 15, 31]);
    expect(at).toHaveLength(CAPACITY_MAX_ATTEMPTS);
    const r = (await state(w.d, account)).rentals.find((x) => x.id === id)!;
    expect(r).toMatchObject({ state: "failed", end_reason: "launch_failed", spent_micros: 0 });
    expect(await w.store.tx((t) => t.balance(account))).toBe(2 * USD);
    expect((await freeFunds(w, account)).total).toBe(2 * USD);
    expect(alerts(w, id)).toBe(1); // once, not on every retry
    expect(w.logs.filter((l) => l.event === "launch_capacity_exhausted" && l.fields.rental === id)).toHaveLength(1);
    // The released hour covers a new rent.
    const next = await enqueue(w.d, account, rentReq([{ tier: "agent-xl", count: 1 }]));
    expect(next.rentals[0]!.state).toBe("starting");
  });

  test("past the deadline a due retry is not sent (its join code would be near expiry): the rental ends unbilled", async () => {
    const w = world({ quotas: { cpu: 2, gpu: 0 }, cloud: { slots: { [SIZES.agent]: 0 } } });
    const account = await funded(w, 2 * USD);
    const id = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    await tick(w.d);
    expect(creates(w, id)).toBe(1);
    w.advance(CAPACITY_DEADLINE_MS);
    await w.store.tx((t) => t.setControl("last_tick", w.d.now())); // the tick was down meanwhile; it is healthy again
    await tick(w.d);
    expect(creates(w, id)).toBe(1);
    expect((await state(w.d, account)).rentals[0]).toMatchObject({ id, state: "failed", end_reason: "launch_failed", spent_micros: 0 });
    expect((await freeFunds(w, account)).total).toBe(2 * USD);
  });

  test("a customer stop while backing off ends the rental at once, unbilled", async () => {
    const w = world({ quotas: { cpu: 2, gpu: 0 }, cloud: { slots: { [SIZES.agent]: 0 } } });
    const account = await funded(w, 2 * USD);
    const id = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    await tick(w.d);
    const res = await stop(w.d, account, { rental_id: id });
    expect(res.rentals[0]).toMatchObject({ id, state: "ended", end_reason: "user", spent_micros: 0 });
    w.advance(MIN);
    await tick(w.d);
    expect(creates(w, id)).toBe(1);
  });

  test("a permanent DigitalOcean 422 (size, region or image not available) is not capacity; limits still are", async () => {
    const req: ProvisionReq = { idempotency_key: ["r_", "0123456789abcdef"].join(""), instance_type: "s-1", region: "nyc3", image: "ubuntu-24-04-x64",
      user_data: "#!/bin/bash\n", name: "rent-agent-0001", tags: {} };
    const answer = (message: string) => (async (_url: string, init?: RequestInit) => (init?.method ?? "GET") === "GET"
      ? Response.json({ droplets: [], links: {}, meta: { total: 0 } })
      : Response.json({ id: "unprocessable_entity", message }, { status: 422 })) as unknown as typeof fetch;
    for (const message of ["Size is not available in this region.", "Region is not available", "Image is not available in this region.", "The region is currently unavailable"]) {
      const err = await new DigitalOceanDriver("t".repeat(64), answer(message)).provision(req).catch((e: unknown) => e);
      expect({ message, capacity: err instanceof CapacityError, driver: err instanceof DriverError }).toEqual({ message, capacity: false, driver: true });
      expect((err as DriverError).retryable).toBe(false);
    }
    for (const message of ["creating this/these droplet(s) will exceed your droplet limit", "You have reached the GPU droplet limit", "insufficient capacity"]) {
      const err = await new DigitalOceanDriver("t".repeat(64), answer(message)).provision(req).catch((e: unknown) => e);
      expect({ message, capacity: err instanceof CapacityError }).toEqual({ message, capacity: true });
    }
  });

  test("a misconfiguration error fails fast through reconcile, with one create", async () => {
    const w = world();
    const account = await funded(w, 20 * USD);
    w.cloud.failNext = "error";
    const id = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    await tick(w.d);
    w.advance(STUCK_LAUNCH_MS);
    await tick(w.d);
    expect((await state(w.d, account)).rentals[0]).toMatchObject({ id, state: "failed", end_reason: "launch_failed", spent_micros: 0 });
    expect(creates(w, id)).toBe(1);
  });
});

describe("a stop during a refused create keeps the base behaviour's events", () => {
  test("launch_uncertain is logged; no requeue and no capacity alert", async () => {
    const w = world();
    const account = await funded(w, 20 * USD);
    const id = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    w.cloud.provision = async (req) => {
      w.cloud.provisions.push(req);
      await stop(w.d, account, { rental_id: id });
      throw new CapacityError();
    };
    await tick(w.d);
    const events = w.logs.filter((l) => l.fields.rental === id).map((l) => l.event);
    expect(events).toContain("launch_uncertain");
    expect(events).not.toContain("launch_capacity_retry");
    expect(events).not.toContain("alert_provider_unavailable");
    w.advance(STUCK_LAUNCH_MS);
    await tick(w.d);
    const r = (await state(w.d, account)).rentals[0]!;
    expect(r.spent_micros).toBe(0);
    expect(["ended", "failed"]).toContain(r.state);
    expect(creates(w, id)).toBe(1);
  });
});

describe("a tier taken off sale closes work it had already accepted, unbilled", () => {
  test("needs_code: start refuses with tier_unavailable and ends the rental, releasing its first hour", async () => {
    const w = world({ quotas: { cpu: 1, gpu: 0 } });
    const account = await funded(w, 20 * USD);
    await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]));
    const id = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    await w.store.tx((t) => t.updateRental(id, { state: "needs_code", needs_code_at: w.d.now() }));
    const closed = offSale(w.d, { cpu: 0, gpu: 0 });
    const err = await enqueueStart(closed, account, id, joinCode()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect(err).toMatchObject({ status: 409, code: "tier_unavailable" });
    const r = (await state(closed, account)).rentals.find((x) => x.id === id)!;
    expect(r).toMatchObject({ state: "failed", end_reason: "launch_failed", spent_micros: 0 });
    expect(creates(w, id)).toBe(0);
  });

  test("starting (code sent, not yet created): the launch recheck ends it before any provider call", async () => {
    const w = world({ quotas: { cpu: 2, gpu: 0 } });
    const account = await funded(w, 20 * USD);
    const id = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    const before = (await freeFunds(w, account)).total;
    const closed = offSale(w.d, { cpu: 0, gpu: 0 });
    await launchPending(closed, id);
    expect(creates(w, id)).toBe(0);
    expect((await state(closed, account)).rentals[0]).toMatchObject({ id, state: "failed", end_reason: "launch_failed", spent_micros: 0 });
    expect((await freeFunds(w, account)).total).toBe(before + 750_000);
  });

  test("starting and backing off after a capacity refusal: closed on the next pass, not after its backoff", async () => {
    const w = world({ quotas: { cpu: 2, gpu: 0 }, cloud: { slots: { [SIZES.agent]: 0 } } });
    const account = await funded(w, 20 * USD);
    const id = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    await tick(w.d); // refusal 1, then 1 minute of backoff
    await tick(w.d); // backoff to refusal 2 at minute 1 has not elapsed yet
    expect(creates(w, id)).toBe(1);
    await launchPending(offSale(w.d, { cpu: 0, gpu: 0 }), id);
    expect((await state(w.d, account)).rentals[0]).toMatchObject({ id, state: "failed", end_reason: "launch_failed", spent_micros: 0 });
    expect(creates(w, id)).toBe(1);
  });

  test("queued: the off-sale settle ends it and releases its first hour", async () => {
    const w = world({ quotas: { cpu: 1, gpu: 0 } });
    const account = await funded(w, 20 * USD);
    const first = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!.id;
    const queued = (await enqueue(w.d, account, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!;
    expect(queued.state).toBe("queued");
    const before = (await freeFunds(w, account)).total;
    const closed = offSale(w.d, { cpu: 0, gpu: 0 });
    expect(await settleOffSale(closed)).toBe(1); // the starting one is the launch recheck's
    const rs = (await state(closed, account)).rentals;
    expect(rs.find((x) => x.id === queued.id)).toMatchObject({ state: "failed", end_reason: "launch_failed", spent_micros: 0 });
    expect(rs.find((x) => x.id === first)?.state).toBe("starting");
    expect((await freeFunds(w, account)).total).toBe(before + 750_000);
    // A tier still on sale is untouched.
    expect(await settleOffSale(offSale(w.d, { cpu: 1, gpu: 0 }))).toBe(0);
  });
});

describe("quotes filter by quota whenever the private config is present", () => {
  test("COMPUTE_ENABLED unset with a config: only offered tiers, not available; without a config: the catalogue", async () => {
    const get = (env: Record<string, string>) => makeQuotes({ env, compute: () => null, stripe: () => null })(new Request("https://site.test/api/compute/quotes"))
      .then((r) => r.json() as Promise<{ available: boolean; tiers: { id: string }[] }>);
    const off = await get({ COMPUTE_PRIVATE_CONFIG: configJson({ cpu: 3, gpu: 0 }) });
    expect(off.tiers.map((t) => t.id)).toEqual(["agent", "agent-xl"]);
    expect(off.available).toBe(false);
    expect((await get({})).tiers).toHaveLength(5);
    expect((await get({ COMPUTE_PRIVATE_CONFIG: "{not json" })).tiers).toHaveLength(5);
  });
});
