import { afterEach, describe, expect, test } from "bun:test";
import { hook, ME, status, world } from "../helpers/discovery-world.ts";
import { CWD_REFRESH_MS } from "../../src/daemon/discovery.ts";
import { AgentDiscovery } from "../../src/daemon/discovery.ts";
import type { NodeView, StreamMessage } from "../../src/protocol/schemas.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

describe("cheap agent census", () => {
  test("recurring scan warnings are limited per kind and report suppressed repeats", async () => {
    const w = world(cleanups);
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const log = { debug: () => {}, info: () => {}, error: () => {}, warn: (message: string, data?: Record<string, unknown>) => { warnings.push({ message, data }); } };
    const d = new AgentDiscovery(w.core, log, { provider: w.fx, uid: ME, now: () => w.clock.t, home: w.home, claudeConfigDir: w.cfg });
    w.fx.failList = "null";
    await d.tick();
    await d.tick();
    w.clock.t += 10 * 60_000;
    await d.tick();
    expect(warnings.filter((row) => row.message === "agent_discovery_scan_failed")).toEqual([
      { message: "agent_discovery_scan_failed", data: { suppressed: 0 } },
      { message: "agent_discovery_scan_failed", data: { suppressed: 1 } },
    ]);
    d.stop();
  });

  test("examination failures and Kimi budget warnings are throttled", async () => {
    const w = world(cleanups);
    w.fx.procs.push({ pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000,
      command: "kimi", cpuMs: 1_000 });
    w.fx.cwds.set(200, w.cwd);
    const warnings: Array<{ message: string; suppressed?: number }> = [];
    const log = { debug: () => {}, info: () => {}, error: () => {},
      warn: (message: string, data?: { suppressed?: number }) => { warnings.push({ message, suppressed: data?.suppressed }); } };
    const d = new AgentDiscovery(w.core, log, { provider: w.fx, uid: ME, now: () => w.clock.t,
      home: w.home, claudeConfigDir: w.cfg });
    const files = (d as unknown as { files: {
      listKimiSessions: () => Promise<null>; repoContext: () => Promise<never> } }).files;
    files.listKimiSessions = async () => null;
    files.repoContext = async () => { throw new Error("file worker unavailable"); };
    try {
      await d.tick();
      await d.tick();
      w.clock.t += 10 * 60_000;
      await d.tick();
      expect(warnings.filter((row) => row.message === "agent_discovery_examine_failed")
        .map((row) => row.suppressed)).toEqual([0, 3]);
      expect(warnings.filter((row) => row.message === "agent_discovery_kimi_budget")
        .map((row) => row.suppressed)).toEqual([0, 1]);
    } finally { d.stop(); }
  });

  test("budget and abandonment warnings each keep their own ten-minute suppression count", async () => {
    const w = world(cleanups);
    for (let i = 0; i < 12; i++) w.fx.procs.push({ pid: 300 + i, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "claude -p work" });
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const log = { debug: () => {}, info: () => {}, error: () => {}, warn: (message: string, data?: Record<string, unknown>) => { warnings.push({ message, data }); } };
    const d = new AgentDiscovery(w.core, log, { provider: w.fx, uid: ME, now: () => w.clock.t,
      home: w.home, claudeConfigDir: w.cfg, scanBudgetMs: 1, concurrency: 1 });
    await d.scan();
    await d.scan();
    w.clock.t += 10 * 60_000;
    await d.scan();
    const budget = warnings.filter((row) => row.message === "agent_discovery_budget_exhausted");
    expect(budget).toHaveLength(2);
    expect(budget.map((row) => row.data?.suppressed)).toEqual([0, 1]);
    w.fx.list = async () => new Promise(() => {});
    await d.tick();
    await d.tick();
    w.clock.t += 10 * 60_000;
    await d.tick();
    const abandoned = warnings.filter((row) => row.message === "agent_discovery_scan_abandoned");
    expect(abandoned).toHaveLength(2);
    expect(abandoned.map((row) => row.data?.suppressed)).toEqual([0, 1]);
    d.stop();
  });

  test("hung environment reads cannot stop a fresh census on each interval", async () => {
    const w = world(cleanups);
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    w.fx.envVars = async () => new Promise(() => {});
    const warnings: string[] = [];
    const log = { debug: () => {}, info: () => {}, error: () => {}, warn: (message: string) => { warnings.push(message); } };
    const d = new AgentDiscovery(w.core, log, {
      provider: w.fx, uid: ME, now: () => w.clock.t, home: w.home, claudeConfigDir: w.cfg,
      intervalMs: 40, scanBudgetMs: 25,
    });
    d.start();
    try {
      await Bun.sleep(30);
      w.fx.procs.push({ pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "claude -p second" });
      await Bun.sleep(40);
      w.fx.procs.push({ pid: 300, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "claude -p third" });
      await Bun.sleep(50);
      expect(w.fx.lists).toBeGreaterThanOrEqual(3);
      expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 3 }]);
      expect(warnings.filter((message) => message === "agent_discovery_budget_exhausted")).toHaveLength(1);
    } finally { d.stop(); }
  });

  test("an overdue process-list read is abandoned and later intervals still publish a census", async () => {
    const w = world(cleanups);
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    const original = w.fx.list.bind(w.fx);
    let release!: (rows: Awaited<ReturnType<typeof original>>) => void;
    const blocked = new Promise<Awaited<ReturnType<typeof original>>>((resolve) => { release = resolve; });
    let lists = 0;
    w.fx.list = async () => ++lists === 1 ? blocked : original();
    const warnings: string[] = [];
    const log = { debug: () => {}, info: () => {}, error: () => {}, warn: (message: string) => { warnings.push(message); } };
    const d = new AgentDiscovery(w.core, log, {
      provider: w.fx, uid: ME, now: () => w.clock.t, home: w.home, claudeConfigDir: w.cfg,
      intervalMs: 40, scanBudgetMs: 25,
    });
    d.start();
    try {
      await Bun.sleep(130);
      expect(lists).toBeGreaterThanOrEqual(2);
      expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
      expect(warnings.filter((message) => message === "agent_discovery_scan_abandoned")).toHaveLength(1);
      release([{ pid: 900, ppid: 1, uid: ME, startedAt: w.clock.t, command: "codex exec late" }]);
      await Bun.sleep(1);
      expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
    } finally { d.stop(); release(null); }
  });

  test("a never-completing session read leaves timers and the next census responsive", async () => {
    const w = world(cleanups);
    w.write([{ type: "user", message: { content: "working" } }]);
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    const d = w.disc({ intervalMs: 40, scanBudgetMs: 25 });
    const files = (d as unknown as { files: { read: () => null; readAsync: () => Promise<never> } }).files;
    let entered = 0;
    files.read = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); return null; };
    files.readAsync = () => { entered++; return new Promise(() => {}); };
    const started = performance.now();
    let firedAt: number | null = null;
    const timer = setTimeout(() => { firedAt = performance.now(); }, 50);
    d.start();
    try {
      await Bun.sleep(180);
      expect(firedAt).not.toBeNull();
      expect((firedAt ?? Infinity) - started).toBeLessThan(120);
      expect(entered).toBeGreaterThan(0);
      expect(w.fx.lists).toBeGreaterThanOrEqual(2);
      expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
    } finally { clearTimeout(timer); d.stop(); }
  });

  test("a never-completing hook-state read does not hold the next scan", async () => {
    const w = world(cleanups);
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    const d = w.disc({ intervalMs: 40, scanBudgetMs: 25 });
    let entered = 0;
    (d as unknown as { files: { hookStates: () => Promise<never> } }).files.hookStates = () => {
      entered++;
      return new Promise(() => {});
    };
    d.start();
    try {
      await Bun.sleep(130);
      expect(entered).toBeGreaterThan(0);
      expect(w.fx.lists).toBeGreaterThanOrEqual(2);
      expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
    } finally { d.stop(); }
  });

  test("a never-completing Claude session record has one outstanding read across scans", async () => {
    const w = world(cleanups);
    let reads = 0;
    w.fx.claudeSession = async () => { reads++; return new Promise(() => {}); };
    const d = w.disc({ intervalMs: 40, scanBudgetMs: 25 });
    const started = performance.now();
    let firedAt: number | null = null;
    const timer = setTimeout(() => { firedAt = performance.now(); }, 50);
    d.start();
    try {
      await Bun.sleep(180);
      expect(w.fx.lists).toBeGreaterThanOrEqual(3);
      expect(reads).toBe(1);
      expect(firedAt).not.toBeNull();
      expect((firedAt ?? Infinity) - started).toBeLessThan(120);
    } finally { clearTimeout(timer); d.stop(); }
  });

  test("a timed-out cwd refresh leaves its old value stale for the next scan", async () => {
    const w = world(cleanups);
    const d = w.disc();
    await d.tick();
    const original = w.fx.cwd.bind(w.fx);
    let reads = 0;
    w.clock.t += CWD_REFRESH_MS;
    w.fx.cwd = async () => { reads++; return new Promise<string>(() => {}); };
    await d.tick();
    expect(reads).toBe(1);
    w.fx.cwd = async (pid) => { reads++; return pid === 100 ? `${w.root}/moved` : original(pid); };
    w.clock.t += 15_000;
    await d.tick();
    expect(reads).toBe(2);
    expect((await d.scan())[0]?.repo).toBe("moved");
  });

  test("an open node stream receives the first census before enrichment finishes", async () => {
    const w = world(cleanups);
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    await Bun.sleep(20); // drain the team-create notification before subscribing
    w.core.hub.setProviders({
      agents: () => ({ agents: [], archive: [] }),
      nodes: () => [{ stats: w.core.publishedStats() } as NodeView],
      visible: () => true,
    });
    const abort = new AbortController();
    const response = w.core.hub.open(null, [], abort.signal);
    expect(response).not.toBeNull();
    const reader = response!.body!.getReader();
    cleanups.push(() => { abort.abort(); void reader.cancel(); });
    await reader.read(); // connected: the subscriber is already open
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    w.fx.envVars = async () => { await blocked; return new Map(); };
    const tick = w.disc().tick();
    try {
      const frame = await Promise.race([reader.read(), Bun.sleep(200).then(() => { throw new Error("first census never reached open stream"); })]);
      const data = JSON.parse(new TextDecoder().decode(frame.value).split("data: ")[1] ?? "") as StreamMessage;
      expect(data.type).toBe("nodes");
      if (data.type === "nodes") expect(data.nodes[0]?.stats?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
    } finally { release(); await tick; }
  });

  test("publishes a headless worker while its environment read is hung", async () => {
    const w = world(cleanups);
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    w.fx.envVars = async () => { entered(); await blocked; return new Map(); };
    const d = w.disc();
    const tick = d.tick();
    try {
      await reading;
      expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
      await Promise.race([tick, Bun.sleep(2_000).then(() => { throw new Error("hung read blocked first-scan card"); })]);
      expect(status(w.core, "claude-pid100")?.state).toBe("working");
    } finally {
      release();
      await tick;
    }
  });

  test("a brand-new claude -p process enters the first census with the production age gate", async () => {
    const w = world(cleanups);
    w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
    w.fx.procs = w.fx.procs.map((p) => p.pid === 100 ? { ...p, startedAt: w.clock.t - 1_000 } : p);
    w.fx.env.set(101, {});
    await w.disc({ unnamedMinAgeMs: 20_000 }).tick();
    expect(w.core.publishedStats()?.agent_processes).toEqual([{ name: "claude-code", count: 1 }]);
    expect(status(w.core, "claude-pid100")).toBeNull(); // the short-run ghost gate still governs cards
    w.clock.t += 21_000;
    await w.disc({ unnamedMinAgeMs: 20_000 }).tick();
    expect(status(w.core, "claude-pid100")?.state).toBe("working");
  });

  test("22 headless workers appear on the first scan while slow or failed enrichment rotates", async () => {
    const w = world(cleanups, { prompts: false, activity: false });
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    for (let i = 0; i < 22; i++) {
      const pid = 2000 + i;
      w.fx.procs.push({ pid, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "claude -p long-brief", cpuMs: 1_000 });
      w.fx.env.set(pid, { WALKIE_AGENT: `worker-${i}` });
      w.fx.cwds.set(pid, w.cwd);
    }
    const env = w.fx.envVars.bind(w.fx);
    let failed = false;
    w.fx.envVars = async (pids, names) => {
      await Bun.sleep(25);
      if (!failed) { failed = true; throw new Error("environment unavailable"); }
      return env(pids, names);
    };
    const d = w.disc({ scanBudgetMs: 1, concurrency: 1 });
    await d.tick();
    expect(w.core.store.agents().filter((r) => r.agent.startsWith("claude-pid") || r.agent.startsWith("worker-"))).toHaveLength(22);
    expect(w.core.store.agents().filter((r) => r.agent.startsWith("claude-pid") || r.agent.startsWith("worker-")).every((r) => JSON.parse(r.body).state === "working")).toBe(true);
    for (let i = 0; i < 15; i++) { w.clock.t += 15_000; await d.tick(); }
    for (let i = 0; i < 22; i++) expect(status(w.core, `worker-${i}`)).not.toBeNull();
  });

  test("stop then start restores file enrichment", async () => {
    const w = world(cleanups);
    w.write([{ type: "user", message: { content: "working" } }]);
    const d = w.disc();
    try {
      d.stop();
      d.start();
      await Bun.sleep(150);
      const after = (await d.scan())[0];
      expect(after?.repo).toBeDefined();
      expect(after?.branch).toBeDefined();
      expect(after?.activity?.file).toBe(true);
    } finally { d.stop(); }
  });

  test("the process's WALKIE_AGENT names it after enrichment", async () => {
    const w = world(cleanups);
    w.fx.env.set(100, { CLAUDE_CONFIG_DIR: w.cfg, WALKIE_AGENT: "named-worker" });
    const d = w.disc();
    await d.tick();
    expect(status(w.core, "named-worker")).not.toBeNull();
    expect(status(w.core, "claude-pid100")).toBeNull();
  });

  test("a pending pid reserves its hook card instead of adding a duplicate", async () => {
    const w = world(cleanups);
    hook(w.core, "working", "Running a command", "hook-worker", { cwd: w.cwd });
    w.fx.envVars = async () => { throw new Error("slow environment lookup failed"); };
    await w.disc({ scanBudgetMs: 1 }).tick();
    expect(status(w.core, "hook-worker")?.state).toBe("working");
    expect(status(w.core, "claude-pid100")).toBeNull();
  });

  test("a tentative hook reservation moves to the matching cwd after enrichment", async () => {
    const w = world(cleanups);
    w.fx.procs.push({ pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "claude -p task", cpuMs: 1 });
    w.fx.env.set(101, {});
    w.fx.cwds.set(100, `${w.root}/other`);
    w.fx.cwds.set(200, w.cwd);
    hook(w.core, "working", "Running a command", "hook-worker", { cwd: w.cwd });
    const env = w.fx.envVars.bind(w.fx);
    const cwd = w.fx.cwd.bind(w.fx);
    w.fx.envVars = async () => { throw new Error("lookup failed"); };
    w.fx.cwd = async () => new Promise(() => {});
    const d = w.disc({ scanBudgetMs: 2_000, concurrency: 2 });
    await d.tick();
    expect(status(w.core, "claude-pid100")).toBeNull();
    w.fx.envVars = env;
    w.fx.cwd = cwd;
    w.clock.t += 15_000;
    await d.tick();
    expect(status(w.core, "hook-worker")?.state).toBe("working");
    expect(status(w.core, "claude-pid100")).not.toBeNull();
    expect(status(w.core, "claude-pid200")?.state).toBe("offline"); // its provisional card leaves the live view
  });
});
