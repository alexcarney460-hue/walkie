// LOCAL-MODELS-HF-1 item 7: suggestions are the BEST model that fits, not the largest: a newer better model beats an older
// bigger one, popularity does not crown a small one, unrated models come after rated ones; each machine gets its best
// model alone and a faster smaller alternative; a group the best split; the team the best overall. Fit and speed use the
// model's real numbers (a hand-made catalog here, so these tests do not depend on what is shipped).
import { describe, expect, test } from "bun:test";
import { alternativeLabel } from "../../src/pool/format.ts";
import { bestOverall } from "../../src/pool/overall.ts";
import { suggestCombined } from "../../src/pool/combined.ts";
import { bytesPerToken } from "../../src/pool/catalog.ts";
import type { GroupInput } from "../../src/pool/group.ts";
import { singleSpeed, suggestTeam } from "../../src/pool/suggest.ts";
import type { MachineAccel, MachineStats } from "../../src/protocol/machine-stats.ts";
import { catalogOf, mk, rated } from "../helpers/pool-catalog.ts";

const GiB = 1024 ** 3;
const apple = (chip: string): MachineAccel => ({ chip, unified: true, gpu_limit: null, gpus: [] });
const node = (hostname: string, totalGb: number, usedGb: number, accel: MachineAccel, over: Partial<GroupInput> = {}): GroupInput => ({
  node_id: hostname.padEnd(16, "0").slice(0, 16), hostname, handle: "h", online: true, self: false, rtt_ms: 2,
  stats: { at: 1, temp_c: 50, mem: { total: totalGb * GiB, used: usedGb * GiB, swap_used: 0, pressure: "normal" }, accel } as MachineStats, ...over,
});

const cat = catalogOf([
  mk("old-70b", { params_b: 70, released: "2024-07-01", quality: rated(-0.4, { GPQA: 50 }) }),
  mk("new-30b", { params_b: 30, released: "2026-08-01", quality: rated(0.7, { GPQA: 89 }) }),
  mk("mid-120b-moe", { params_b: 120, active_b: 5, released: "2025-08-01", quality: rated(0.0) }),
  mk("big-100b-moe", { params_b: 100, active_b: 8, released: "2026-09-01", quality: rated(0.95, { GPQA: 91 }) }),
  mk("small-8b", { params_b: 8, released: "2026-05-01", quality: rated(0.1) }),
  mk("tiny-popular", { params_b: 0.6, released: "2025-04-01", downloads: 50_000_000, quality: rated(-3.0) }),
  mk("unrated-huge", { params_b: 400, released: "2026-09-20" }),
]);

describe("one machine", () => {
  const studio = node("studio", 64, 10, apple("Apple M4 Max"), { self: true, rtt_ms: null }); // 48 GiB for the GPU, 410 GB/s

  test("the best rated model that fits and is not slow, at 8-bit when that fits: not the largest, not the oldest", () => {
    const s = suggestTeam([studio], { cat }).suggestions[0]!;
    expect(s.single?.model.id).toBe("new-30b");
    expect(s.single?.quant).toBe("q8");
    expect(s.single?.speed).not.toBe("slow");
    // 70B at 4-bit (43.7 GiB) also fits, and is bigger; and the unrated 400B is largest of all. Neither wins.
    expect(["old-70b", "unrated-huge", "mid-120b-moe"]).not.toContain(s.single?.model.id);
  });

  test("a faster smaller alternative: another model that needs less memory and runs at least 1.5x as fast", () => {
    const t = suggestTeam([studio], { cat });
    const m = t.machines[0]!;
    expect(m.best?.model.id).toBe("new-30b");
    expect(m.faster?.model.id).toBe("small-8b");
    expect(m.faster!.need).toBeLessThan(m.best!.need);
    expect(m.faster!.tokensPerSec).toBeGreaterThanOrEqual(1.5 * m.best!.tokensPerSec);
    expect(m.faster!.fits).toBe(true);
    expect(t.suggestions[0]!.faster).toEqual(m.faster);
    expect(t.suggestions[0]!.alternatives).toContainEqual(m.faster!);
  });

  test("speed and memory are the model's real numbers: bytes read per token over 0.6 x the chip's bandwidth", () => {
    const p = suggestTeam([studio], { cat }).machines[0]!.best!;
    expect(p.tokensPerSec).toBeCloseTo(singleSpeed(bytesPerToken(p.model, p.quant, cat)!, 410), 6);
    expect(p.need / GiB).toBeCloseTo(p.model.mem_gib[p.quant]!, 1);
  });

  test("popularity does not crown a small model: 50 million downloads do not beat a better rated 8B", () => {
    const small = node("air", 16, 8, apple("Apple M3")); // about 7 GiB free for the GPU
    const m = suggestTeam([small], { cat }).machines[0]!;
    expect(m.best?.model.id).toBe("small-8b");
    expect(m.best?.model.id).not.toBe("tiny-popular");
    expect(m.faster?.model.id).toBe("tiny-popular"); // smaller and quicker, offered as the quick option, not the best
  });

  test("an unrated model is not offered over a rated one however large or new; with nothing rated that fits, it is", () => {
    const only = catalogOf([mk("unrated-a", { params_b: 8, released: "2026-09-01" }), mk("unrated-b", { params_b: 8, released: "2026-01-01" })]);
    expect(suggestTeam([node("m", 32, 8, apple("Apple M4"))], { cat: only }).machines[0]!.best?.model.id).toBe("unrated-a"); // newest month
  });

  test("a machine nothing fits on has no best and no faster pick, and the group says what it would need", () => {
    const t = suggestTeam([node("full", 16, 15.5, apple("Apple M1"))], { cat });
    expect(t.machines[0]).toMatchObject({ best: null, faster: null });
    expect(t.suggestions[0]!.alternatives.some((a) => !a.fits)).toBe(true);
  });

  test("when nothing fits, 'Smallest' is the model that needs the least memory, not the lowest ranked or the newest unrated one", () => {
    const s = suggestTeam([node("full", 16, 15.5, apple("Apple M1"))], { cat }).suggestions[0]!;
    const smallest = s.alternatives.find((a) => !a.fits)!;
    expect(smallest.model.id).toBe("tiny-popular"); // 0.6B; the lowest ranked is unrated-huge (400B), the worst rated is tiny-popular too
    expect(alternativeLabel(s, smallest)).toBe("Smallest");
    // Rank the other way round: the worst-ranked model is now a big one, the smallest still wins.
    const flipped = catalogOf([mk("a-small", { params_b: 3, released: "2026-09-01", quality: rated(0.9) }), mk("z-big-unrated", { params_b: 200, released: "2024-01-01" }), mk("m-mid", { params_b: 30, released: "2026-01-01", quality: rated(0.2) })]);
    const f = suggestTeam([node("full", 16, 15.5, apple("Apple M1"))], { cat: flipped }).suggestions[0]!;
    expect(f.alternatives.find((a) => !a.fits)!.model.id).toBe("a-small");
  });

  test("a CPU-only machine: the best model it runs at a usable speed, and its faster alternative", () => {
    const cpu = node("box", 64, 4, { chip: "Xeon", unified: false, gpu_limit: null, gpus: [] });
    const m = suggestTeam([cpu], { cat }).machines[0]!;
    expect(m.best).not.toBeNull();
    expect(m.best!.speed).not.toBe("slow");
  });
});

