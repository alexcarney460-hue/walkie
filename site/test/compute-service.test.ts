// The rental-compute control plane against MemoryStore + FakeCloud with a fixed clock: credit checks, mixed rents,
// idempotency, queueing and FIFO starts, per-minute metering (exact under doubled and concurrent ticks), stop at $0,
// idle/heartbeat/boot/mining/egress stops, orphan reconcile, frozen accounts and launch failures.
import { describe, expect, test } from "bun:test";
import { heartbeat, state, stop, ComputeError } from "../api/_lib/compute/service.ts";
import { fixtureTeam, createAccount, rent, start } from "./compute-helpers.ts";
import { tick, BOOT_TIMEOUT_MS, CODE_WAIT_MS } from "../api/_lib/compute/tick.ts";
import { TAG_MANAGED, TAG_RENTAL } from "../api/_lib/compute/driver.ts";
import { TEAM_ID } from "../api/_lib/compute/types.ts";
import { balance, codes, fund, idem, MIN, world, type World } from "./compute-helpers.ts";

const TEAM = fixtureTeam;
const USD = 1_000_000;

async function funded(w: World, micros: number): Promise<string> {
  const a = await createAccount(w.d, TEAM);
  await fund(w.store, a.account_id, micros);
  return a.account_id;
}

function rentReq(machines: { tier: "agent" | "agent-xl" | "gpu-20" | "gpu-48" | "gpu-80"; count: number }[], key = idem()) {
  const n = machines.reduce((s, m) => s + m.count, 0);
  return { idempotency_key: key, machines, codes: codes(n), walkie_version: "v0.2.0-pre.7" };
}

async function beat(w: World, rentalId: string, token: string, over: Partial<{ busy_seats: number; pool_jobs: number; gpu_pct: number; egress_bytes: number }> = {}) {
  return heartbeat(w.d, { rental_id: rentalId, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 40, egress_bytes: 0, ...over });
}

/** The heartbeat token a machine was booted with (read back from the user-data the fake provider received). */
function hbToken(w: World, rentalId: string): string {
  const p = [...w.cloud.provisions].reverse().find((x) => x.tags[TAG_RENTAL] === rentalId);
  const m = /printf '%s' '([A-Za-z0-9_-]{43})' > \/etc\/walkie-rental\/heartbeat-token/.exec(p?.user_data ?? "");
  if (!m) throw new Error("no token in user-data");
  return m[1] as string;
}

describe("accounts", () => {
  test("a new account has a 43-char token, zero balance, no rentals", async () => {
    const w = world();
    const a = await createAccount(w.d, TEAM);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const s = await state(w.d, a.account_id);
    expect(s).toMatchObject({ team_id: TEAM, status: "active", balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] });
    expect(TEAM_ID.test(s.team_id)).toBe(true);
  });
});

