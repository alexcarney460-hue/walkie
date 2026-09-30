// Probe: platform -> full (shell uid) -> platform. Does the platform child after the shell run keep --permission-prompts none?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const WT = join(import.meta.dir, "../..");
const { Cluster, waitFor } = await import(`${WT}/test/helpers/cluster.ts`);
const FAKE_DIR = join(WT, "test", "fixtures", "fake-claude");
let c: any; let alex: any; let launches = "";
const rows = () => existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.argv?.includes("-p")) : [];
beforeAll(async () => {
  c = new Cluster();
  const state = join(c.root, "fake-state"); mkdirSync(state, { recursive: true });
  launches = join(c.root, "fake-launches.jsonl");
  const talkieHome = join(c.root, "walkie-talkie"); mkdirSync(talkieHome);
  const cfgDir = join(c.root, "claude-cfg"); mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600_000 } }));
  const runner = join(c.root, "talkie-runner");
  writeFileSync(runner, `#!/bin/sh\nexec '${process.execPath}' '${join(WT, "src/cli/main.ts")}' "$@"\n`); chmodSync(runner, 0o755);
  const runtime = join(c.root, "claude-runtime");
  writeFileSync(runtime, `#!/bin/sh\nexec '${process.execPath}' '${join(FAKE_DIR, "claude")}' "$@"\n`); chmodSync(runtime, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches, CLAUDE_CONFIG_DIR: cfgDir };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, shellTokenMarginMs: 1_000, env,
    shellUser: { ready: () => true, existing: () => false, privateHome: () => null, socketRoot: c.root, runner, runtime,
      testEnv: { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches },
      admin: async () => ({ ok: true, name: "walkie-talkie", uid: 550_000, home: talkieHome }),
      userSwitch: () => [process.execPath, join(WT, "test/fixtures/fake-talkie-runner.ts")] } } });
  await alex.client().init("acme", "alex");
}, 60_000);
afterAll(async () => { await c.close(); });

test("full (boot) -> platform: platform child keeps --permission-prompts", async () => {
  await alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => rows().length >= 1, { what: "full launch" });
  await alex.client("").orchestratorAccess("platform");
  await waitFor(() => rows().length >= 2, { what: "platform launch" });
  const second = rows()[1].argv as string[];
  expect(second.includes("--permission-prompts")).toBe(true);
}, 60_000);
