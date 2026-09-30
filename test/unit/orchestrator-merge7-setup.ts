// Round-6 probe harness (read-only against the worktree). Same rig as merge-probe5/setup5.ts, but the uid monitor is a
// SEPARATE PROCESS (monitor-child.ts) so the cleanup obligation sees two different claimants, as in production
// (setup5 and the builder's orchestrator-merge6-setup.ts run monitorUid in-process: selfOp() is then the daemon's own
// pid/start, and CleanupObligation.record() never refuses the monitor while the daemon owns the retry).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export const WT = new URL("../..", import.meta.url).pathname;
const { Cluster, waitFor } = await import(`${WT}/test/helpers/cluster.ts`);
export { waitFor };
export const FAKE_DIR = join(WT, "test", "fixtures", "fake-claude");
export type Verb = "talkie-create" | "talkie-destroy" | "talkie-reconcile";
export const T0 = Date.now();
export const events: string[] = [];
export const ev = (s: string) => { events.push(`${Date.now() - T0}ms ${s}`); };

export function helperEmulator(t: { createMs: number; destroyMs: number; destroyFail: boolean }) {
  let lock: Promise<unknown> = Promise.resolve();
  const state = { current: null as string | null, log: [] as string[] };
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => { const run = lock.then(fn); lock = run.catch(() => undefined); return run; };
  const fn = (verb: Verb, generation?: string, who = "daemon") => serialize(async () => {
    const t0 = Date.now();
    if (verb === "talkie-reconcile") { state.log.push(`${who}:reconcile`); state.current = null; return; }
    if (verb === "talkie-create") {
      await Bun.sleep(t.createMs);
      if (state.current) { state.log.push(`${who}:create USED`); return { ok: false as const, why: "walkie-talkie or uid 550000 already exists" }; }
      state.current = generation ?? "unqualified"; state.log.push(`${who}:create(${generation?.slice(0, 8)}) ok`); return;
    }
    if (state.current && generation && state.current !== generation) { state.log.push(`${who}:destroy refused`); return { ok: false as const, why: "dedicated account belongs to another run" }; }
    ev(`${who}: helper destroy(${generation?.slice(0, 8)}) begins`);
    const fail = t.destroyFail;
    await Bun.sleep(t.destroyMs);
    if (fail) { state.log.push(`${who}:destroy(${generation?.slice(0, 8)}) FAILED ${Date.now() - t0}ms`); ev(`${who}: helper destroy FAILED`); return { ok: false as const, why: "1 process of it survived SIGKILL for 5 s" }; }
    state.log.push(`${who}:destroy(${generation?.slice(0, 8)}) ok ${Date.now() - t0}ms`); ev(`${who}: helper destroy ok`); state.current = null; return;
  });
  return { fn, state };
}

export interface Rig6 {
  c: any; alex: any; root: string; adminCalls: string[]; host: () => any;
  helper: ReturnType<typeof helperEmulator>; timing: { createMs: number; destroyMs: number; destroyFail: boolean };
  monitors: Array<{ run: string; pid: number; killed: boolean; code: number | null | "pending"; startedAt: number; endedAt?: number;
    kill: () => void; exited: Promise<number | null> }>;
  hosts: Set<any>;
  server: ReturnType<typeof Bun.serve>;
}