describe("rent", () => {
  test("credit must cover the first hour of every requested machine", async () => {
    const w = world();
    const id = await funded(w, 750_000 + 1_520_000 - 1);
    const err = await rent(w.d, id, rentReq([{ tier: "agent", count: 1 }, { tier: "gpu-20", count: 1 }])).catch((e) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credit", extra: { needed_micros: 2_270_000, balance_micros: 2_269_999 } });
    expect(w.cloud.provisions).toHaveLength(0);
  });

  test("three mixed machines start at once, each with its own code and tags; the first minute is billed", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    const req = rentReq([{ tier: "agent", count: 2 }, { tier: "gpu-20", count: 1 }]);
    const res = await rent(w.d, id, req);
    expect(res).toMatchObject({ started: 3, queued: 0, replay: false });
    expect(res.rentals.map((r) => [r.tier, r.state])).toEqual([["agent", "starting"], ["agent", "starting"], ["gpu-20", "starting"]]);
    expect(w.cloud.provisions.map((p) => [p.instance_type, p.region])).toEqual([["g-8vcpu-32gb", "nyc3"], ["g-8vcpu-32gb", "nyc3"], ["gpu-4000adax1-20gb", "tor1"]]);
    for (const [i, p] of w.cloud.provisions.entries()) {
      const rid = res.rentals[i]!.id;
      expect(p.tags).toMatchObject({ [TAG_MANAGED]: "1", [TAG_RENTAL]: rid, "walkie:team": TEAM, "walkie:account": id });
      expect(res.code_index[rid]).toBe(i);
      expect(p.user_data).toContain(`--invite ${req.codes[i]} --allow-team-agents --seat-users`);
      expect(p.user_data).toContain("WALKIE_VERSION=v0.2.0-pre.7");
    }
    // CPU: first minute, 750000/60 = 12500 each; GPU: 5-minute minimum, 1520000*5/60 = 126666.67 → 126667
    expect(res.balance_micros).toBe(50 * USD - 12_500 - 12_500 - 126_667);
  });

  test("the same idempotency key answers the first result again and launches nothing new", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    const req = rentReq([{ tier: "agent", count: 1 }]);
    const a = await rent(w.d, id, req);
    const b = await rent(w.d, id, { ...req, codes: codes(1) });
    expect(b.replay).toBe(true);
    expect(b.rentals.map((r) => r.id)).toEqual(a.rentals.map((r) => r.id));
    expect(b.code_index).toEqual(a.code_index);
    expect(w.cloud.provisions).toHaveLength(1);
  });

  test("concurrent identical requests launch once", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    const req = rentReq([{ tier: "agent", count: 2 }]);
    const results = await Promise.all(Array.from({ length: 5 }, () => rent(w.d, id, req)));
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(w.cloud.provisions).toHaveLength(2);
  });

  test("beyond quota the excess is queued (not refused), FIFO per quota group, and a frozen account can't rent", async () => {
    const w = world({ quotas: { cpu: 2, gpu: 1 } }); // two CPU machines, one GPU
    const id = await funded(w, 100 * USD);
    const res = await rent(w.d, id, rentReq([{ tier: "agent", count: 3 }, { tier: "gpu-20", count: 2 }]));
    expect(res).toMatchObject({ started: 3, queued: 2 });
    expect(res.rentals.map((r) => r.state)).toEqual(["starting", "starting", "queued", "starting", "queued"]);
    expect(res.rentals.filter((r) => r.state === "queued").map((r) => r.queue_position)).toEqual([1, 2]);
    // A later request for the same group queues behind them even if a slot frees for a moment.
    const other = await funded(w, 100 * USD);
    const res2 = await rent(w.d, other, rentReq([{ tier: "agent", count: 1 }]));
    expect(res2.rentals[0]!.state).toBe("queued");
    await w.store.tx((t) => t.setAccount(other, { status: "frozen" }));
    expect(await rent(w.d, other, rentReq([{ tier: "agent", count: 1 }])).catch((e) => e.code)).toBe("account_frozen");
  });

  test("provider failures remain uncertain until reconciliation (no blind retry)", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    w.cloud.failNext = "capacity";
    const a = await rent(w.d, id, rentReq([{ tier: "agent", count: 1 }]));
    expect(a.rentals[0]!.state).toBe("starting");
    w.cloud.failNext = "error";
    const b = await rent(w.d, id, rentReq([{ tier: "gpu-48", count: 1 }])); // another quota group: not behind the queue
    expect(b.rentals[0]!.state).toBe("starting");
    expect(b.balance_micros).toBe(50 * USD); // nothing billed for machines that never launched
  });

  test("an uncertain launch with no instance closes after the grace window without another create", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    w.cloud.failNext = "error";
    await rent(w.d, id, rentReq([{ tier: "agent", count: 1 }]));
    w.advance(2 * MIN);
    await tick(w.d);
    expect((await state(w.d, id)).rentals[0]).toMatchObject({ state: "failed", end_reason: "launch_failed" });
    expect(w.cloud.provisions).toHaveLength(1);
  });
});

describe("metering", () => {
  test("per started minute, exact over many ticks, never double-charged by doubled or concurrent ticks", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    const r = (await rent(w.d, id, rentReq([{ tier: "agent-xl", count: 1 }]))).rentals[0]!;
    const tok = hbToken(w, r.id);
    for (let m = 0; m < 90; m++) {
      w.advance(MIN);
      await beat(w, r.id, tok);
      await tick(w.d);
      if (m % 7 === 0) await tick(w.d); // a doubled tick
    }
    await Promise.all(Array.from({ length: 1000 }, () => tick(w.d)));
    // started at T0, now T0+90 min exactly → 90 started minutes (the minute boundary itself starts none)
    const owed = Math.ceil((1_500_000 * 90) / 60);
    expect(await balance(w.store, id)).toBe(50 * USD - owed);
    const s = await state(w.d, id);
    expect(s.rentals[0]!.spent_micros).toBe(owed);
    expect(s.burn_per_hour_micros).toBe(1_500_000);
    expect(s.hours_left).toBeCloseTo((50 * USD - owed) / 1_500_000, 1);
  });

  test("machines stop before spending credit reserved for the next paid lease", async () => {
    const w = world({ quotas: { cpu: 1, gpu: 1 } });
    const id = await funded(w, 2 * 750_000); // covers two first hours
    const res = await rent(w.d, id, rentReq([{ tier: "agent", count: 2 }]));
    expect(res.rentals.map((r) => r.state)).toEqual(["starting", "queued"]);
    const tok = hbToken(w, res.rentals[0]!.id);
    let minutes = 0;
    while ((await state(w.d, id)).rentals.some((r) => r.state === "running" || r.state === "starting")) {
      w.advance(MIN);
      minutes++;
      await beat(w, res.rentals[0]!.id, tok);
      await tick(w.d);
      if (minutes > 200) throw new Error("never stopped");
    }
    const s = await state(w.d, id);
    expect(s.rentals.map((r) => [r.state, r.end_reason])).toEqual([["needs_code", null], ["ended", "no_credit"]]);
    expect(s.balance_micros).toBeGreaterThanOrEqual(750_000);
    expect(s.balance_micros).toBeLessThan(750_000 + 15 * 12_500); // queued reservation plus less than one paid lease
    expect(w.cloud.terminations).toHaveLength(1);
  });
});

