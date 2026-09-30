import { afterEach, expect, test } from "bun:test";
import { ME, world } from "../helpers/discovery-world.ts";
import { AgentDiscovery } from "../../src/daemon/discovery.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

for (const scenario of [
  { label: "22 slow cwd", workers: 22, budget: 1_000, cwdMs: 400, envMs: 25, concurrency: 6, hang: false, incomplete: true },
  { label: "22 at 1 ms", workers: 22, budget: 1, cwdMs: 0, envMs: 25, concurrency: 1, hang: false, incomplete: true },
  { label: "25 hanging providers", workers: 25, budget: 10_000, cwdMs: 0, envMs: 0, concurrency: 6, hang: true, incomplete: false },
  { label: "60 hanging providers", workers: 60, budget: 10_000, cwdMs: 0, envMs: 0, concurrency: 6, hang: true, incomplete: true },
] as const) {
  test(`census cards survive ${scenario.label}`, async () => {
    const w = world(cleanups, { prompts: false, activity: false });
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < scenario.workers; i++) {
      const pid = 2_000 + i;
      w.fx.procs.push({ pid, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000,
        command: "claude -p long-brief", cpuMs: 1_000 });
      w.fx.env.set(pid, { WALKIE_AGENT: `worker-${i}` });
      w.fx.cwds.set(pid, w.cwd);
    }
    const cwd = w.fx.cwd.bind(w.fx);
    const env = w.fx.envVars.bind(w.fx);
    w.fx.cwd = scenario.hang ? () => new Promise(() => {})
      : async (pid) => { await Bun.sleep(scenario.cwdMs); return cwd(pid); };
    w.fx.envVars = scenario.hang ? () => new Promise(() => {})
      : async (pids, names) => { await Bun.sleep(scenario.envMs); return env(pids, names); };
    if (scenario.hang) {
      w.fx.claudeSession = () => new Promise(() => {});
      w.fx.openFiles = () => new Promise(() => {});
    }
    const d = new AgentDiscovery(w.core, { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} }, {
      provider: w.fx, uid: ME, now: () => w.clock.t, home: w.home, claudeConfigDir: w.cfg,
      scanBudgetMs: scenario.budget, concurrency: scenario.concurrency,
      share: { prompts: false, activity: false },
    });
    try {
      await d.tick();
      const cards = w.core.store.agents().filter((row) => row.agent.startsWith("claude-pid") || row.agent.startsWith("worker-"));
      expect(cards).toHaveLength(scenario.workers);
      expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: scenario.workers }]);
      expect(w.core.discoveryHealth?.incomplete ?? false).toBe(scenario.incomplete);
      if (scenario.incomplete) expect(w.core.discoveryHealth?.unreported).toBeGreaterThan(0);
    } finally { d.stop(); }
  }, 60_000);
}
