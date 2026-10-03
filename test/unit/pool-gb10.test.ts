// WALK-81: a DGX Spark (NVIDIA GB10) prints `[N/A]` for its memory (it shares unified memory with the CPU), so Walkie
// said "No GPU found" and ranked the machine on the CPU. Everything here starts from the real nvidia-smi and
// /proc/meminfo output captured on spark-115f and spark-0e86 (test/fixtures/machine-stats).
import { describe, expect, test } from "bun:test";
import { parseGpuNow, parseNvidiaSmi, readAccel } from "../../src/daemon/machine-stats/accel.ts";
import { MachineAccel, MachineStats } from "../../src/protocol/machine-stats.ts";
import { appleGpuShare, DEFAULT_BW, IDLE_OS_BYTES, machineCapacity, RESERVE_BYTES } from "../../src/pool/capacity.ts";
import { bytesPerToken } from "../../src/pool/catalog.ts";
import { groupMachines } from "../../src/pool/group.ts";
import { deviceSlot, singleSpeed, suggestTeam } from "../../src/pool/suggest.ts";
import { bestServe, serveHosts } from "../../src/pool/run/plan.ts";
import { catalogOf, mk, rated } from "../helpers/pool-catalog.ts";
import { fixture, spark } from "../helpers/pool-machines.ts";

const GiB = 1024 ** 3;
const A = "machine-stats/meminfo-gb10-spark-115f.txt";
const B = "machine-stats/meminfo-gb10-spark-0e86.txt";
const GB10 = { name: "NVIDIA GB10", vram: 0, unified: true };