describe("tick stops", () => {
  async function running(w: World) {
    const id = await funded(w, 100 * USD);
    const r = (await rent(w.d, id, rentReq([{ tier: "gpu-20", count: 1 }]))).rentals[0]!;
    const tok = hbToken(w, r.id);
    w.advance(MIN);
    await beat(w, r.id, tok);
    return { id, r, tok };
  }

  test("idle: no busy seat or pool job for idle_minutes", async () => {
    const w = world();
    const { id, r, tok } = await running(w);
    for (let m = 0; m < 29; m++) { w.advance(MIN); await beat(w, r.id, tok, { busy_seats: 0 }); await tick(w.d); }
    expect((await state(w.d, id)).rentals[0]!.state).toBe("running");
    w.advance(MIN); await beat(w, r.id, tok, { busy_seats: 0 }); await tick(w.d);
    expect((await state(w.d, id)).rentals[0]).toMatchObject({ state: "ended", end_reason: "idle" });
  });

  test("heartbeat lost for 15 minutes", async () => {
    const w = world();
    const { id } = await running(w);
    w.advance(15 * MIN);
    await tick(w.d);
    expect((await state(w.d, id)).rentals[0]).toMatchObject({ state: "ended", end_reason: "heartbeat_lost" });
  });

  test("mining heuristic: GPU pegged with no Walkie job for 10 minutes → stop and account under review", async () => {
    const w = world();
    const { id, r, tok } = await running(w);
    for (let m = 0; m < 11; m++) { w.advance(MIN); await beat(w, r.id, tok, { busy_seats: 0, gpu_pct: 100 }); await tick(w.d); }
    expect((await state(w.d, id)).rentals[0]).toMatchObject({ state: "ended", end_reason: "mining" });
    expect(await rent(w.d, id, rentReq([{ tier: "agent", count: 1 }])).catch((e) => e.code)).toBe("account_under_review");
  });

  test("a busy GPU with a Walkie job is not mining", async () => {
    const w = world();
    const { id, r, tok } = await running(w);
    for (let m = 0; m < 20; m++) { w.advance(MIN); await beat(w, r.id, tok, { busy_seats: 0, pool_jobs: 1, gpu_pct: 100 }); await tick(w.d); }
    expect((await state(w.d, id)).rentals[0]!.state).toBe("running");
  });

  test("egress cap per machine", async () => {
    const w = world();
    const { id, r, tok } = await running(w);
    w.advance(MIN); await beat(w, r.id, tok, { egress_bytes: 5000 * 1_000_000_000 }); await tick(w.d);
    expect((await state(w.d, id)).rentals[0]).toMatchObject({ state: "ended", end_reason: "egress_cap" });
  });

  test("boot timeout: never heartbeated in 15 minutes → terminated and everything charged is refunded", async () => {
    const w = world();
    const id = await funded(w, 100 * USD);
    await rent(w.d, id, rentReq([{ tier: "gpu-48", count: 1 }]));
    for (let m = 0; m < 15; m++) { w.advance(MIN); await tick(w.d); }
    expect(w.clock.now - 15 * MIN).toBeLessThan(w.clock.now - BOOT_TIMEOUT_MS + 1);
    const s = await state(w.d, id);
    expect(s.rentals[0]).toMatchObject({ state: "ended", end_reason: "boot_timeout", spent_micros: 0 });
    expect(s.balance_micros).toBe(100 * USD);
  });

  test("a frozen account (dispute) has every machine stopped on the next tick", async () => {
    const w = world();
    const { id } = await running(w);
    await w.store.tx((t) => t.setAccount(id, { status: "frozen" }));
    await tick(w.d);
    expect((await state(w.d, id)).rentals[0]).toMatchObject({ state: "ended", end_reason: "frozen" });
  });

  test("user stop terminates and wipes; the heartbeat token stops working", async () => {
    const w = world();
    const { id, r, tok } = await running(w);
    const out = await stop(w.d, id, { rental_id: r.id });
    expect(out).toMatchObject({ stopped: 1, rentals: [{ state: "ended", end_reason: "user" }] });
    expect(w.cloud.terminations).toHaveLength(1);
    expect(await beat(w, r.id, tok).catch((e) => e.code)).toBe("invalid_heartbeat");
  });
});

