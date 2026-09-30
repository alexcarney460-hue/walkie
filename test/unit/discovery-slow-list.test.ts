import { afterEach, expect, spyOn, test } from "bun:test";
import { AgentDiscovery } from "../../src/daemon/discovery.ts";
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
