import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as accel from "../../src/daemon/machine-stats/accel.ts";
import { ConfigSchema } from "../../src/daemon/config.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { MachineStats } from "../../src/protocol/machine-stats.ts";
import type { GroupInput } from "../../src/pool/group.ts";
import { PoolService } from "../../src/pool/run/service.ts";
import type { ShareConfig } from "../../src/pool/run/stage.ts";
import { planRun } from "../../src/pool/run/plan.ts";

const GiB = 1024 ** 3;

function stats(arch: "arm64" | "x64" = "arm64", unified = false): MachineStats {
  return { at: Date.now(), temp_c: null, sys: { os: "linux", arch, cpus: 20, load1: 0 },
    mem: { total: 128 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" },
    accel: { chip: null, unified: false, gpu_limit: null,
      gpus: [{ name: unified ? "NVIDIA GB10" : "NVIDIA RTX 4090", vram: unified ? 0 : 24 * GiB, unified }] },
    ...(unified ? {} : { gpu_free: [20 * GiB] }),
  };
}

function node(id: string, reading: MachineStats, self = false): GroupInput {
  return { node_id: id, hostname: id, handle: "fixture", online: true, self, rtt_ms: 1, stats: reading,
    pool: { share: true, runtime: true, busy: false, cap: null, serve: true } };
}

async function stageBudget(reading: MachineStats | null, maxBytes: number | null = null, unknownMemory = false): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "stage-budget-"));
  // Keep the production callback and its stage reserve/cap calculation; only the hardware probe is replaced.
  const probe = spyOn(accel, "readGpuNow").mockResolvedValue({ free: null, temp: null });
  const unexpectedPeer = async (): Promise<never> => { throw new Error("budget fixture must not contact a peer"); };
  try {
    const service = new PoolService({ home, configPath: join(home, "config.json"),
      config: ConfigSchema.parse({ pool_share: true }), log: createLogger({}),
      mayHead: () => true, hostnameOf: id => id, stats: () => reading, changed: () => {},
      stage: unexpectedPeer, tunnel: unexpectedPeer, serve: unexpectedPeer, tunnelTo: unexpectedPeer,
    }, { ...(unknownMemory ? { freeMemory: async () => null } : {}),
      hfFetch: Object.assign(unexpectedPeer, { preconnect: () => { throw new Error("budget fixture must not preconnect"); } }),
    });
    // Exercise only admission's budget, before runtime verification, process launch, or any RPC guard/tunnel.
    const stage = service.stages as unknown as { budget(share: ShareConfig): Promise<number> };
    try { return await stage.budget({ on: true, maxBytes }); }
    finally {
      expect(probe).toHaveBeenCalledTimes(reading?.accel?.gpus.length ? 1 : 0);
      expect(service.jobs.busy()).toBe(false);
      expect(service.stages.busy()).toBe(false);
    }
  } finally {
    probe.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
}

test("arm64 discrete NVIDIA stage budget admits the CPU placement planned above its VRAM", async () => {
  const reading = stats();
  const plan = planRun([node("cpu-head", reading, true), node("cpu-worker", reading)], 40 * GiB);
  const stage = plan.stages.find(s => !s.self)!;
  expect(stage.bytes).toBeGreaterThan(19.5 * GiB);
  const budget = await stageBudget(reading);
  expect(budget).toBe(119 * GiB);
  expect(stage.bytes).toBeLessThanOrEqual(budget);
});

test("arm64 unified NVIDIA stage keeps the CPU memory budget", async () => {
  expect(await stageBudget(stats("arm64", true))).toBe(119 * GiB);
});

test("missing or unsupported runtime metadata cannot select the NVIDIA budget", async () => {
  const reading = stats("x64");
  for (const sys of [undefined, { ...reading.sys!, os: "win32" as const }]) {
    expect(await stageBudget({ ...reading, sys })).toBe(119 * GiB);
  }
});

test("CPU runtime stage remains limited by the owner cap including zero", async () => {
  for (const [cap, expected] of [[5, 5], [0, 0], [125, 119]] as const) {
    expect(await stageBudget(stats(), cap * GiB)).toBe(expected * GiB);
  }
});

test("CPU runtime stage uses current system memory even when VRAM has more room", async () => {
  const reading = stats();
  expect(await stageBudget({ ...reading, mem: { ...reading.mem!, used: 126 * GiB } })).toBe(GiB);
});

test("CUDA stage retains first-device VRAM instead of aggregate VRAM or system memory", async () => {
  const reading = stats("x64");
  const twoGpus = { ...reading, mem: { ...reading.mem!, used: 121 * GiB },
    accel: { ...reading.accel!, gpus: [...reading.accel!.gpus, ...reading.accel!.gpus] }, gpu_free: [20 * GiB, 20 * GiB] };
  expect(await stageBudget(twoGpus)).toBe(19.5 * GiB);
});

test("CUDA stage keeps the owner cap including zero", async () => {
  expect(await stageBudget(stats("x64"), 5 * GiB)).toBe(5 * GiB);
  expect(await stageBudget(stats("x64"), 0)).toBe(0);
});

test("unknown CPU memory still requires an explicit owner cap", async () => {
  await expect(stageBudget(null, null, true)).rejects.toMatchObject({ status: 503, code: "memory_unknown" });
  expect(await stageBudget(null, 5 * GiB, true)).toBe(5 * GiB);
});
