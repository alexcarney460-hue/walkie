// Round-3 probe harness (read-only against the worktree; everything lives under the cluster tmp root).
// Same shape as merge-probe2/setup.ts plus a per-verb admin hook (delay / failure) to model the sudo helper's latency.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export const WT = resolve(import.meta.dir, "../..");
const { Cluster, waitFor } = await import(`${WT}/test/helpers/cluster.ts`);
export { waitFor };
/** Simulate an observed child exit without relying on fixture signal timing. */
export async function crash(host: any): Promise<void> {
  const child = host.child;
  host.child = null;
  await child?.close(100);
  host.scheduleRestart();
}
export const FAKE_DIR = join(WT, "test", "fixtures", "fake-claude");

export type Verb = "talkie-create" | "talkie-destroy" | "talkie-reconcile";
export interface Rig {
  c: any; alex: any; launches: string; root: string; adminCalls: string[];
  rows: () => any[]; host: () => any;
  hook: { fn: ((verb: Verb, n: number, generation?: string) => Promise<{ ok: false; why: string } | void>) | null };
  count: (v: string) => number;
}

/**
 * Emulates the root helper's semantics (src/daemon/seats/talkie-user.ts): every verb holds one lock (flock), create
 * refuses an existing uid ("used"), reconcile destroys any recorded uid, a generation-qualified destroy of an older run
 * answers "dedicated account belongs to another run". `createMs` models the seconds dscl/useradd take.
 */
export function helperEmulator(createMs: { ms: number; reconcileMs?: number }) {
  let lock: Promise<unknown> = Promise.resolve();
  const state = { current: null as string | null, log: [] as string[] };
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => { const run = lock.then(fn); lock = run.catch(() => undefined); return run; };
  const fn = (verb: Verb, _n: number, generation?: string) => serialize(async () => {
    if (verb === "talkie-reconcile") { if (createMs.reconcileMs) await Bun.sleep(createMs.reconcileMs); state.log.push(`reconcile(current=${state.current?.slice(0, 8) ?? "none"})`); state.current = null; return; }
    if (verb === "talkie-create") {
      await Bun.sleep(createMs.ms);
      if (state.current) { state.log.push(`create(${generation?.slice(0, 8)}) USED by ${state.current.slice(0, 8)}`); return { ok: false as const, why: "walkie-talkie or uid 550000 already exists" }; }
      state.current = generation ?? "unqualified"; state.log.push(`create(${generation?.slice(0, 8)}) ok`); return;
    }
    if (state.current && generation && state.current !== generation) {
      state.log.push(`destroy(${generation.slice(0, 8)}) refused: current ${state.current.slice(0, 8)}`);
      return { ok: false as const, why: "dedicated account belongs to another run" };
    }
    state.log.push(`destroy(${generation?.slice(0, 8)}) ok`); state.current = null; return;
  });
  return { fn, state };
}

export async function rig(opts: { runtimeBody?: string; orchestrator?: Record<string, unknown> } = {}): Promise<Rig> {
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
  writeFileSync(runtime, `#!/bin/sh\n${(opts.runtimeBody ?? "").replaceAll("$ROOT", root)}\nexec '${process.execPath}' '${join(FAKE_DIR, "claude")}' "$@"\n`); chmodSync(runtime, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches, CLAUDE_CONFIG_DIR: cfgDir };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const adminCalls: string[] = [];
  const hook: Rig["hook"] = { fn: null };
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    // Leadership derives a two-interval lease from this value. Keep the fixture valid through busy combined runs.
    autoCheckMs: 15_000, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, shellTokenMarginMs: 1_000, env, ...opts.orchestrator,
    shellUser: { ready: () => true, existing: () => false, privateHome: () => null, socketRoot: root, runner, runtime,
      testEnv: { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches },
      admin: async (verb: Verb, generation?: string) => {
        adminCalls.push(verb);
        const n = adminCalls.filter((v) => v === verb).length;
        const res = hook.fn ? await hook.fn(verb, n, generation) : undefined;
        if (res) return res;
        return { ok: true, name: "walkie-talkie", uid: 550_000, home: talkieHome, ...(generation ? { generation } : {}) };
      },
      userSwitch: () => [process.execPath, join(WT, "test/fixtures/fake-talkie-runner.ts")] } } });
  await alex.client().init("acme", "alex");
  const rows = () => existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.argv?.includes("-p")) : [];
  const { hostFor } = await import(`${WT}/src/daemon/orchestrator/host.ts`);
  return { c, alex, launches, root, adminCalls, rows, host: () => hostFor(alex.d.core) as any, hook,
    count: (v: string) => adminCalls.filter((x) => x === v).length };
}

/** Shell-user facts visible from the host. */
export function shellFacts(host: any) {
  const su = host.shellUser;
  const dir = su.directory as string | null;
  return { active: su.active, generation: su.generation, directory: dir, dirExists: dir ? existsSync(dir) : null,
    server: !!su.server, monitorTimer: !!su.monitorTimer, monitorFile: su.monitorFile, cleaning: !!su.cleaning };
}
