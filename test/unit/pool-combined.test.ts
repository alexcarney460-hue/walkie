// WALKIE-POOL-2 Part A: "with all our machines together": the whole team's compute combined, wherever the machines
// are, the head with the smallest total round trip, and what this machine can start now (sharing machines only).
import { describe, expect, test } from "bun:test";
import { canServe, rttBetween, UNMEASURED_RTT_MS } from "../../src/pool/combined.ts";
import { suggestCombined, suggestTeam } from "../helpers/pool-legacy.ts";
import { HOP_OVERHEAD_MS, RPC_ROUND_TRIPS_PER_TOKEN, EFFICIENCY } from "../../src/pool/suggest.ts";
import type { GroupInput } from "../../src/pool/group.ts";
import type { MachineAccel, MachineStats } from "../../src/protocol/machine-stats.ts";
import type { PoolShare } from "../../src/protocol/pool.ts";

const GiB = 1024 ** 3;
const apple = (chip: string): MachineAccel => ({ chip, unified: true, gpu_limit: null, gpus: [] });
const SHARE: PoolShare = { share: true, cap: null, runtime: true, busy: false };

function node(id: string, totalGb: number, usedGb: number, accel: MachineAccel, over: Partial<GroupInput> = {}, extra: Partial<MachineStats> = {}): GroupInput {
  return {
    node_id: id.padEnd(16, "0").slice(0, 16), hostname: id, handle: id.split("-")[0]!, online: true, self: false, rtt_ms: 30,
    stats: { at: 1, temp_c: 50, mem: { total: totalGb * GiB, used: usedGb * GiB, swap_used: 0, pressure: "normal" }, accel, ...extra } as MachineStats,
    ...over,
  };
}
const nid = (h: string): string => h.padEnd(16, "0").slice(0, 16);