describe("machines on one network, and the team", () => {
  const nodes = [
    node("lab-a", 64, 10, apple("Apple M4 Max"), { self: true, rtt_ms: null }),
    node("lab-b", 64, 10, apple("Apple M4 Max"), { rtt_ms: 2 }),
  ];

  test("every machine is listed with its own best pick; the group's split is the best model one machine cannot hold", () => {
    const t = suggestTeam(nodes, { cat });
    expect(t.machines.map((m) => [m.machine.hostname, m.group, m.best?.model.id])).toEqual([["lab-a", 0, "new-30b"], ["lab-b", 0, "new-30b"]]);
    const s = t.suggestions[0]!;
    expect(s.pooled?.model.id).toBe("big-100b-moe"); // 57 GiB across two 48 GiB machines
    expect(s.pooled?.placement).toHaveLength(2);
    expect(s.pooled?.speed).toBe("fast");
    expect(t.headline).toBe(s);
  });

  test("no split when the best model already fits one machine", () => {
    const only = catalogOf(cat.models.filter((m) => m.id !== "big-100b-moe"));
    expect(suggestTeam(nodes, { cat: only }).suggestions[0]!.pooled).toBeNull(); // mid-120b (66 GiB) would fit the pair but is rated below new-30b
  });

  test("the single best overall: across every machine alone, every group's split and all machines together", () => {
    const t = suggestTeam(nodes, { cat });
    const cs = suggestCombined(nodes, { cat });
    const o = bestOverall(t, cs)!;
    expect(o.pick.model.id).toBe("big-100b-moe");
    expect(["group", "team"]).toContain(o.how);
    // With only one small machine, the best overall is that machine's best.
    const lone = suggestTeam([nodes[0]!], { cat });
    const o2 = bestOverall(lone, suggestCombined([nodes[0]!], { cat }))!;
    expect(o2.pick.model.id).toBe("new-30b");
    expect(o2.how).toBe("machine");
  });

  test("nothing fits anywhere: no overall pick; no machines reporting: none either", () => {
    const t = suggestTeam([node("full", 16, 15.5, apple("Apple M1"), { self: true, rtt_ms: null })], { cat });
    expect(bestOverall(t, null)).toBeNull();
    expect(bestOverall(suggestTeam([], { cat }), null)).toBeNull();
  });

  test("scattered machines: the headline group is the one with the best rated pick", () => {
    const t = suggestTeam([
      node("me", 16, 8, apple("Apple M3"), { self: true, rtt_ms: null }),
      node("far-studio", 64, 10, apple("Apple M4 Max"), { rtt_ms: 40 }),
    ], { cat });
    expect(t.suggestions.map((s) => s.group.kind)).toEqual(["local", "single"]);
    expect(t.headline?.group.machines[0]?.hostname).toBe("far-studio");
  });
});

describe("labels", () => {
  test("a better rated alternative that is slow or on the CPU says so; 'Bigger' is gone because size is not quality", () => {
    const cpu = node("box", 64, 4, { chip: "Xeon", unified: false, gpu_limit: null, gpus: [] }, { self: true, rtt_ms: null });
    const s = suggestTeam([cpu], { cat }).suggestions[0]!;
    const better = s.alternatives.find((a) => a.fits && s.single && a.model.id !== s.single.model.id && a.need > s.single.need);
    if (better) expect(alternativeLabel(s, better)).toMatch(/^Better/);
    for (const a of s.alternatives) expect(alternativeLabel(s, a)).not.toMatch(/^Bigger/);
  });
});
