import { afterEach, expect, test } from "bun:test";
import { AgentDiscovery } from "../../src/daemon/discovery.ts";
import { ME, world } from "../helpers/discovery-world.ts";

const cleanups: Array<() => void> = [];
const RealWorker = globalThis.Worker;
const slow = new URL("../fixtures/discovery-files/slow-120-worker.ts", import.meta.url);
afterEach(() => { globalThis.Worker = RealWorker; for (const clean of cleanups.splice(0)) clean(); });

test("slow serial enrichment keeps ten census cards without worker churn", async () => {
  let constructed = 0;
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, opts?: WorkerOptions) {
      super(String(url).includes("discovery-files-worker") ? slow : url, opts);
      constructed++;
    }
  };
  for (const budget of [10_000, 1_000]) {
    const w = world(cleanups, { prompts: true, activity: true });
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 10; i++) {
      const pid = 2_000 + i;
      w.fx.procs.push({ pid, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000,
        command: "claude -p long-brief", cpuMs: 1_000 });
      w.fx.env.set(pid, { WALKIE_AGENT: `worker-${i}` });
      w.fx.cwds.set(pid, w.cwd);
    }
    const before = constructed;
    const d = new AgentDiscovery(w.core, { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} }, {
      provider: w.fx, uid: ME, now: () => w.clock.t, home: w.home, claudeConfigDir: w.cfg,
      scanBudgetMs: budget, concurrency: 6, share: { prompts: true, activity: true },
    });
    try {
      for (let i = 0; i < 4; i++) {
        w.clock.t += 15_000;
        await d.tick();
        const cards = w.core.store.agents().filter((row) => row.agent.startsWith("worker-") || row.agent.startsWith("claude-pid"));
        expect(cards).toHaveLength(10);
      }
      expect(constructed - before).toBe(1);
      console.log(`A8 budget=${budget} cards=10 workers=${constructed - before}`);
    } finally { d.stop(); }
  }
}, 30_000);
