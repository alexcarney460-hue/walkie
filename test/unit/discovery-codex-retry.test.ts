import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentDiscovery } from "../../src/daemon/discovery.ts";
import { jl, ME, world } from "../helpers/discovery-world.ts";

const cleanups: Array<() => void> = [];
const RealWorker = globalThis.Worker;
const delayed = new URL("../fixtures/discovery-files/delayed-worker.ts", import.meta.url);
afterEach(() => { globalThis.Worker = RealWorker; for (const clean of cleanups.splice(0)) clean(); });

test("Codex session files delayed in the worker queue recover on later scans", async () => {
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, opts?: WorkerOptions) {
      super(String(url).includes("discovery-files-worker") ? delayed : url, opts);
    }
  };
  const w = world(cleanups, { prompts: false, activity: true });
  w.core.machineStats = { at: w.clock.t, mem: null, temp_c: null };
  w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
  const dir = join(w.root, ".codex", "sessions", "2026", "09", "26");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 12; i++) {
    const pid = 2500 + i;
    const uuid = randomUUID();
    const rollout = join(dir, `rollout-2026-09-26T07-50-56-${uuid}.jsonl`);
    writeFileSync(rollout, jl({ type: "session_meta", payload: { id: uuid } },
      { type: "event_msg", payload: { type: "user_message", message: `task ${i}` } }));
    w.fx.procs.push({ pid, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000,
      command: "codex exec do the thing", cpuMs: 1_000 });
    w.fx.files.set(pid, ["/dev/null", rollout]);
    w.fx.cwds.set(pid, w.cwd);
  }
  const discovery = new AgentDiscovery(w.core, { debug() {}, info() {}, error() {}, warn() {} }, {
    provider: w.fx, uid: ME, now: () => w.clock.t, home: w.home, claudeConfigDir: w.cfg,
    share: { prompts: false, activity: true }, scanBudgetMs: 10_000, concurrency: 6,
  });
  try {
    let withFile = 0;
    for (let tick = 0; tick < 4 && withFile < 12; tick++) {
      w.clock.t += 15_000;
      const found = await discovery.scan();
      expect(found).toHaveLength(12);
      withFile = found.filter((agent) => agent.activity?.file === true).length;
      if (tick === 0) expect(withFile).toBeLessThan(12);
    }
    expect(withFile).toBe(12);
  } finally { discovery.stop(); }
}, 60_000);

test("a scan abandoned after the rollout read retries the session file", async () => {
  const w = world(cleanups, { prompts: false, activity: true });
  w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
  const uuid = randomUUID();
  const dir = join(w.root, ".codex", "sessions", "2026", "09", "26");
  const rollout = join(dir, `rollout-2026-09-26T07-50-56-${uuid}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(rollout, jl({ type: "session_meta", payload: { id: uuid } },
    { type: "event_msg", payload: { type: "user_message", message: "task" } }));
  w.fx.procs.push({ pid: 2500, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000,
    command: "codex exec do the thing", cpuMs: 1_000 });
  w.fx.files.set(2500, [rollout]);
  w.fx.cwds.set(2500, w.cwd);
  const discovery = w.disc({ scanBudgetMs: 10_000 });
  const files = (discovery as unknown as { files: { openFile(path: string, deadline: number): Promise<string | null> } }).files;
  const openFile = files.openFile.bind(files);
  let active = true;
  let calls = 0;
  files.openFile = async (path, deadline) => {
    calls++;
    const found = await openFile(path, deadline);
    if (calls === 1) active = false;
    return found;
  };
  try {
    const first = await (discovery as unknown as { scanOnce(onCensus?: () => void, active?: () => boolean): Promise<unknown> })
      .scanOnce(undefined, () => active);
    expect(first).toBeNull();
    const second = await discovery.scan();
    expect(calls).toBe(2);
    expect(second[0]?.session).toBe(uuid);
    expect(second[0]?.activity?.file).toBe(true);
  } finally { discovery.stop(); }
});

test("missing Codex rollouts back off from 15 seconds to five minutes", async () => {
  const w = world(cleanups, { prompts: false, activity: true });
  w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
  const uuid = randomUUID();
  const dir = join(w.root, ".codex", "sessions", "2026", "09", "26");
  const rollout = join(dir, `rollout-2026-09-26T07-50-56-${uuid}.jsonl`);
  w.fx.procs.push({ pid: 2501, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000,
    command: "codex exec do the thing", cpuMs: 1_000 });
  w.fx.files.set(2501, [rollout]);
  w.fx.cwds.set(2501, w.cwd);
  const discovery = w.disc({ scanBudgetMs: 10_000 });
  const files = (discovery as unknown as { files: { openFile(path: string, deadline: number): Promise<string | null> } }).files;
  const openFile = files.openFile.bind(files);
  let calls = 0;
  files.openFile = async (path, deadline) => { calls++; return openFile(path, deadline); };
  const scanAfter = async (ms: number, expected: number) => {
    w.clock.t += ms;
    await discovery.scan();
    expect(calls).toBe(expected);
  };
  try {
    await scanAfter(0, 1);
    await scanAfter(14_999, 1);
    await scanAfter(1, 2);
    await scanAfter(29_999, 2);
    await scanAfter(1, 3);
    await scanAfter(60_000, 4);
    await scanAfter(120_000, 5);
    await scanAfter(240_000, 6);
    await scanAfter(299_999, 6);
    await scanAfter(1, 7);
    mkdirSync(dir, { recursive: true });
    writeFileSync(rollout, jl({ type: "session_meta", payload: { id: uuid } },
      { type: "event_msg", payload: { type: "user_message", message: "task" } }));
    await scanAfter(299_999, 7);
    w.clock.t += 1;
    const recovered = await discovery.scan();
    expect(calls).toBe(8);
    expect(recovered[0]?.activity?.file).toBe(true);
  } finally { discovery.stop(); }
});