// Synthetic equivalent of the preserved F2 diagnostic, with explicit platform metadata.
test("pinned arm64 runtime uses CPU bandwidth while GB10 hardware retains GPU potential", () => {
  const n = { node_id: "arm-fixture", hostname: "arm-fixture", handle: "fixture", online: true, self: true, rtt_ms: 0,
    stats: { at: 1, temp_c: null, sys: { os: "linux", arch: "arm64", cpus: 20, load1: 0 },
      mem: { total: 128 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" },
      accel: { chip: null, unified: false, gpu_limit: null, gpus: [GB10] } } } as const;
  const input = { ...n, stats: { ...n.stats, accel: { ...n.stats.accel, gpus: [GB10] } } };
  const capacity = machineCapacity(input)!;
  expect(capacity.bandwidth).toBe(273);
  expect(capacity.notes).toEqual([]);
  expect(deviceSlot(capacity).b.bandwidth).toBe(DEFAULT_BW.cpu);
  expect(deviceSlot(capacity).b.memory).toBe("system memory (CPU)");
  expect(serveHosts([input], 10 * GiB)).toEqual([]);
  expect(bestServe([input])).toBeNull();
});

describe("reading the GB10", () => {
  test("the captured nvidia-smi line keeps the GPU, marked as sharing the machine's memory", () => {
    expect(fixture("machine-stats/nvidia-smi-gb10.txt")).toBe("NVIDIA GB10, [N/A]\n");
    expect(parseNvidiaSmi(fixture("machine-stats/nvidia-smi-gb10.txt"))).toEqual([GB10]);
    expect(parseNvidiaSmi(fixture("machine-stats/nvidia-smi-gb10-spark-0e86.txt"))).toEqual([GB10]);
  });

  test("only a known integrated NVIDIA part counts: other names with [N/A] memory are still dropped", () => {
    expect(parseNvidiaSmi("GPU, [N/A]\n")).toEqual([]);
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, [N/A]\n")).toEqual([]);
    expect(parseNvidiaSmi("NVIDIA GB10, [N/A]\nNVIDIA GeForce RTX 4090, 24564\n")).toEqual([GB10, { name: "NVIDIA GeForce RTX 4090", vram: 24564 * 1024 ** 2 }]);
  });

  test("free memory is [N/A] too (unmeasured), the temperature still reads", () => {
    expect(parseGpuNow(fixture("machine-stats/nvidia-smi-gb10-free-temp.txt"), 1)).toEqual({ free: null, temp: [49] });
  });

  test("readAccel on the spark (Linux, aarch64: cpuinfo has no model name): one unified GPU, the wire shape accepts it", async () => {
    const run = async (cmd: string[]) => (cmd[0] === "/usr/bin/nvidia-smi" ? fixture("machine-stats/nvidia-smi-gb10.txt") : null);
    const accel = await readAccel({ platform: "linux", run, exists: async (p) => p === "/usr/bin/nvidia-smi", readText: async () => fixture("machine-stats/cpuinfo-gb10-aarch64.txt") });
    expect(accel).toEqual({ chip: null, unified: false, gpu_limit: null, gpus: [GB10] });
    const wire = MachineAccel.parse(accel);
    expect(wire.gpus).toEqual([GB10]);
    // An older daemon's schema drops `unified` (zod strips unknown keys) and reads a GPU with no VRAM: still valid.
    expect(MachineAccel.safeParse({ chip: null, unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GB10", vram: 0 }] }).success).toBe(true);
    expect(MachineAccel.safeParse({ chip: null, unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GB10", vram: 0, unified: "yes" }] }).success).toBe(true); // a malformed flag is dropped alone
  });
});

describe("capacity: unified memory like Apple, sized from MemTotal", () => {
  const total = 127598832 * 1024; // /proc/meminfo MemTotal of both sparks
  const used = (127598832 - 118608400) * 1024; // MemTotal - MemAvailable captured on spark-115f

  test("free now = total - used - 1 GiB, if idle = total - 4 GiB, the whole of memory usable by the GPU; 273 GB/s", () => {
    const cap = machineCapacity(spark("spark-115f", A))!;
    expect(cap.kind).toBe("nvidia");
    expect(cap.label).toBe("NVIDIA GB10 · 122 GB unified");
    expect(cap.notes).toEqual([]); // not "No GPU found"
    expect(cap.backends.map((b) => [b.kind, b.memory])).toEqual([["nvidia", "unified memory"], ["cpu", "system memory (CPU)"]]);
    const gpu = cap.backends[0]!;
    expect(gpu.usable).toBe(total - used - RESERVE_BYTES);
    expect(gpu.usableIdle).toBe(total - IDLE_OS_BYTES);
    expect(gpu.measured).toBe(true);
    expect(gpu.bandwidth).toBe(273);
    expect(gpu.bandwidthKnown).toBe(true);
    expect(cap.bandwidth).toBe(273);
    expect(cap.usable).toBe(gpu.usable);
    // No Metal-style share: unlike an Apple Mac, nothing caps the GPU at 2/3 or 3/4 of memory.
    expect(gpu.usable).toBeGreaterThan(total * appleGpuShare(total));
    expect(cap.backends[1]!.bandwidth).toBe(DEFAULT_BW.cpu);
  });

  test("the same box as an older daemon reports it (no unified flag, no VRAM): the old answer, nothing worse", () => {
    const old = spark("old", A);
    const cap = machineCapacity({ ...old, stats: { ...old.stats!, accel: { chip: null, unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GB10", vram: 0 }] } } as MachineStats })!;
    expect(cap.backends[0]!.usable).toBe(0);
    expect(cap.backends[1]!.kind).toBe("cpu");
    expect(cap.usable).toBe(cap.backends[1]!.usable);
  });

  test("a busy spark (an agent running) is not offered as idle", () => {
    const n = spark("busy", A);
    const cap = machineCapacity({ ...n, stats: { ...n.stats!, agent_processes: [{ name: "claude-code", count: 3 }] } as MachineStats })!;
    expect(cap.backends[0]!.usableIdle).toBe(cap.backends[0]!.usable);
  });
});

describe("suggestions on a spark", () => {
  const cat = catalogOf([
    mk("moe-120b", { params_b: 120, active_b: 5, quality: rated(1.0) }),
    mk("dense-70b", { params_b: 70, quality: rated(0.5) }),
    mk("dense-9b", { params_b: 9, quality: rated(0.0) }),
  ]);

  test("runs on its unified memory at the GB10's bandwidth, not on the CPU", () => {
    const s = suggestTeam([spark("spark-115f", A, { self: true, rtt_ms: null })], { cat }).suggestions[0]!;
    const p = s.single!;
    expect(p.model.id).toBe("moe-120b");
    expect(p.placement[0]!.memory).toBe("unified memory");
    expect(p.tokensPerSec).toBeCloseTo(singleSpeed(bytesPerToken(p.model, p.quant, cat)!, 273), 6);
    expect(p.speed).toBe("fast"); // 5B of 120B read per token
    expect(s.alternatives.every((a) => !a.fits || a.placement[0]!.memory === "unified memory")).toBe(true);
  });

  test("two sparks on one LAN: the group rule (a peer answering within 5 ms) puts them together; farther apart they are not neighbours", () => {
    const near = groupMachines([spark("spark-115f", A, { self: true, rtt_ms: null }), spark("spark-0e86", B, { rtt_ms: 1 })]);
    expect(near.groups.map((g) => [g.kind, g.machines.map((m) => m.hostname)])).toEqual([["local", ["spark-115f", "spark-0e86"]]]);
    expect(near.groups[0]!.why).toBe("This machine and 1 other answer within 5 ms (slowest 1 ms): likely the same local network, close enough to split a model across");
    const far = groupMachines([spark("spark-115f", A, { self: true, rtt_ms: null }), spark("spark-0e86", B, { rtt_ms: 6 })]);
    expect(far.groups.map((g) => g.kind)).toEqual(["local", "single"]);
    // Together they hold more than either alone: both counted as unified memory.
    const t = suggestTeam([spark("spark-115f", A, { self: true, rtt_ms: null }), spark("spark-0e86", B, { rtt_ms: 1 })], { cat });
    expect(t.suggestions[0]!.usable).toBeGreaterThan(200 * GiB);
  });
});
