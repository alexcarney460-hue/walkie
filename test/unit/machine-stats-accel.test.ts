// WALKIE-POOL-LLM-1 B1: accelerator facts (chip, unified memory, GPU limit, NVIDIA GPUs) for local-model suggestions.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hwName, parseCpuinfo, parseDarwinAccel, parseNvidiaSmi, readAccel } from "../../src/daemon/machine-stats/accel.ts";
import { MachineStatsSampler } from "../../src/daemon/machine-stats/sampler.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { MachineAccel, MachineStats } from "../../src/protocol/machine-stats.ts";
import { PeerVvRes } from "../../src/protocol/schemas.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const FIX = join(import.meta.dir, "..", "fixtures", "machine-stats");

describe("parsers", () => {
  test("macOS sysctls: chip, Apple Silicon = unified, a user-set GPU limit (0 = default)", () => {
    expect(parseDarwinAccel("Apple M5\n", "1\n", "0\n")).toEqual({ chip: "Apple M5", unified: true, gpu_limit: null });
    expect(parseDarwinAccel("Apple M2 Ultra", "1", "180000")).toEqual({ chip: "Apple M2 Ultra", unified: true, gpu_limit: 180000 * MiB });
    // Intel Mac: no hw.optional.arm64 (sysctl fails → null), no iogpu OID.
    expect(parseDarwinAccel("Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz", null, null)).toEqual({ chip: "Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz", unified: false, gpu_limit: null });
    expect(parseDarwinAccel(null, "0", "junk").gpu_limit).toBeNull();
  });

  test("nvidia-smi CSV (recorded on a WSL laptop): name and VRAM in bytes; junk and >8 GPUs bounded", () => {
    expect(parseNvidiaSmi(readFileSync(join(FIX, "nvidia-smi-wsl.txt"), "utf8"))).toEqual([{ name: "NVIDIA GeForce RTX 5070 Laptop GPU", vram: 8151 * MiB }]);
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 3090, 24576\n")).toHaveLength(2);
    expect(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")).toEqual([]);
    expect(parseNvidiaSmi("GPU, [N/A]\n, 100\nGPU, -5")).toEqual([]);
    expect(parseNvidiaSmi(Array.from({ length: 12 }, (_, i) => `NVIDIA H100 ${i}, 81559`).join("\n"))).toHaveLength(8);
    expect(parseNvidiaSmi(null)).toEqual([]);
  });

  test("/proc/cpuinfo model name (x86) or Model (Arm); names are printable ASCII ≤ 64", () => {
    expect(parseCpuinfo("processor\t: 0\nmodel name\t: Intel(R) Core(TM) 7 240H\n")).toBe("Intel(R) Core(TM) 7 240H");
    expect(parseCpuinfo("processor : 0\nModel : Raspberry Pi 5 Model B Rev 1.0\n")).toBe("Raspberry Pi 5 Model B Rev 1.0");
    expect(parseCpuinfo("")).toBeNull();
    expect(hwName("Apple\u001b[31m M5\u0000")).toBe("Apple [31m M5");
    expect(hwName("x".repeat(100))).toHaveLength(64);
    expect(hwName("   ")).toBeNull();
  });
});

describe("readAccel", () => {
  test("macOS: one sysctl per OID, nvidia-smi only when installed", async () => {
    const calls: string[][] = [];
    const run = async (cmd: string[]) => {
      calls.push(cmd);
      const oid = cmd[2];
      return oid === "machdep.cpu.brand_string" ? "Apple M4 Pro\n" : oid === "hw.optional.arm64" ? "1\n" : null;
    };
    const a = await readAccel({ platform: "darwin", run, exists: async () => false });
    expect(a).toEqual({ chip: "Apple M4 Pro", unified: true, gpu_limit: null, gpus: [] });
    expect(calls.every((c) => c.length === 3 && c[0] === "/usr/sbin/sysctl" && c[1] === "-n")).toBe(true);
  });

  test("Linux/WSL: cpuinfo + the WSL nvidia-smi", async () => {
    const run = async (cmd: string[]) => (cmd[0] === "/usr/lib/wsl/lib/nvidia-smi" ? "NVIDIA GeForce RTX 5070 Laptop GPU, 8151\n" : null);
    const a = await readAccel({
      platform: "linux", run, exists: async (p) => p === "/usr/lib/wsl/lib/nvidia-smi",
      readText: async () => "model name\t: Intel(R) Core(TM) 7 240H\n",
    });
    expect(a).toEqual({ chip: "Intel(R) Core(TM) 7 240H", unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GeForce RTX 5070 Laptop GPU", vram: 8151 * MiB }] });
    expect(MachineAccel.safeParse(a).success).toBe(true);
  });

  test("other platforms: none", async () => {
    expect(await readAccel({ platform: "win32" })).toBeNull();
  });

  test.if(process.platform === "darwin")("this Mac (real sysctl): chip name and unified memory", async () => {
    const a = await readAccel();
    expect(a?.chip).toMatch(/^Apple M\d/);
    expect(a?.unified).toBe(true);
    expect(MachineAccel.safeParse(a).success).toBe(true);
  });
});

describe("publishing and the wire", () => {
  const mem = { total: 16 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" as const };
  const accel = { chip: "Apple M5", unified: true, gpu_limit: null, gpus: [] };

  test("read once on the first tick, carried on every snapshot", async () => {
    let reads = 0;
    const published: MachineStats[] = [];
    let now = 0;
    let temp = 50;
    const s = new MachineStatsSampler((st) => published.push(st), createLogger({}), {
      read: async () => ({ mem, temp_c: temp }), readAccel: async () => { reads++; return accel; }, clock: () => now,
    });
    await s.tick();
    now += 30_000; temp = 60;
    await s.tick();
    expect(reads).toBe(1);
    expect(published).toHaveLength(2);
    expect(published.every((p) => p.accel?.chip === "Apple M5")).toBe(true);
  });

  test("a failing accel read publishes the stats without it", async () => {
    const published: MachineStats[] = [];
    const s = new MachineStatsSampler((st) => published.push(st), createLogger({}), {
      read: async () => ({ mem, temp_c: 50 }), readAccel: async () => { throw new Error("sysctl gone"); },
    });
    await s.tick();
    expect(published[0]?.mem).toEqual({ ...mem, free: 8 * 1024 ** 3 });
    expect(published[0] && "accel" in published[0]).toBe(false);
  });

  test("a malformed accel from a peer is dropped; memory and temperature are kept", () => {
    const bad = [
      { ...accel, chip: "Apple M5\u001b]0;pwned\u0007" }, { ...accel, chip: "x".repeat(65) }, { ...accel, unified: "yes" },
      { ...accel, gpus: Array.from({ length: 9 }, () => ({ name: "GPU", vram: GiB })) }, { ...accel, gpus: [{ name: "GPU", vram: -1 }] },
      { ...accel, gpu_limit: 2 ** 60 }, "M5",
    ];
    for (const a of bad) {
      const r = PeerVvRes.parse({ node: "n", vv: {}, ts: 1, stats: { at: 1, mem, temp_c: 50, accel: a } });
      expect(r.stats?.mem).toEqual(mem);
      expect(r.stats?.accel).toBeUndefined();
    }
    const good = PeerVvRes.parse({ node: "n", vv: {}, ts: 1, stats: { at: 1, mem, temp_c: 50, accel } });
    expect(good.stats?.accel).toEqual(accel);
  });

  test("a malformed discovery health (MISSION-1) is dropped the same way; the rest of the snapshot is kept", () => {
    for (const d of [{ incomplete: "yes", unreported: 1 }, { incomplete: true, unreported: -1 }, { incomplete: true, unreported: 2 ** 40 }, "partial"]) {
      const r = PeerVvRes.parse({ node: "n", vv: {}, ts: 1, stats: { at: 1, mem, temp_c: 50, accel, discovery: d } });
      expect(r.stats?.mem).toEqual(mem);
      expect(r.stats?.accel).toEqual(accel);
      expect(r.stats?.discovery).toBeUndefined();
    }
    const ok = PeerVvRes.parse({ node: "n", vv: {}, ts: 1, stats: { at: 1, mem, temp_c: 50, discovery: { incomplete: true, unreported: 3 } } });
    expect(ok.stats?.discovery).toEqual({ incomplete: true, unreported: 3 });
  });
});