describe("queue", () => {
  test("as capacity frees, the oldest queued machine moves to needs_code; a fresh code starts it", async () => {
    const w = world({ quotas: { cpu: 1, gpu: 1 } });
    const id = await funded(w, 100 * USD);
    const res = await rent(w.d, id, rentReq([{ tier: "agent", count: 2 }]));
    const [first, second] = res.rentals;
    await stop(w.d, id, { rental_id: first!.id });
    const rep = await tick(w.d);
    expect(rep.dequeued).toBe(1);
    expect((await state(w.d, id)).rentals.find((r) => r.id === second!.id)!.state).toBe("needs_code");
    const started = await start(w.d, id, second!.id, codes(1)[0]!, "v0.2.0-pre.7");
    expect(started.state).toBe("starting");
    expect(await start(w.d, id, second!.id, codes(1)[0]!, "v0.2.0-pre.7").catch((e) => e.code)).toBe("not_waiting_for_code");
  });

  test("a needs_code rental whose code never comes goes back to the queue", async () => {
    const w = world({ quotas: { cpu: 1, gpu: 1 } });
    const id = await funded(w, 100 * USD);
    const res = await rent(w.d, id, rentReq([{ tier: "agent", count: 2 }]));
    await stop(w.d, id, { rental_id: res.rentals[0]!.id });
    await tick(w.d);
    w.advance(CODE_WAIT_MS);
    await tick(w.d); // back to queued, then re-dequeued in the same pass (capacity is free)
    const r = (await state(w.d, id)).rentals.find((x) => x.id === res.rentals[1]!.id)!;
    expect(r.state).toBe("needs_code");
  });
});

describe("reconcile", () => {
  test("an instance no live rental owns is terminated", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    const r = (await rent(w.d, id, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!;
    const orphan = w.cloud.plantOrphan({ [TAG_MANAGED]: "1", [TAG_RENTAL]: "r_ffffffffffffffff" });
    const rep = await tick(w.d);
    expect(rep.orphans).toBe(0);
    w.advance(2 * MIN);
    expect((await tick(w.d)).orphans).toBe(1);
    expect(w.cloud.state(orphan)).toBe("terminated");
    expect((await state(w.d, id)).rentals.find((x) => x.id === r.id)!.state).toBe("starting");
  });
});

describe("provider billing rules", () => {
  test("a GPU start is billed at least 5 minutes, a CPU start at least 1", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    const res = await rent(w.d, id, rentReq([{ tier: "gpu-80", count: 1 }, { tier: "agent", count: 1 }]));
    w.advance(2 * MIN);
    await stop(w.d, id, { all: true });
    const s = await state(w.d, id);
    const gpu = s.rentals.find((r) => r.id === res.rentals[0]!.id)!;
    const cpu = s.rentals.find((r) => r.id === res.rentals[1]!.id)!;
    expect(gpu.spent_micros).toBe(Math.ceil((8_820_000 * 5) / 60)); // 735000
    expect(cpu.spent_micros).toBe(Math.ceil((750_000 * 2) / 60)); // 25000
  });

  test("egress allowance accrues hourly; excess GiB costs $0.02, charged once", async () => {
    const w = world();
    const id = await funded(w, 50 * USD);
    const r = (await rent(w.d, id, rentReq([{ tier: "agent", count: 1 }]))).rentals[0]!;
    const tok = hbToken(w, r.id);
    const GIB = 1024 ** 3;
    w.advance(MIN); await beat(w, r.id, tok, { egress_bytes: 1024 * GIB }); await tick(w.d);
    const before = await balance(w.store, id);
    w.advance(MIN); await beat(w, r.id, tok, { egress_bytes: 1030 * GIB }); await tick(w.d); await tick(w.d);
    const after = await balance(w.store, id);
    expect(before - after).toBe(6 * 20_000 + 12_500); // 6 GiB over + one more minute
    const v = (await state(w.d, id)).rentals[0]!;
    expect(v.spent_micros).toBe(2 * 12_500 + 1030 * 20_000); // two started minutes + 6 GiB
  });
});
