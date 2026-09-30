// Regression forms of the two reviewer probes: real daemon and fake Claude/helper, no sudo or OS users.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import { Cluster, waitFor } from "../helpers/cluster.ts";

const FAKE_DIR = join(import.meta.dir, "../fixtures/fake-claude");
let cluster: Cluster;
let alex: Awaited<ReturnType<Cluster["add"]>>;
let launches: string;
let helperReady = true;
const rows = (): Array<{ argv?: string[]; env?: string[]; access_file?: boolean; refresh_file?: boolean; credential_mode?: number }> => existsSync(launches)
  ? readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const launchRows = () => rows().filter((row) => row.argv?.includes("-p"));

beforeAll(async () => {
  cluster = new Cluster();
  const state = join(cluster.root, "fake-state"); mkdirSync(state);
  launches = join(cluster.root, "fake-launches.jsonl");
  const talkieHome = join(cluster.root, "walkie-talkie"); mkdirSync(talkieHome);
  const cfgDir = join(cluster.root, "claude-cfg"); mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600_000,
  } }));
  const runner = join(cluster.root, "talkie-runner");
  writeFileSync(runner, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../../src/cli/main.ts")}' "$@"\n`);
  chmodSync(runner, 0o755);
  const runtime = join(cluster.root, "claude-runtime");
  writeFileSync(runtime, `#!/bin/sh\nexec '${process.execPath}' '${join(FAKE_DIR, "claude")}' "$@"\n`);
  chmodSync(runtime, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`,
    FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches, CLAUDE_CONFIG_DIR: cfgDir,
    SSH_AUTH_SOCK: "/fake/person-agent.sock", AWS_SECRET_ACCESS_KEY: "fake-secret" };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, env,
    shellUser: { ready: () => helperReady, existing: () => false, privateHome: () => null,
      socketRoot: cluster.root, runner, runtime,
      testEnv: { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches },
      admin: async () => ({ ok: true, name: "walkie-talkie", uid: 550_000, home: talkieHome }),
      userSwitch: () => [process.execPath, join(import.meta.dir, "../fixtures/fake-talkie-runner.ts")],
    },
  } });
  await alex.client().init("acme", "alex");
}, 60_000);
afterAll(async () => { await cluster.close(); });

test("probe 1: dedicated socket refuses security routes and a crash restart retains access-only login", async () => {
  await alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => launchRows().length >= 1, { what: "first launch" });
  const first = launchRows().at(-1)!;
  expect(first.access_file).toBe(true);
  expect(first.refresh_file).toBe(false);
  expect(first.credential_mode).toBe(0o600);
  expect(first.env).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(first.env).not.toContain("AWS_SECRET_ACCESS_KEY");
  const host = hostFor(alex.d.core) as unknown as { childToken: string; shellUser: { socket: string } };
  for (const path of ["/v1/seats/config", "/v1/seats/token", "/v1/vault/lease", "/v1/admin/switches",
    "/v1/orchestrator/start", "/v1/orchestrator/access", "/v1/seats/repos", "/v1/team/invite", "/v1/license"]) {
    const response = await fetch(`http://walkie${path}`, { unix: host.shellUser.socket, method: "POST",
      headers: { "content-type": "application/json", "X-Walkie-Orchestrator-Token": host.childToken }, body: "{}" } as RequestInit);
    expect(response.status).toBe(403);
  }
  const before = launchRows().length;
  await alex.client("").orchestratorSay("crash please");
  await waitFor(() => launchRows().length > before, { what: "crash restart", timeoutMs: 20_000 }).catch(async (err) => {
    const view = (await alex.client("").orchestrator()).local;
    throw new Error(`${(err as Error).message}; state=${view.state}; last_error=${view.last_error ?? "none"}; launches=${launchRows().length}`);
  });
  expect(launchRows().at(-1)?.access_file).toBe(true);
}, 60_000);

test("probe 2: a stale helper on pre.8-style resume releases the lease and shows the setup command", async () => {
  await waitFor(async () => (await alex.client("").orchestrator()).local.state === "idle", { what: "idle" });
  helperReady = false;
  await alex.restart();
  await waitFor(async () => {
    const view = (await alex.client("").orchestrator()).local;
    return view.state === "stopped" && !!view.last_error?.includes("walkie seats setup-user --apply");
  }, { what: "stale helper status", timeoutMs: 20_000 });
  const host = hostFor(alex.d.core) as unknown as { leadership: { valid: boolean }; child: unknown;
    state: { mode: string } | null; applyAuto: (decision: { kind: "run" }) => Promise<void> };
  expect(host.leadership.valid).toBe(false);
  expect(host.child).toBeNull();
  if (host.state) host.state.mode = "auto";
  await host.applyAuto({ kind: "run" });
  expect(host.leadership.valid).toBe(false);
  expect((await alex.client("").orchestrator()).local.last_error).toContain("walkie seats setup-user --apply");
}, 40_000);
