import { afterEach, expect, spyOn, test } from "bun:test";
import { AgentDiscovery } from "../../src/daemon/discovery.ts";
import { loadUnknown } from "../../src/protocol/machine-stats.ts";
import { machineCapacity } from "../../src/pool/capacity.ts";
import { ME, world } from "../helpers/discovery-world.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

test("a 2.5 second process list still produces cards", async () => {
  const w = world(cleanups, { prompts: false, activity: false });
  w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
  const original = w.fx.list.bind(w.fx);
  w.fx.list = async () => { await Bun.sleep(2_500); return original(); };
  const d = w.disc();
  try {
    await d.tick();
    expect(w.core.store.agents()).toHaveLength(1);
    expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
  } finally { d.stop(); }
}, 10_000);

test("a failed process list retains the previous census and marks it stale", async () => {
  const w = world(cleanups);
  w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
  const warnings: string[] = [];
  const d = new AgentDiscovery(w.core, { debug: () => {}, info: () => {}, error: () => {},
    warn: (message) => { warnings.push(message); } }, {
    provider: w.fx, uid: ME, now: () => w.clock.t, home: w.home, claudeConfigDir: w.cfg,
  });
  const changed = spyOn(w.core.hub, "nodesChanged");
  try {
    await d.tick();
    changed.mockClear();
    const prior = w.core.publishedStats()?.agent_processes;
    w.fx.failList = "null";
    await d.tick();
    expect(w.core.publishedStats()?.agent_processes).toEqual(prior);
    expect(w.core.publishedStats()?.discovery).toMatchObject({ incomplete: true, stale: true });
    expect(warnings).toContain("agent_discovery_scan_failed");
    expect(changed).toHaveBeenCalledTimes(1);
    w.fx.failList = null;
    await d.tick();
    expect(w.core.publishedStats()?.discovery?.stale).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { d.stop(); changed.mockRestore(); }
});

test("a census that keeps failing is held for five minutes, then its counts become unknown", async () => {
  const w = world(cleanups);
  w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
  const d = w.disc();
  const changed = spyOn(w.core.hub, "nodesChanged");
  try {
    await d.tick();
    const prior = w.core.publishedStats()?.agent_processes;
    expect(prior).toEqual([{ name: "claude-code", count: 1 }]);
    w.fx.failList = "null";
    w.clock.t += 60_000;
    await d.tick();
    w.clock.t += 3 * 60_000; // four minutes since the last good census
    await d.tick();
    expect(w.core.publishedStats()?.agent_processes).toEqual(prior);
    expect(w.core.publishedStats()?.discovery).toMatchObject({ incomplete: true, stale: true });
    changed.mockClear();
    w.clock.t += 60_000; // five minutes
    await d.tick();
    expect(w.core.publishedStats()?.agent_processes).toBeUndefined();
    expect(w.core.publishedStats()?.discovery).toMatchObject({ incomplete: true, stale: true });
    expect(changed).toHaveBeenCalledTimes(1);
    w.clock.t += 10 * 60_000;
    await d.tick();
    expect(w.core.publishedStats()?.agent_processes).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1); // nothing changes again while it keeps failing
    w.fx.failList = null;
    await d.tick();
    expect(w.core.publishedStats()?.agent_processes).toEqual(prior);
    expect(w.core.publishedStats()?.discovery?.stale).toBeUndefined();
  } finally { d.stop(); changed.mockRestore(); }
});

test("a process list that fails from the very first scan is flagged stale at once: load unknown, never idle capacity", async () => {
  const w = world(cleanups);
  const GIB = 1024 ** 3;
  w.core.machineStats = { at: w.clock.t, mem: { total: 16 * GIB, used: 12 * GIB, swap_used: 0, pressure: "normal" }, temp_c: null,
    sys: { os: "linux", arch: "arm64", cpus: 20, load1: 0.5, load5: 0.5, load15: 0.5, cpu_busy_pct: 4 } };
  w.fx.failList = "null";
  const d = w.disc();
  const changed = spyOn(w.core.hub, "nodesChanged");
  try {
    expect(w.core.publishedStats()?.discovery).toBeUndefined(); // before any scan nothing is claimed
    await d.tick();
    const published = w.core.publishedStats();
    expect(published?.agent_processes).toBeUndefined();
    expect(published?.discovery).toMatchObject({ incomplete: true, stale: true });
    expect(loadUnknown(published)).toBe(true);
    const capacity = machineCapacity({ node_id: "n", hostname: "h", handle: "alex", stats: published ?? undefined })!;
    expect(capacity.usableIdle).toBe(capacity.usable);
    expect(capacity.notes).toContain("Machine load unknown (agent discovery is stale): idle capacity is unavailable");
    expect(changed).toHaveBeenCalledTimes(1);
    w.clock.t += 60_000;
    await d.tick();
    expect(changed).toHaveBeenCalledTimes(1); // nothing changes again while it keeps failing
    w.fx.failList = null;
    await d.tick();
    expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
    expect(w.core.publishedStats()?.discovery?.stale).toBeUndefined();
    expect(loadUnknown(w.core.publishedStats())).toBe(false);
  } finally { d.stop(); changed.mockRestore(); }
});
