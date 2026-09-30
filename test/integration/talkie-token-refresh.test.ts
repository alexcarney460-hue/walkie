import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import { Cluster, waitFor } from "../helpers/cluster.ts";

const root = join(import.meta.dir, "../..");
let cluster: Cluster, alex: Awaited<ReturnType<Cluster["add"]>>, log: string, credentials: string;
const launches = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as { argv?: string[] }).filter((row) => row.argv?.includes("-p")) : [];

beforeAll(async () => {
  cluster = new Cluster();
  const state = join(cluster.root, "fake-state"); mkdirSync(state);
  log = join(cluster.root, "launches.jsonl");
  const userHome = join(cluster.root, "walkie-talkie"); mkdirSync(userHome);
  const config = join(cluster.root, "claude-config"); mkdirSync(config);
  credentials = join(config, ".credentials.json");
  const runner = join(cluster.root, "runner");
  writeFileSync(runner, `#!/bin/sh\nexec '${process.execPath}' '${join(root, "src/cli/main.ts")}' "$@"\n`); chmodSync(runner, 0o755);
  const runtime = join(cluster.root, "runtime");
  writeFileSync(runtime, `#!/bin/sh\nexec '${process.execPath}' '${join(root, "test/fixtures/fake-claude/claude")}' "$@"\n`); chmodSync(runtime, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${join(root, "test/fixtures/fake-claude")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: log, CLAUDE_CONFIG_DIR: config };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, shellTokenMarginMs: 15_000, env,
    shellUser: { ready: () => true, existing: () => false, privateHome: () => null, socketRoot: cluster.root, runner, runtime,
      testEnv: { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: log },
      admin: async () => ({ ok: true, name: "walkie-talkie", uid: 550_000, home: userHome }),
      userSwitch: () => [process.execPath, join(root, "test/fixtures/fake-talkie-runner.ts")] } } });
  await alex.client().init("acme", "alex");
}, 30_000);
afterAll(async () => { await cluster.close(); });

test("long turn is interrupted, refreshed, and resumed before the token expires", async () => {
  const expiresAt = Date.now() + 45_000;
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "short-token", expiresAt } }));
  await alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => launches().length >= 1, { what: "first shell launch", timeoutMs: 35_000 });
  const host: any = hostFor(alex.d.core);
  await alex.client("").orchestratorSay("slow turn");
  await waitFor(() => host.turn !== null, { what: "slow turn running" });
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "fresh-token", expiresAt: Date.now() + 3_600_000 } }));
  await waitFor(() => launches().length >= 2, { what: "refreshed shell launch", timeoutMs: 50_000 });
  expect(Date.now()).toBeLessThan(expiresAt);
  await waitFor(() => host.turn === null && host.queue.length === 0, { what: "resumed turn completed", timeoutMs: 20_000 });
}, 120_000);
