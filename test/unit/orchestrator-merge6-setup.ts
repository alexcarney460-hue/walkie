// Round-6 regression harness. Same shape as merge-probe4/setup.ts, plus:
//  - a helper emulator with a DESTROY latency (the real talkie-destroy runs endProcesses, launchctl, a nested
//    sudo -u sweep over the extra roots, dseditgroup and dscl deletes), holding one lock like withTalkieLock;
//  - the admin hook IGNORES the abort signal: a root helper already running keeps its lock and finishes its verb;
//    TalkieOsUser.admin races the abort and returns null to its caller;
//  - optional REAL uid monitor: src/daemon/orchestrator/uid-monitor.ts monitorUid() run in-process against the same
//    lease file and cleanup obligation, destroying through the same emulator. kill() behaves like SIGKILL.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export const WT = new URL("../..", import.meta.url).pathname;
const { Cluster, waitFor } = await import("../helpers/cluster.ts");
const { monitorUid } = await import("../../src/daemon/orchestrator/uid-monitor.ts");
export { waitFor };
export const FAKE_DIR = join(WT, "test", "fixtures", "fake-claude");
export type Verb = "talkie-create" | "talkie-destroy" | "talkie-reconcile" | "talkie-status";

export function helperEmulator(t: { createMs: number; destroyMs: number }) {
  let lock: Promise<unknown> = Promise.resolve();
  const state = { current: null as string | null, log: [] as string[] };
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => { const run = lock.then(fn); lock = run.catch(() => undefined); return run; };
  const fn = (verb: Verb, generation?: string, who = "daemon") => serialize(async () => {
    const t0 = Date.now();
    if (verb === "talkie-status") return;
    if (verb === "talkie-reconcile") { state.log.push(`${who}:reconcile`); state.current = null; return; }
    if (verb === "talkie-create") {
      await Bun.sleep(t.createMs);
      if (state.current) { state.log.push(`${who}:create USED`); return { ok: false as const, why: "walkie-talkie or uid 550000 already exists" }; }
      state.current = generation ?? "unqualified"; state.log.push(`${who}:create(${generation?.slice(0, 8)}) ok ${Date.now() - t0}ms`); return;
    }
    if (state.current && generation && state.current !== generation) { state.log.push(`${who}:destroy refused`); return { ok: false as const, why: "dedicated account belongs to another run" }; }
    await Bun.sleep(t.destroyMs);
    state.log.push(`${who}:destroy(${generation?.slice(0, 8)}) ok ${Date.now() - t0}ms`); state.current = null; return;
  });
  return { fn, state };
}

export interface Rig5 {
  c: any; alex: any; root: string; adminCalls: string[]; host: () => any; rows: () => any[];
  helper: ReturnType<typeof helperEmulator>; timing: { createMs: number; destroyMs: number };
  monitors: Array<{ run: string; killed: boolean; code: number | null | "pending"; startedAt: number; endedAt?: number }>;
}

export async function rig5(opts: { realMonitor?: boolean; firstDestroyNoAnswer?: boolean; createMs?: number; destroyMs?: number; orchestrator?: Record<string, unknown> } = {}): Promise<Rig5> {
  const c = new Cluster();
  const root = c.root as string;
  const state = join(root, "fake-state"); mkdirSync(state, { recursive: true });
  const launches = join(root, "fake-launches.jsonl");
  const talkieHome = join(root, "walkie-talkie"); mkdirSync(talkieHome);
  const cfgDir = join(root, "claude-cfg"); mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600_000 } }));
  const runner = join(root, "talkie-runner");
  writeFileSync(runner, `#!/bin/sh\nexec '${process.execPath}' '${join(WT, "src/cli/main.ts")}' "$@"\n`); chmodSync(runner, 0o755);
  const runtime = join(root, "claude-runtime");
  writeFileSync(runtime, `#!/bin/sh\nexec '${process.execPath}' '${join(FAKE_DIR, "claude")}' "$@"\n`); chmodSync(runtime, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches, CLAUDE_CONFIG_DIR: cfgDir };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const adminCalls: string[] = [];
  const timing = { createMs: opts.createMs ?? 50, destroyMs: opts.destroyMs ?? 50 };
  const helper = helperEmulator(timing);
  let destroys = 0;
  const monitors: Rig5["monitors"] = [];
  const realMonitor = (file: string, run: string, cleanupFile: string) => {
    const rec = { run, killed: false, code: "pending" as number | null | "pending", startedAt: Date.now() } as Rig5["monitors"][number];
    monitors.push(rec);
    let onKill!: () => void;
    const killedP = new Promise<null>((resolve) => { onKill = () => resolve(null); });
    const loop = monitorUid(file, run, cleanupFile, {
      daemonPid: 4242, parentPid: () => 4242,
      sleep: async (ms: number) => { await Bun.sleep(Math.min(ms, 50)); if (rec.killed) throw new Error("killed"); },
      destroy: async () => {
        if (rec.killed) throw new Error("killed");
        const res = await helper.fn("talkie-destroy", run, "monitor");
        if (!res) return true;
        return res.why.includes("belongs to another run") ? "newer" : false;
      },
      report: () => undefined,
    }).then((code: number) => code, () => null);
    const exited = Promise.race([loop, killedP]).then((code) => { if (rec.code === "pending") { rec.code = code; rec.endedAt = Date.now(); } return code; });
    return { kill: () => { rec.killed = true; onKill(); }, exited };
  };
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, shellTokenMarginMs: 1_000, env, ...opts.orchestrator,
    shellUser: { ready: () => true, existing: () => false, privateHome: () => null, socketRoot: root, runner, runtime,
      testEnv: { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches },
      ...(opts.realMonitor ? { monitor: realMonitor } : {}),
      admin: async (verb: Verb, generation?: string) => {
        adminCalls.push(verb);
        if (verb === "talkie-destroy" && opts.firstDestroyNoAnswer && destroys++ === 0) return null;
        const res = await helper.fn(verb, generation);
        if (res) return res;
        return { ok: true, name: "walkie-talkie", uid: 550_000, home: talkieHome, ...(generation ? { generation } : {}) };
      },
      userSwitch: () => [process.execPath, join(WT, "test/fixtures/fake-talkie-runner.ts")] } } });
  await alex.client().init("acme", "alex");
  const rows = () => existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.argv?.includes("-p")) : [];
  const { hostFor } = await import("../../src/daemon/orchestrator/host.ts");
  return { c, alex, root, adminCalls, host: () => hostFor(alex.d.core) as any, rows, helper, timing, monitors };
}

export function facts(host: any) {
  const su = host.shellUser;
  let pending: unknown = null;
  try { pending = su.pendingCleanup; } catch (e) { pending = `err ${(e as Error).message}`; }
  const v = host.view();
  return { phase: host.phase, child: !!host.child?.alive, active: host.state?.active ?? null, stopped_by_hand: !!host.state?.stopped_by_hand,
    monitorFault: host.monitorFault, stopRequests: host.stopRequests, stopping: host.stopping, lastError: host.lastError ?? null,
    view: v.state, view_error: v.last_error ?? null, suActive: su.active, generation: su.generation?.slice(0, 8) ?? null,
    monitorHandle: !!su.monitor, pending, handHeld: host.handHeld() };
}
