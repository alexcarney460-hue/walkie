import { expect, test } from "bun:test";
import { machineCapacity, CPU_MEMORY, DEFAULT_BW, serveBudget } from "../../src/pool/capacity.ts";
import { deviceSlot, suggestTeam, EFFICIENCY } from "../../src/pool/suggest.ts";
import { cpuOnly, planRun, serveHosts } from "../../src/pool/run/plan.ts";
import { capped, suggestCombined } from "../../src/pool/combined.ts";
import { targetFor } from "../../src/pool/run/runtime.ts";
import type { GroupInput } from "../../src/pool/group.ts";
import type { MachineSys } from "../../src/protocol/machine-stats.ts";
import { catalogOf, mk } from "../helpers/pool-catalog.ts";
import { bytesPerToken } from "../../src/pool/catalog.ts";
import { PoolServer } from "../../src/pool/run/serve.ts";
import { PoolJobs } from "../../src/pool/run/jobs.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GiB = 1024 ** 3;
function node(id: string, os: MachineSys["os"] = "linux", arch: MachineSys["arch"] = "arm64", unified = true): GroupInput {
  return { node_id: id, hostname: id, handle: "fixture", online: true, self: false, rtt_ms: 1,
    pool: { share: true, runtime: true, busy: false, cap: null, serve: true },
    stats: { at: 1, temp_c: null,
      sys: { os, arch, cpus: 20, load1: 0 },
      mem: { total: 128 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" },
      accel: { chip: os === "darwin" ? "Apple M4 Max" : null, unified: os === "darwin", gpu_limit: null,
        gpus: os === "darwin" ? [] : [{ name: unified ? "NVIDIA GB10" : "NVIDIA RTX 4090", vram: unified ? 0 : 24 * GiB, unified }] },
      gpu_free: unified ? undefined : [20 * GiB] } };
}

for (const unified of [true, false]) test(`arm64 NVIDIA ${unified ? "unified" : "dedicated"}: CPU runtime, no GPU serving`, () => {
  const n = node("arm-worker", "linux", "arm64", unified);
  const c = machineCapacity(n)!;
  expect(targetFor({ platform: "linux", arch: "arm64", nvidia: true })?.id).toBe("linux-arm64");
  expect(c.kind).toBe("nvidia");
  expect(deviceSlot(c).b.memory).toBe(CPU_MEMORY);
  expect(deviceSlot(c).b.bandwidth).toBe(DEFAULT_BW.cpu);
  expect(deviceSlot(c).b.usable).toBe(119 * GiB);
  expect(cpuOnly(n)).toBe(true);
  expect(serveBudget(c)).toBeNull();
  expect(serveHosts([n, { ...n, self: true }], GiB)).toEqual([]);
});

for (const [os, arch, kind] of [["linux", "x64", "nvidia"], ["darwin", "arm64", "apple"]] as const) {
  test(`${os}/${arch} retains GPU placement and serving`, () => {
    const n = node("gpu", os, arch, false);
    expect(deviceSlot(machineCapacity(n)!).b.kind).toBe(kind);
    expect(cpuOnly(n)).toBe(false);
    expect(serveHosts([n], GiB)).toHaveLength(1);
  });
}

test("missing and unsupported system metadata never promises GPU serving", () => {
  for (const n of [node("unknown"), node("unsupported", "win32", "x64")]) {
    const unknown = n.hostname === "unknown" ? { ...n, stats: { ...n.stats!, sys: undefined } } : n;
    expect(deviceSlot(machineCapacity(unknown)!).b.kind).toBe("cpu");
    expect(serveHosts([unknown], GiB)).toEqual([]);
  }
});

test("runtime CPU head holds no layers; worker placement and speed use CPU while generic hardware suggestions stay GPU", () => {
  const head = { ...node("head"), self: true };
  const worker = node("worker");
  const cat = catalogOf([mk("fixture-8b", { params_b: 8 })]);
  const result = suggestCombined([head, worker], { cat });
  const run = result.runnable!;
  expect(run).not.toBeNull();
  expect(run.placement.map(p => [p.hostname, p.memory])).toEqual([["worker", CPU_MEMORY]]);
  expect(run.computeMs).toBeCloseTo(bytesPerToken(run.model, run.quant, cat)! / (EFFICIENCY * DEFAULT_BW.cpu * 1e9) * 1000, 6);
  expect(result.runnableNote).toContain("CPU");
  const plan = planRun([head, worker], run.need);
  expect(plan.stages[0]!.model_bytes).toBe(0);
  expect(plan.stages[1]!.hostname).toBe("worker");
  expect(suggestTeam([head], { cat }).machines[0]!.best!.placement[0]!.memory).toBe("unified memory");
  expect(suggestCombined([head], { cat }).runnable).toBeNull();
});

test("CPU head named alone is refused; a capped CPU worker holds the named run", () => {
  const head = { ...node("head"), self: true };
  expect(() => planRun([head], GiB, ["head"])).toThrow("cannot place layers");
  const worker = node("worker");
  const limited = { ...worker, pool: { ...worker.pool!, cap: 5 * GiB } };
  const plan = planRun([head, limited], 2 * GiB, ["worker"]);
  expect(plan.stages[0]!.model_bytes).toBe(0);
  expect(plan.stages[1]!.bytes).toBeLessThanOrEqual(5 * GiB);
  expect(deviceSlot(capped(machineCapacity(limited)!, 5 * GiB)).b.usable).toBe(5 * GiB);
});

test("CUDA device placement respects the cap; serving retains all GPUs' measured memory", () => {
  const n = node("cuda", "linux", "x64", false);
  const multi = { ...n, stats: { ...n.stats!, accel: { ...n.stats!.accel!, gpus: [
    { name: "NVIDIA RTX 4090", vram: 24 * GiB }, { name: "NVIDIA RTX 4090", vram: 24 * GiB },
  ] }, gpu_free: [20 * GiB, 20 * GiB] } };
  const c = machineCapacity(multi)!;
  expect(serveBudget(c)).toBe(39 * GiB);
  expect(deviceSlot(c).b.usable).toBe(19.5 * GiB);
  expect(deviceSlot(capped(c, 3 * GiB)).b.usable).toBe(3 * GiB);
  expect(serveBudget(capped(c, 3 * GiB))).toBe(3 * GiB);
});

test("effective accelerator policy agrees with every pinned target's backend", () => {
  for (const [os, arch, nvidia, kind] of [
    ["linux", "arm64", true, "cpu"], ["linux", "x64", true, "nvidia"],
    ["linux", "x64", false, "cpu"], ["darwin", "arm64", false, "apple"],
    ["darwin", "x64", false, "cpu"],
  ] as const) {
    const n = node("target", os, arch, false);
    const input = os === "linux" && !nvidia ? { ...n, stats: { ...n.stats!, accel: undefined } } : n;
    expect(targetFor({ platform: os, arch, nvidia })).not.toBeNull();
    expect(deviceSlot(machineCapacity(input)!).b.kind).toBe(kind);
  }
});

test("partially reported system metadata cannot imply a GPU runtime", () => {
  const n = node("partial", "linux", "x64", false);
  for (const sys of [{ os: "linux" }, { arch: "x64" }, {}]) {
    // Exercise incomplete wire data directly, before schema validation can discard it.
    const input = { ...n, stats: { ...n.stats!, sys: sys as unknown as MachineSys } };
    expect(deviceSlot(machineCapacity(input)!).b.kind).toBe("cpu");
    expect(serveHosts([input], GiB)).toEqual([]);
  }
});

test("mixed Metal head and capped arm64 worker use their respective runtime backends", () => {
  const mac = node("metal-head", "darwin", "arm64");
  const head = { ...mac, self: true, stats: { ...mac.stats!, mem: { ...mac.stats!.mem!, total: 16 * GiB, used: 8 * GiB } } };
  const arm = node("cpu-worker");
  const worker = { ...arm, pool: { ...arm.pool!, cap: 80 * GiB } };
  const cat = catalogOf([mk("fixture-70b", { params_b: 70 })]);
  const result = suggestCombined([head, worker], { cat });
  expect(result.runnable!.placement.map(p => [p.hostname, p.memory])).toEqual([
    ["metal-head", "unified memory"], ["cpu-worker", CPU_MEMORY],
  ]);
  expect(result.runnable!.tokensPerSec).toBeLessThan(result.pick!.tokensPerSec);
  const plan = planRun([head, worker], result.runnable!.need);
  expect(plan.stages[1]!.bytes).toBeLessThanOrEqual(80 * GiB);
  expect(serveHosts([head, worker], GiB).map(h => h.node.hostname)).toEqual(["metal-head"]);
});

test("unnamed CPU head refusal explains runtime placement instead of missing stats", () => {
  expect(() => planRun([{ ...node("cpu-head"), self: true }], GiB)).toThrow("cannot place layers on this head");
});

test("daemon rejects CPU GPU-serving and capped CUDA before download, releasing its job", async () => {
  const home = mkdtempSync(join(tmpdir(), "runtime-refusal-"));
  try {
    for (const [input, cap, message] of [
      [node("cpu-worker"), null, "the pinned runtime has no usable GPU"],
      [node("cuda-worker", "linux", "x64", false), 0, "within its owner's cap"],
    ] as const) {
      const jobs = new PoolJobs();
      const server = new PoolServer({ home, jobs, log: createLogger({}),
        // Presence-only sentinel paths: no binary is installed or executed by this refusal path.
        runtime: () => ({ dir: home, server: join(home, "absent-server"), rpc: join(home, "absent-rpc") }),
        share: () => ({ on: true, maxBytes: cap }), mayUse: () => true, hostnameOf: id => id,
        stats: async () => input.stats!, changed: () => {},
      });
      await expect(server.start("llama-3.1-8b", "q8", "fixture-peer")).rejects.toThrow(message);
      expect(jobs.busy()).toBe(false);
      expect(server.active()).toBe(false);
      expect(server.view()).toBeNull();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
