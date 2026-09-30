// Shared harness for round-2 probes (read-only against the worktree; everything lives under the cluster tmp root).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export const WT = join(import.meta.dir, "../..");
const { Cluster, waitFor } = await import(`${WT}/test/helpers/cluster.ts`);
export { waitFor };
export const FAKE_DIR = join(WT, "test", "fixtures", "fake-claude");

export interface Rig {
  c: any; alex: any; launches: string; root: string; adminCalls: string[];
  rows: () => any[]; host: () => any; destroyDelay: { ms: number };
}

/** runtimeBody: shell text run before exec'ing the fake claude (may exit early). */
export async function rig(opts: { runtimeBody?: string; personClaude?: (root: string) => string | undefined;
  destroyOk?: () => boolean; extraShell?: Record<string, unknown> } = {}): Promise<Rig> {
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
  const destroyDelay = { ms: 0 };
  const alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, shellTokenMarginMs: 1_000, env,
    shellUser: { ready: () => true, existing: () => false, privateHome: () => null, socketRoot: root, runner, runtime,
      testEnv: { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches },
      admin: async (verb: string) => {
        adminCalls.push(verb);
        if (verb === "talkie-destroy" && destroyDelay.ms) await Bun.sleep(destroyDelay.ms);
        if (verb === "talkie-destroy" && opts.destroyOk && !opts.destroyOk()) return { ok: false, why: "probe: helper refused" };
        return { ok: true, name: "walkie-talkie", uid: 550_000, home: talkieHome };
      },
      ...(opts.extraShell ?? {}),
      userSwitch: () => [process.execPath, join(WT, "test/fixtures/fake-talkie-runner.ts")] } } });
  await alex.client().init("acme", "alex");
  const rows = () => existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.argv?.includes("-p")) : [];
  const { hostFor } = await import(`${WT}/src/daemon/orchestrator/host.ts`);
  return { c, alex, launches, root, adminCalls, rows, host: () => hostFor(alex.d.core) as any, destroyDelay };
}