/** The real fleet's shape: five machines at four sites, 20-40 ms apart over Tailscale / Walkie Direct. */
function fleet(pool: Partial<Record<string, PoolShare>> = {}): GroupInput[] {
  return [
    node("a1ex", 16, 9, apple("Apple M5"), { self: true, rtt_ms: 0, pool: pool.a1ex ?? { share: false, cap: null, runtime: false, busy: false } }, { sys: { os: "darwin", arch: "arm64", cpus: 8, load1: 0 } }),
    node("b0b0", 36, 14, apple("Apple M3 Pro"), { rtt_ms: 24, ...(pool.b0b0 ? { pool: pool.b0b0 } : {}) }, { sys: { os: "darwin", arch: "arm64", cpus: 12, load1: 0 } }),
    node("c0ffee", 64, 12, { chip: "AMD Ryzen 9 7950X", unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GeForce RTX 4090", vram: 24 * GiB }] }, { rtt_ms: 31, ...(pool.c0ffee ? { pool: pool.c0ffee } : {}) }, { gpu_free: [22 * GiB], sys: { os: "linux", arch: "x64", cpus: 16, load1: 0 } }),
    node("d00d", 16, 7, { chip: "Intel(R) Core(TM) Ultra 7 155H", unified: false, gpu_limit: null, gpus: [] }, { rtt_ms: 38, ...(pool.d00d ? { pool: pool.d00d } : {}) }),
    node("e1e1", 24, 10, apple("Apple M4"), { rtt_ms: 27, ...(pool.e1e1 ? { pool: pool.e1e1 } : {}) }, { sys: { os: "darwin", arch: "arm64", cpus: 8, load1: 0 } }),
  ];
}

describe("round trips between two machines", () => {
  const me = node("me", 16, 4, apple("Apple M5"), { self: true, rtt_ms: 0 });
  test("from this machine: measured by the sync call", () => {
    const b = node("bb", 16, 4, apple("Apple M5"), { rtt_ms: 12 });
    expect(rttBetween(me, b)).toEqual({ ms: 12, how: "measured" });
    expect(rttBetween(b, me)).toEqual({ ms: 12, how: "measured" });
  });
  test("between two others: their own published measurements (both averaged), else via this machine, else unmeasured", () => {
    const b = node("bb", 16, 4, apple("Apple M5"), { rtt_ms: 20 }, { peer_rtt: { [nid("cc")]: 3 } });
    const c = node("cc", 16, 4, apple("Apple M5"), { rtt_ms: 25 }, { peer_rtt: { [nid("bb")]: 5 } });
    expect(rttBetween(b, c)).toEqual({ ms: 4, how: "measured" });
    const d = node("dd", 16, 4, apple("Apple M5"), { rtt_ms: 25 });
    expect(rttBetween(b, d)).toEqual({ ms: 45, how: "via-this-machine" }); // triangle upper bound
    const e = node("ee", 16, 4, apple("Apple M5"), { rtt_ms: null });
    expect(rttBetween(d, e)).toEqual({ ms: UNMEASURED_RTT_MS, how: "unmeasured" });
  });
});

describe("with all our machines together", () => {
  test("the fleet never pools by LAN, but combined it runs a bigger model than any one machine", () => {
    const nodes = fleet();
    const t = suggestTeam(nodes);
    expect(t.groups.every((g) => g.machines.length === 1)).toBe(true); // nobody within 5 ms: the old answer
    const biggestAlone = Math.max(...t.suggestions.map((s) => (s.single ?? s.pooled)?.model.params_b ?? 0));
    const c = suggestCombined(nodes);
    expect(c.pick).not.toBeNull();
    const p = c.pick!;
    expect(p.model.params_b).toBeGreaterThan(biggestAlone);
    expect(p.placement.length).toBeGreaterThan(1);
    expect(p.pooled).toBe(true);
    // Memory: every part fits the machine it is on (one backend each), overhead counted per extra runtime.
    for (const pl of p.placement) {
      const m = c.machines.find((x) => x.node_id === pl.node_id)!;
      expect(pl.bytes).toBeLessThanOrEqual(Math.max(...m.backends.map((b) => b.usable)) + 1);
    }
    expect(p.need).toBeGreaterThanOrEqual(p.placement.reduce((s, x) => s + x.bytes, 0) - 1);
  });

  test("speed = compute on each stage + 1.3 round trips (measured, POOL-REAL-1) from the head to every remote stage (+2 ms each)", () => {
    const c = suggestCombined(fleet());
    const p = c.pick!;
    const hops = p.hops.reduce((s, h) => s + RPC_ROUND_TRIPS_PER_TOKEN * Math.max(1, h.ms) + HOP_OVERHEAD_MS, 0);
    expect(p.hopMs).toBe(hops);
    expect(p.hops.length).toBe(p.placement.filter((x) => x.node_id !== p.head.node_id).length);
    expect(p.tokensPerSec).toBeCloseTo(1000 / (p.computeMs + p.hopMs), 6);
    expect(p.computeMs).toBeGreaterThan(0);
    expect(EFFICIENCY).toBe(0.6);
  });

  test("the stage order doesn't change the estimate (llama.cpp RPC is a star around the head)", () => {
    const a = suggestCombined(fleet()).pick!;
    const b = suggestCombined([...fleet()].reverse()).pick!;
    expect(b.model.id).toBe(a.model.id);
    expect(b.hopMs).toBe(a.hopMs);
    // Two machines tie on free memory, so which one fills first may differ with the input order (a slightly
    // different compute share); the network part is identical.
    expect(Math.abs(b.tokensPerSec - a.tokensPerSec) / a.tokensPerSec).toBeLessThan(0.01);
  });

  test("the head is the machine with the smallest total round trip; this machine's own speed is shown too", () => {
    // This machine is far from everyone; the others published that they are 2 ms from each other (one office).
    const office = ["b0b0", "c0ffee", "d00d", "e1e1"];
    const nodes = fleet().map((n) => (n.self ? { ...n, rtt_ms: 0 } : {
      ...n, rtt_ms: 80,
      stats: { ...n.stats!, peer_rtt: Object.fromEntries(office.filter((o) => o !== n.hostname).map((o) => [nid(o), 2])) },
    }));
    const p = suggestCombined(nodes).pick!;
    expect(p.head.self).toBe(false);
    expect(office).toContain(p.head.hostname);
    expect(p.fromHere).not.toBeNull();
    expect(p.fromHere!.tokensPerSec).toBeLessThan(p.tokensPerSec);
    expect(p.hops.every((h) => h.how === "measured" && (h.ms === 2 || h.node_id === nid("a1ex")))).toBe(true);
  });

  test("without published round trips, pairs of other machines use rtt(me,A)+rtt(me,B) and say it's an estimate", () => {
    const nodes = fleet().map((n) => (n.self ? { ...n, stats: { ...n.stats!, mem: { ...n.stats!.mem!, used: 15.5 * GiB } } } : n));
    const p = suggestCombined(nodes).pick!;
    if (!p.head.self) {
      expect(p.hops.some((h) => h.how === "via-this-machine")).toBe(true);
      expect(p.estimated).toBe(true);
    } else {
      expect(p.hops.every((h) => h.how === "measured")).toBe(true);
    }
  });

  test("offline machines and machines without memory figures are not counted", () => {
    const nodes = fleet().map((n) => (n.hostname === "c0ffee" ? { ...n, online: false } : n.hostname === "d00d" ? { ...n, stats: undefined } : n));
    const c = suggestCombined(nodes);
    expect(c.machines.map((m) => m.hostname).sort()).toEqual(["a1ex", "b0b0", "e1e1"]);
    expect(c.pick!.placement.every((p) => p.hostname !== "c0ffee" && p.hostname !== "d00d")).toBe(true);
  });
});

describe("what this machine can start now: opt-in machines only, within their cap", () => {
  test("nobody sharing: only this machine; the bigger pick names who would have to share", () => {
    const c = suggestCombined(fleet({ a1ex: SHARE }));
    expect(c.sharing).toEqual([]);
    expect(c.runnable?.placement.every((p) => p.hostname === "a1ex")).toBe(true);
    expect(c.notSharing.length).toBeGreaterThan(0);
    expect(c.runnableNote).toContain("walkie pool share on");
  });

  test("older Walkies (no pool field) count as not sharing; a machine without the runtime or busy can't serve", () => {
    expect(canServe(fleet()[1]!)).toBe(false);
    expect(canServe({ ...fleet()[1]!, pool: { ...SHARE, runtime: false } })).toBe(false);
    expect(canServe({ ...fleet()[1]!, pool: { ...SHARE, busy: true } })).toBe(false);
    expect(canServe({ ...fleet()[1]!, pool: SHARE })).toBe(true);
  });

  test("sharing machines join, each held to its cap; the head is always this machine", () => {
    const cap = 6 * GiB;
    const c = suggestCombined(fleet({ a1ex: SHARE, b0b0: { ...SHARE, cap }, c0ffee: SHARE, e1e1: SHARE }));
    const r = c.runnable!;
    expect(r.head.self).toBe(true);
    expect(r.placement.length).toBeGreaterThan(1);
    const kira = r.placement.find((p) => p.hostname === "b0b0");
    if (kira) expect(kira.bytes).toBeLessThanOrEqual(cap);
    expect(r.placement.some((p) => p.hostname === "d00d")).toBe(false); // not sharing
    expect(r.hops.every((h) => h.how === "measured")).toBe(true); // all from this machine
  });

  test("no runtime on this machine: nothing runnable, and the note says how to install it", () => {
    const c = suggestCombined(fleet());
    expect(c.runnable).toBeNull();
    expect(c.runnableNote).toContain("walkie pool install");
  });
});
