// What discovery remembers about a process is dropped when the process exits, even when every scan is cut by its hard limit
// and never reaches its end (WALK-83, from Sonnet's see-load probe BK3: the cache grew 6, 60, 120, 240 under churn).
import { afterEach, expect, test } from "bun:test";
import { AgentDiscovery } from "../../src/daemon/discovery.ts";
import { ME, world } from "../helpers/discovery-world.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

test("exited processes leave the cache although every scan is cut by the hard limit", async () => {
  const w = world(cleanups, { prompts: false, activity: false });
  w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
  w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
  // Every provider read hangs, so the 1 ms budget's hard limit (200 ms) ends each scan before its end.
  w.fx.cwd = () => new Promise(() => {});
  w.fx.envVars = () => new Promise(() => {});
  w.fx.claudeSession = () => new Promise(() => {});
  w.fx.openFiles = () => new Promise(() => {});
  const d = new AgentDiscovery(w.core, { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} }, {
    provider: w.fx, uid: ME, now: () => w.clock.t, home: w.home, claudeConfigDir: w.cfg,
    scanBudgetMs: 1, concurrency: 6, share: { prompts: false, activity: false },
  });
  const cache = (d as unknown as { cache: Map<string, unknown> }).cache;
  try {
    for (let tick = 0; tick < 5; tick++) {
      w.fx.procs = w.fx.procs.filter((p) => p.pid < 2_000);
      for (let i = 0; i < 6; i++) {
        const pid = 2_000 + tick * 10 + i; // every tick: six new processes, the previous six gone
        w.fx.procs.push({ pid, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "claude -p long-brief", cpuMs: 1_000 });
      }
      w.clock.t += 15_000;
      await d.tick();
      expect(cache.size).toBeLessThanOrEqual(6);
    }
    expect(w.core.discoveryHealth?.incomplete).toBe(true); // the scans really were cut short, not finished
  } finally { d.stop(); }
}, 20_000);
