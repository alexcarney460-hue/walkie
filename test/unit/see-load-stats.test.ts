import { afterEach, expect, test } from "bun:test";
import { CpuBusyTracker, hostSys, shouldPublish } from "../../src/daemon/machine-stats/sampler.ts";
import { machineBusy, MachineStats } from "../../src/protocol/machine-stats.ts";
import { ME, world } from "../helpers/discovery-world.ts";
import { machineCapacity } from "../../src/pool/capacity.ts";
import { teamViewJson } from "../../src/cli/agent-output.ts";
import type { TeamView } from "../../src/protocol/schemas.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

test("load crossing the busy threshold publishes promptly, with a short transition limit", () => {
  const sys = { os: "darwin" as const, arch: "arm64" as const, cpus: 8, load1: 5.92, cpu_busy_pct: null };
  const prev = { at: 100_000, mem: null, temp_c: null, sys };
  const next = { mem: null, temp_c: null, sys: { ...sys, load1: 6.08 } };
  expect(shouldPublish(prev, next, 103_000)).toBe(false);
  expect(shouldPublish(prev, next, 111_000)).toBe(true);
  expect(shouldPublish({ ...prev, at: 100_000, sys: next.sys }, { ...next, sys }, 111_000)).toBe(true);
});

test("a busy multi-GPU machine limits the first device's idle capacity to its measured free capacity", () => {
  const GiB = 1024 ** 3;
  const stats: MachineStats = {
    at: 1, temp_c: null, mem: { total: 64 * GiB, used: 32 * GiB, swap_used: 0, pressure: "normal" },
    accel: { chip: "x86", unified: false, gpu_limit: null, gpus: [
      { name: "NVIDIA RTX 5070", vram: 12 * GiB }, { name: "NVIDIA RTX 5070", vram: 12 * GiB },
    ] }, gpu_free: [6 * GiB, 6 * GiB], agent_processes: [{ name: "claude-code", count: 22 }],
  };
  const input = { node_id: "n", hostname: "loaded", handle: "alex" };
  const idle = machineCapacity({ ...input, stats: { ...stats, agent_processes: [] } })!;
  const busy = machineCapacity({ ...input, stats })!;
  expect(idle.backends[0]?.device?.usableIdle).toBeGreaterThan(idle.backends[0]?.device?.usable ?? 0);
  expect(busy.backends[0]?.device?.usableIdle).toBe(busy.backends[0]?.device?.usable);
});

test("the cheap census publishes agent counts with the machine row", async () => {
  const w = world(cleanups);
  w.fx.procs.push({ pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "codex exec task", cpuMs: 1 });
  w.core.machineStats = { at: w.clock.t, mem: { total: 16, used: 12, swap_used: 0, pressure: "normal" }, temp_c: null };
  await w.disc({ scanBudgetMs: 1 }).tick();
  expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }, { name: "codex", count: 1 }]);
  expect(MachineStats.parse(w.core.publishedStats()).agent_processes).toHaveLength(2);
});

test("CPU busy is a delta, and optional load fields survive the wire parser", () => {
  const samples = [
    [{ times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }],
    [{ times: { user: 50, nice: 0, sys: 30, idle: 120, irq: 0 } }],
  ];
  const tracker = new CpuBusyTracker(() => samples.shift() ?? []);
  expect(tracker.sample()).toBeNull();
  expect(tracker.sample()).toBe(60);
  const sys = hostSys();
  expect(sys).toHaveProperty("load5");
  expect(sys).toHaveProperty("load15");
  const parsed = MachineStats.parse({ at: 1, mem: { total: 16, used: 12, free: 4, swap_used: 0, pressure: "normal" }, temp_c: null,
    sys: { os: "darwin", arch: "arm64", cpus: 14, load1: 146, load5: 296, load15: 373, cpu_busy_pct: 91 },
    agent_processes: [{ name: "claude-code", count: 22 }] });
  expect(parsed.mem?.free).toBe(4);
  expect(parsed.sys?.cpu_busy_pct).toBe(91);
  expect(machineBusy(parsed)).toBe(true);
  const capacity = machineCapacity({ node_id: "n", hostname: "loaded", handle: "alex", stats: {
    ...parsed, mem: { total: 16 * 1024 ** 3, used: 12 * 1024 ** 3, swap_used: 0, pressure: "normal" },
  } })!;
  expect(capacity.usableIdle).toBe(capacity.usable);
  expect(capacity.notes).toContain("Machine busy: idle capacity is unavailable");
  const team = { id: "t", name: "team", authority: null, members: [], channels: [], nodes: [{
    node_id: "n", hostname: "loaded", handle: "alex", online: true, last_seen: 1, rtt_ms: 1, self: false,
    sync: { behind: 0, last_sync: 1 }, stats: parsed,
  }] } as unknown as TeamView;
  expect(teamViewJson(team).nodes[0]?.stats?.agent_processes).toEqual([{ name: "claude-code", count: 22 }]);
  expect(teamViewJson(team).nodes[0]?.stats?.sys?.load15).toBe(373);
});
