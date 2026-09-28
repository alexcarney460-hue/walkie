// WALKIE-POOL-LLM-1: "what your team could run locally": catalog validation, memory math, capacity, grouping and
// suggestions. Nothing is downloaded or run; these are estimates from memory figures.
import { describe, expect, test } from "bun:test";
import { CATALOG, bytesPerToken, kvValuesPerToken, memoryNeeded, weightBytes, type CatalogModel } from "../../src/pool/catalog.ts";
import { CatalogSchema } from "../../src/pool/catalog-schema.ts";
import { appleGpuShare, machineCapacity, RESERVE_BYTES } from "../../src/pool/capacity.ts";
import { groupMachines, LAN_RTT_MS, type GroupInput } from "../../src/pool/group.ts";
import { pooledSpeed, singleSpeed, speedClass, suggestForGroup, suggestTeam } from "../../src/pool/suggest.ts";
import type { MachineAccel, MachineStats } from "../../src/protocol/machine-stats.ts";

const GiB = 1024 ** 3;
const model = (id: string): CatalogModel => {
  const m = CATALOG.models.find((x) => x.id === id);
  if (!m) throw new Error(`no ${id}`);
  return m;
};
const apple = (chip: string): MachineAccel => ({ chip, unified: true, gpu_limit: null, gpus: [] });
const node = (hostname: string, totalGb: number, usedGb: number, accel: MachineAccel | undefined, over: Partial<GroupInput> = {}, gpuFree?: number[]): GroupInput => ({
  node_id: hostname, hostname, handle: "h", online: true, self: false, rtt_ms: 2,
  stats: { at: 1, temp_c: 50, mem: { total: totalGb * GiB, used: usedGb * GiB, swap_used: 0, pressure: "normal" }, ...(accel ? { accel } : {}), ...(gpuFree ? { gpu_free: gpuFree } : {}) } as MachineStats,
  ...over,
});

describe("catalog", () => {
  test("models.json passes its schema: unique ids, https model-card sources, 4-bit figure for every model", () => {
    const r = CatalogSchema.safeParse(CATALOG);
    if (!r.success) throw new Error(JSON.stringify(r.error.issues));
    for (const m of CATALOG.models) {
      expect(m.source).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+$/);
      expect(m.verified).toBe(true);
    }
  });

  test("covers small to large: ~3B, 7-8B, 14B, 20-32B, 70B, 100B+ mixture of experts", () => {
    const has = (lo: number, hi: number, moe = false) => CATALOG.models.some((m) => m.params_b >= lo && m.params_b <= hi && (!moe || m.active_b !== null));
    expect(has(2.5, 4)).toBe(true);
    expect(has(7, 8.5)).toBe(true);
    expect(has(13, 15)).toBe(true);
    expect(has(20, 33)).toBe(true);
    expect(has(65, 75)).toBe(true);
    expect(has(100, 1000, true)).toBe(true);
  });

  test("the stored mem_gib is the documented formula (weights + KV cache at 8K + 1 GiB overhead)", () => {
    for (const m of CATALOG.models) {
      for (const q of ["q4", "q8"] as const) {
        const need = memoryNeeded(m, q);
        if (m.mem_gib[q] === null) expect(need).toBeNull();
        else expect(Math.abs((need as number) / GiB - (m.mem_gib[q] as number))).toBeLessThanOrEqual(0.05);
      }
    }
  });

  test("worked examples: Llama 3.3 70B at 4-bit, Llama 3.1 8B, gpt-oss-120b native, DeepSeek MLA", () => {
    const l70 = model("llama-3.3-70b");
    expect(kvValuesPerToken(l70.arch)).toBe(2 * 80 * 8 * 128);
    // 70.55e9 × 4.8944 / 8 = 43.16 GB weights (llama.cpp's table: 43.1 GB) + 2.5 GiB KV at 8K + 1 GiB.
    expect((weightBytes(l70, "q4") as number) / 1e9).toBeCloseTo(43.16, 1);
    expect((memoryNeeded(l70, "q4") as number) / GiB).toBeCloseTo(43.7, 1);
    expect((memoryNeeded(model("llama-3.1-8b"), "q4") as number) / GiB).toBeCloseTo(6.6, 1);
    const oss = model("gpt-oss-120b");
    expect(weightBytes(oss, "q4")).toBe(60.8 * GiB);
    expect(memoryNeeded(oss, "q8")).toBeNull();
    // Mixture of experts: a token reads only the active share.
    expect((bytesPerToken(oss, "q4") as number) / GiB).toBeCloseTo((60.8 * 5.1) / 117, 2);
    expect(kvValuesPerToken(model("deepseek-v3").arch)).toBe(61 * (512 + 64));
    // Longer context costs KV: 32K is 4x the 8K cache.
    const kv8 = (memoryNeeded(l70, "q4", 8192) as number) - (weightBytes(l70, "q4") as number) - GiB;
    const kv32 = (memoryNeeded(l70, "q4", 32768) as number) - (weightBytes(l70, "q4") as number) - GiB;
    expect(kv32 / kv8).toBeCloseTo(4, 5);
  });
});