export async function rig6(opts: { createMs?: number; destroyMs?: number; destroyFail?: boolean; orchestrator?: Record<string, unknown> } = {}): Promise<Rig6> {
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
  const timing = { createMs: opts.createMs ?? 50, destroyMs: opts.destroyMs ?? 50, destroyFail: opts.destroyFail ?? false };
  const helper = helperEmulator(timing);
  const monitors: Rig6["monitors"] = [];
  const hosts = new Set<any>();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const run = new URL(req.url).searchParams.get("run") ?? "";
    const res = await helper.fn("talkie-destroy", run, "monitor");
    const result = !res ? true : res.why.includes("belongs to another run") ? "newer" : false;
    return Response.json({ result });
  } });
  const child = join(import.meta.dir, "orchestrator-merge7-monitor-child.ts");
  const xprocMonitor = (file: string, run: string, cleanupFile: string) => {
    const proc = Bun.spawn([process.execPath, child, WT, file, run, cleanupFile, String(server.port)], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const rec = { run, pid: proc.pid, killed: false, code: "pending" as number | null | "pending", startedAt: Date.now(),
      kill: () => { rec.killed = true; proc.kill("SIGKILL"); }, exited: proc.exited } as Rig6["monitors"][number];
    monitors.push(rec);
    ev(`monitor ${run.slice(0, 8)} spawned pid ${proc.pid}`);
    void new Response(proc.stderr).text().then((t) => { for (const l of t.trim().split("\n").filter(Boolean)) ev(`[monitor stderr] ${l}`); });
    const exited = proc.exited.then((code) => { rec.code = code; rec.endedAt = Date.now(); ev(`monitor ${run.slice(0, 8)} exited code ${code}${rec.killed ? " (killed)" : ""}`); return code; });
    rec.exited = exited;
    return { kill: rec.kill, exited };
  };
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, shellTokenMarginMs: 1_000, env, ...opts.orchestrator,
    shellUser: { ready: () => true, existing: () => false, privateHome: () => null, socketRoot: root, runner, runtime,
      testEnv: { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches },
      monitor: xprocMonitor,
      admin: async (verb: Verb | "talkie-status", generation?: string) => {
        adminCalls.push(verb);
        if (verb === "talkie-status") return { ok: true, status: { accountUid: null, uidTaken: false,
          processes: [], homeExists: false, ledgerOwner: null, generation: null, instance: null } };
        const res = await helper.fn(verb, generation);
        if (res) return res;
        return { ok: true, name: "walkie-talkie", uid: 550_000, home: talkieHome, ...(generation ? { generation } : {}) };
      },
      userSwitch: () => [process.execPath, join(WT, "test/fixtures/fake-talkie-runner.ts")] } } });
  await alex.client().init("acme", "alex");
  const { hostFor } = await import(`${WT}/src/daemon/orchestrator/host.ts`);
  return { c, alex, root, adminCalls, host: () => {
    const host = hostFor(alex.d.core) as any;
    hosts.add(host);
    return host;
  }, helper, timing, monitors, hosts, server };
}

export async function teardown(r: Rig6 | undefined) {
  if (!r) return;
  for (const host of r.hosts) host.shellUser.monitorRestarts = 3;
  for (const host of r.hosts) await host.close().catch(() => undefined);
  for (const host of r.hosts) {
    host.shellUser.monitorRestarts = 3;
    host.shellUser.monitorFile = null;
  }
  for (const m of r.monitors) if (m.code === "pending") m.kill();
  await Promise.all(r.monitors.map((m) => m.exited.catch(() => null)));
  r.server.stop(true);
  await r.c.close().catch(() => undefined);
}

export function liveMonitorPids(r: Rig6 | undefined): number[] {
  if (!r) return [];
  return r.monitors.filter((m) => {
    try { process.kill(m.pid, 0); return true; }
    catch { return false; }
  }).map((m) => m.pid);
}

export function facts(host: any) {
  const su = host.shellUser;
  let pending: unknown = null;
  try { pending = su.pendingCleanup; } catch (e) { pending = `err ${(e as Error).message}`; }
  const v = host.view();
  return { phase: host.phase, child: !!host.child?.alive, active: host.state?.active ?? null, stopped_by_hand: !!host.state?.stopped_by_hand,
    monitorFault: host.monitorFault, stopRequests: host.stopRequests, stopping: host.stopping, lastError: host.lastError ?? null,
    view: v.state, view_error: v.last_error ?? null, suActive: su.active, generation: su.generation?.slice(0, 8) ?? null,
    monitorHandle: !!su.monitor, handoff: su.monitorHandoffGeneration?.slice(0, 8) ?? null, pending, handHeld: host.handHeld(), lease: host.leadership.valid };
}