describe("capacity: memory in use is not counted", () => {
  test("Apple Silicon: the GPU share of unified memory (2/3 up to 32 GiB, 3/4 above), capped by what's free", () => {
    expect(appleGpuShare(16 * GiB)).toBeCloseTo(2 / 3);
    expect(appleGpuShare(64 * GiB)).toBe(0.75);
    const busy = machineCapacity(node("m5", 16, 12, apple("Apple M5")))!;
    expect(busy.kind).toBe("apple");
    expect(busy.backends.map((b) => b.kind)).toEqual(["apple", "cpu"]); // Metal first, the CPU on its own
    expect(busy.usable).toBe(16 * GiB - 12 * GiB - RESERVE_BYTES); // 3 GiB: less than the GPU share
    expect(busy.backends[0]!.usableIdle).toBe(Math.floor((16 * GiB * 2) / 3));
    expect(busy.backends[1]!.usableIdle).toBe(12 * GiB); // the CPU can use all but the idle allowance
    expect(busy.bandwidth).toBe(153);
    expect(busy.label).toBe("Apple M5 · 16 GB unified");
    const idle = machineCapacity(node("studio", 192, 10, apple("Apple M2 Ultra")))!;
    expect(idle.backends[0]!.usable).toBe(192 * GiB * 0.75); // the GPU cap binds on Metal
    expect(idle.backends[1]!.usable).toBe(192 * GiB - 10 * GiB - RESERVE_BYTES); // not on the CPU
    expect(idle.bandwidth).toBe(800);
    const limited = machineCapacity(node("mx", 64, 4, { ...apple("Apple M4 Max"), gpu_limit: 56 * GiB }))!;
    expect(limited.backends[0]!.usable).toBe(56 * GiB);
    expect(limited.notes[0]).toContain("iogpu.wired_limit_mb");
  });

  test("NVIDIA: free VRAM minus 1 GiB per GPU now, VRAM minus 1 GiB if idle, plus system RAM on the CPU; CPU-only: free RAM; no memory: excluded", () => {
    const rig = machineCapacity(node("rig", 64, 20, { chip: "AMD Ryzen 9 7950X", unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GeForce RTX 4090", vram: 24 * GiB }, { name: "NVIDIA GeForce RTX 4090", vram: 24 * GiB }] }, {}, [24 * GiB, 10 * GiB]))!;
    expect(rig.kind).toBe("nvidia");
    expect(rig.backends[0]).toMatchObject({ kind: "nvidia", usable: 32 * GiB, usableIdle: 46 * GiB, measured: true });
    expect(rig.backends[1]).toMatchObject({ kind: "cpu", usable: 43 * GiB, usableIdle: 60 * GiB });
    expect(rig.usable).toBe(43 * GiB); // the larger backend: what it adds to a split
    expect(rig.label).toBe("2x NVIDIA GeForce RTX 4090 · 48 GB VRAM + 64 GB RAM");
    expect(rig.bandwidthKnown).toBe(false);
    const laptop = machineCapacity(node("wsl", 8, 5, { chip: "Intel(R) Core(TM) 7 240H", unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GeForce RTX 5070 Laptop GPU", vram: 8151 * 1024 ** 2 }] }))!;
    expect(laptop.bandwidth).toBe(250);
    const cpu = machineCapacity(node("box", 32, 8, { chip: "Intel Xeon", unified: false, gpu_limit: null, gpus: [] }))!;
    expect(cpu.kind).toBe("cpu");
    expect(cpu.usable).toBe(23 * GiB);
    const old = machineCapacity(node("old", 32, 8, undefined))!;
    expect(old.notes[0]).toContain("older Walkie");
    expect(machineCapacity({ node_id: "x", hostname: "x", handle: "h" })).toBeNull();
    expect(machineCapacity(node("full", 16, 16, apple("Apple M1")))!.usable).toBe(0);
  });
});

describe("grouping", () => {
  test("this machine + peers within 5 ms pool; farther machines are their own groups; offline and silent excluded", () => {
    const g = groupMachines([
      node("me", 64, 20, apple("Apple M4 Max"), { self: true, rtt_ms: null }),
      node("lan-a", 128, 30, apple("Apple M3 Max"), { rtt_ms: 2 }),
      node("lan-b", 64, 10, undefined, { rtt_ms: LAN_RTT_MS }),
      node("far", 32, 5, apple("Apple M2 Pro"), { rtt_ms: 38 }),
      node("gone", 32, 5, apple("Apple M1"), { online: false }),
      { node_id: "quiet", hostname: "quiet", handle: "h", online: true, self: false, rtt_ms: 1 },
    ]);
    expect(g.groups.map((x) => [x.kind, x.machines.map((m) => m.hostname)])).toEqual([["local", ["me", "lan-a", "lan-b"]], ["single", ["far"]]]);
    expect(g.groups[0]!.maxRttMs).toBe(5);
    expect(g.groups[0]!.why).toBe("This machine and 2 others answer within 5 ms (slowest 5 ms): likely the same local network, close enough to split a model across");
    expect(g.groups[1]!.why).toContain("38 ms from this machine");
    expect(g.excluded).toEqual([
      { hostname: "gone", handle: "h", reason: "offline" },
      { hostname: "quiet", handle: "h", reason: "no memory reported (machine stats turned off, or an older Walkie)" },
    ]);
  });

  test("a machine alone; a peer not measured yet is not assumed near", () => {
    const g = groupMachines([node("me", 16, 4, apple("Apple M5"), { self: true, rtt_ms: null }), node("new", 16, 4, apple("Apple M5"), { rtt_ms: null })]);
    expect(g.groups[0]!.why).toContain("no teammate's machine answers within 5 ms");
    expect(g.groups[1]!.why).toContain("not measured yet");
  });
});

describe("speed estimates", () => {
  test("bandwidth-bound: tokens/s = 0.6 x bandwidth / bytes read per token; classes fast ≥ 20, usable ≥ 5", () => {
    // llama.cpp's M1 Max result (400 GB/s, 7B Q4_0 3.56 GiB) is 61 t/s; the estimate is conservative.
    expect(singleSpeed(3.56 * GiB, 400)).toBeCloseTo(62.8, 0);
    expect(speedClass(20)).toBe("fast");
    expect(speedClass(19.9)).toBe("usable");
    expect(speedClass(4.9)).toBe("slow");
  });

  test("pipeline: the stages add up plus a hop per extra machine", () => {
    const one = pooledSpeed(40 * GiB, [{ share: 1, bandwidth: 400 }], 1);
    expect(one).toBeCloseTo(singleSpeed(40 * GiB, 400), 5);
    const two = pooledSpeed(40 * GiB, [{ share: 0.5, bandwidth: 400 }, { share: 0.5, bandwidth: 400 }], 2);
    const perToken = 1 / one + (2 + 2) / 1000;
    expect(two).toBeCloseTo(1 / perToken, 5);
    expect(two).toBeLessThan(one);
  });
});

describe("suggestions", () => {
  test("this Mac alone, busy (12 of 16 GB in use): nothing fits now; if idle, a 14B model", () => {
    const t = suggestTeam([node("this-mac", 16, 12.3, apple("Apple M5"), { self: true, rtt_ms: null })]);
    const s = t.suggestions[0]!;
    expect(s.single).toBeNull();
    expect(s.pooled).toBeNull();
    expect(s.alternatives[0]?.model.id).toBe("llama-3.2-3b");
    expect(s.alternatives[0]?.fits).toBe(false);
    expect(s.alternatives[0]?.why).toContain("this-mac has");
    expect(s.ifIdle?.model.params_b).toBeGreaterThanOrEqual(14);
    expect(s.ifIdle?.model.params_b).toBeLessThan(20);
  });

  test("a LAN group: the largest single-machine model first, then a bigger one split across the group", () => {
    const t = suggestTeam([
      node("me", 64, 22, apple("Apple M4 Max"), { self: true, rtt_ms: null }),
      node("lab", 64, 20, apple("Apple M3 Max"), { rtt_ms: 2 }),
      node("rig", 32, 16, { chip: "AMD Ryzen 9", unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GeForce RTX 4090", vram: 24 * GiB }] }, { rtt_ms: 1 }, [24 * GiB]),
    ]);
    const s = t.suggestions[0]!;
    expect(s.group.kind).toBe("local");
    // Each Mac has ~41-43 GiB free and a 48 GiB GPU share: Qwen3 32B at 8-bit (35.4 GiB) is the largest single fit.
    expect(s.single?.model.id).toBe("qwen3-32b");
    expect(s.single?.quant).toBe("q8");
    expect(s.single?.fits).toBe(true);
    // Together ~106 GiB: gpt-oss-120b (62.4 GiB) split across two machines, fast because only 5.1B are active.
    expect(s.pooled?.model.id).toBe("gpt-oss-120b");
    expect(s.pooled?.pooled).toBe(true);
    expect(s.pooled?.placement.length).toBe(2);
    expect(s.pooled?.placement.reduce((a, p) => a + p.bytes, 0)).toBeCloseTo(s.pooled!.need, 0);
    expect(s.pooled?.why).toMatch(/^Needs 63\.4 GB \(4-bit, 8K context, 2 runtimes\); the group has [\d.]+ GB free now, split across (me|lab|rig), /);
    const next = s.alternatives.find((a) => !a.fits);
    expect(next?.model.id).toBe("qwen3-235b-a22b");
    expect(next?.why).toContain("GB short");
    expect(t.headline).toBe(s);
  });

  test("a scattered team: every machine on its own; the headline is the machine that runs the largest model", () => {
    const t = suggestTeam([
      node("me", 16, 11, apple("Apple M3"), { self: true, rtt_ms: null }),
      node("studio", 192, 40, apple("Apple M2 Ultra"), { rtt_ms: 31 }),
      node("x1", 16, 14.9, { chip: "Intel(R) Core(TM) i7", unified: false, gpu_limit: null, gpus: [] }, { rtt_ms: 47 }),
    ]);
    expect(t.suggestions.map((s) => s.group.kind)).toEqual(["local", "single", "single"]);
    expect(t.suggestions.every((s) => s.pooled === null)).toBe(true);
    expect(t.headline?.group.machines[0]?.hostname).toBe("studio");
    expect(t.headline?.single?.model.id).toBe("qwen3-235b-a22b"); // 136 GiB of the 144 GiB GPU share
    // Only 22B of the 235B are read per token: ~35 tokens/s at 800 GB/s (estimate).
    expect(t.headline?.single?.speed).toBe("fast");
  });

  test("a slow single pick offers a faster smaller one", () => {
    const s = suggestForGroup(groupMachines([node("cpu", 64, 4, { chip: "Xeon", unified: false, gpu_limit: null, gpus: [] }, { self: true })]).groups[0]!);
    expect(s.single?.speed).toBe("slow");
    const faster = s.alternatives.find((a) => a.fits);
    expect(faster && ["fast", "usable"]).toContain(faster!.speed);
    expect(faster!.model.params_b).toBeLessThan(s.single!.model.params_b);
  });
});
