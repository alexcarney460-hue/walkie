// Reviewer probe 3 (round 2): attack the dedicated-user socket allowlist at 4447982. Fake helper/claude, no sudo.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runText, type SeatRun } from "../../src/protocol/seats.ts";
const WT = join(import.meta.dir, "../..");
const { hostFor } = await import(`${WT}/src/daemon/orchestrator/host.ts`);
const { Cluster, waitFor } = await import(`${WT}/test/helpers/cluster.ts`);
const FAKE_DIR = join(WT, "test", "fixtures", "fake-claude");
let c: any; let alex: any; let launches = ""; let credentials = "";
const launchRows = () => existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.argv?.includes("-p")) : [];

beforeAll(async () => {
  c = new Cluster();
  const state = join(c.root, "fake-state"); mkdirSync(state, { recursive: true });
  launches = join(c.root, "fake-launches.jsonl");
  const talkieHome = join(c.root, "walkie-talkie"); mkdirSync(talkieHome);
  const cfgDir = join(c.root, "claude-cfg"); mkdirSync(cfgDir);
  credentials = join(cfgDir, ".credentials.json");
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600_000 } }));
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

test("probe3", async () => {
  await alex.client("").orchestratorStart({ access: "full" });
  await waitFor(() => launchRows().length >= 1, { what: "first launch" });
  const host: any = hostFor(alex.d.core);
  const tok = host.childToken as string; const sock = host.shellUser.socket as string;
  const T = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(`http://walkie${path}`, { unix: sock, method, headers: { "content-type": "application/json", "X-Walkie-Orchestrator-Token": tok, ...extra },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) } as RequestInit);
    const t = await r.text(); console.log("PROBE3", method, path, "->", r.status, t.slice(0, 220).replace(/\n/g, " ")); return { status: r.status, text: t };
  };
  const P = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://walkie${path}`, { unix: alex.socket, method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) } as RequestInit);
    return r.json() as any;
  };
  // Person sets up: a private project and a public one with a card.
  const priv = (await P("POST", "/v1/projects", { name: "Secret Deal", prefix: "SEC", private: true })).project;
  const pub = (await P("POST", "/v1/projects", { name: "Public", prefix: "PUB" })).project;
  const card = (await P("POST", "/v1/tasks", { project: "PUB", title: "a card" })).task;
  console.log("PROBE3 setup priv=", priv?.channel, priv?.private, "pub=", pub?.channel, "card=", card?.key, "board=", pub?.boards?.[0]?.id);

  // 1. The prior HIGH: refused routes.
  await T("POST", "/v1/seats/config", { allow: true, same_user: true, launchers: ["@alex/alex-mbp/orchestrator"] });
  await T("POST", "/v1/vault/lease", {});
  // 2. Path tricks.
  for (const p of ["/v1/tasks/..%2F..%2Fseats%2Fconfig", "/v1/tasks/%2e%2e/%2e%2e/seats/config", "/v1/seats/run/../config", "/v1/seats%2Fconfig",
    "//v1/seats/config", "/v1/tasks/x/../../seats/config", "/v1/projects/p-00000000/boards/..%2f..%2f..%2fseats%2fconfig", "/v1/tasks/automatio%6E"])
    await T("POST", p, { allow: true, same_user: true });
  // 3. Method tricks + upgrade.
  await T("PUT", "/v1/seats/config", { allow: true });
  await T("DELETE", "/v1/integrations/github");
  await T("OPTIONS", "/v1/seats/config");
  await T("GET", "/v1/stream", undefined, { Upgrade: "websocket", Connection: "Upgrade" });
  await T("GET", "/v1/admin/switches");
  await T("GET", "/v1/seats/repos");
  // 4. Header smuggling on an allowed route: who is the author?
  const post = await T("POST", "/v1/post", { channel: "general", text: "hello from talkie" }, { "X-Walkie-Agent": "ghost", "X-Walkie-Admin-Token": "x", "X-Walkie-Under-Agent": "0" });
  try { console.log("PROBE3 post author:", JSON.stringify(JSON.parse(post.text).event.author)); } catch {}
  // 5. Allowed routes that are admin-gated and signed as the person.
  expect((await T("POST", `/v1/projects/${priv.channel}`, { private: false })).status).toBe(403);
  const privAfter = (await P("GET", `/v1/projects/${priv.channel}`)).project;
  console.log("PROBE3 private project after talkie write: private=", privAfter?.private);
  expect(privAfter?.private).toBe(true);
  expect((await T("POST", `/v1/projects/${pub.channel}`, { name: "Renamed by talkie", prefix: "PWN" })).status).toBe(403);
  expect((await T("POST", `/v1/projects/${pub.channel}/boards/${encodeURIComponent(pub.boards[0].id)}`, { state: "archived" })).status).toBe(403);
  expect((await T("GET", `/v1/projects/${pub.channel}/export?format=ndjson`)).status).toBe(403);
  expect((await T("POST", `/v1/tasks/${card?.id ?? card?.key}`, { state: "deleted" })).status).toBe(403);
  expect((await T("POST", `/v1/projects/${priv.channel}`, { state: "deleted" })).status).toBe(403);
  const privGone = (await P("GET", `/v1/projects?all=1`)).projects.map((p: any) => `${p.prefix}:${p.state}:${p.name}`);
  console.log("PROBE3 projects after talkie writes:", JSON.stringify(privGone));
  expect(privGone).toContain("SEC:active:Secret Deal");
  expect(privGone).toContain("PUB:active:Public");
  expect((await T("POST", "/v1/projects", { name: "Shell Project", prefix: "SHL", private: true })).status).toBe(403);
  expect((await T("POST", "/v1/projects", { name: "Shell Project", prefix: "SHL" })).status).toBe(200);
  expect((await T("POST", "/v1/tasks", { project: "PUB", title: "shell card" })).status).toBe(200);
  expect((await T("POST", `/v1/tasks/${card.id}`, { column: "doing" })).status).toBe(200);
  expect((await T("POST", `/v1/tasks/${card.id}/comment`, { text: "shell comment" })).status).toBe(200);
  const gate = await fetch(`http://walkie/v1/projects/${priv.channel}`, { unix: alex.socket, method: "POST",
    headers: { "content-type": "application/json", "X-Walkie-Agent": "orchestrator", "X-Walkie-Orchestrator-Token": tok,
      "X-Walkie-Talkie-Shell": "1" }, body: JSON.stringify({ private: false }) } as RequestInit);
  expect(gate.status).toBe(403);
  expect(await gate.text()).toContain("talkie_shell_forbidden");
  // 6. Body filter bypasses.
  await T("POST", "/v1/projects", '{"name":"x1","pa\\u0074hs":[{"path":"/tmp/outside-project","project":"x"}]}');
  await T("POST", "/v1/projects", '{"name":"x2","automations":null}');
  // 7. Artifacts (allowed route, but X-Walkie-* headers are not forwarded).
  const art = await fetch("http://walkie/v1/artifacts", { unix: sock, method: "POST", headers: { "X-Walkie-Orchestrator-Token": tok, "X-Walkie-Name": "a.txt", "content-type": "text/plain" }, body: "hi" } as RequestInit);
  console.log("PROBE3 artifacts via talkie socket:", art.status, (await art.text()).slice(0, 160));
  // 8. Seat run with v2 account/workspace fields (seats not allowed on this host).
  await T("POST", "/v1/seats/run", { machine: "alex-mbp", runtime: "claude", permission_mode: "bypassPermissions", brief: "x", account: "claude:0123456789abcdef01234567" });
  await alex.client("").seatsConfig({ allow: true, same_user: true, launchers: ["@alex/alex-mbp/orchestrator"] });
  const seat = await T("POST", "/v1/seats/run", { machine: "alex-mbp", runtime: "claude", prompt: "test seat" });
  expect(seat.status).toBe(409);
  expect(seat.text).toContain("switch WalkieTalkie back to Walkie platform access to use same-user machines");
  const shellRun: SeatRun = {
    op: "run", v: 1, runtime: "claude", prompt: "must not run as alex", timeout_s: 600, max_concurrent: 1, shell_user: true,
  };
  const forged = alex.d.core.emit("msg.post", { text: runText(shellRun, "alex-mbp"), seat: shellRun } as any,
    { channel: `seats-${alex.d.nodeId}`, agent: "orchestrator" });
  await waitFor(async () => (await alex.client("").seats(forged.id)).seats[0]?.state === "refused", { what: "execution host refuses shell seat" });
  expect((await alex.client("").seats(forged.id)).seats[0]?.reason).toContain("switch WalkieTalkie back to Walkie platform access");
  // 9. Orchestrator conversation routes (allowlisted) and agent-only reads.
  await T("POST", "/v1/orchestrator/say", { text: "hi" });
  await T("GET", "/v1/orchestrator/messages");
  // 10. Token check: no token / wrong token.
  const nt = await fetch("http://walkie/v1/me", { unix: sock } as RequestInit); console.log("PROBE3 no token:", nt.status);
  console.log("PROBE3 launch env:", JSON.stringify(launchRows().at(-1)?.env), "access_file=", launchRows().at(-1)?.access_file, "refresh_file=", launchRows().at(-1)?.refresh_file);
}, 90_000);

test("short Claude login is reprojected before expiry and a near-expiry restart waits for a fresh token", async () => {
  await alex.client("").seatsConfig({ allow: false });
  const shortExpiresAt = Date.now() + 4_000;
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "short-access", expiresAt: shortExpiresAt } }));
  const before = launchRows().length;
  await alex.client("").orchestratorModel("sonnet");
  await waitFor(() => launchRows().length > before, { what: "short login spawn" });
  const short = launchRows().length;
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "fresh-access", expiresAt: Date.now() + 3_600_000 } }));
  await waitFor(() => launchRows().length > short, { what: "scheduled login refresh", timeoutMs: 12_000 });
  expect(Date.now()).toBeLessThan(shortExpiresAt);
  expect((await alex.client("").orchestrator()).local.state).not.toBe("stopped");
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "almost-expired", expiresAt: Date.now() + 100 } }));
  const prior = launchRows().length;
  await alex.client("").orchestratorSay("crash please");
  await waitFor(async () => (await alex.client("").orchestrator()).local.state === "restarting", { what: "waiting for fresh login" });
  expect(launchRows().length).toBe(prior);
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "recovered-access", expiresAt: Date.now() + 3_600_000 } }));
  await waitFor(() => launchRows().length > prior, { what: "fresh login restart", timeoutMs: 8_000 });
  expect((await alex.client("").orchestrator()).local.state).not.toBe("stopped");
  await alex.client("").orchestratorAccess("platform");
  await alex.client("").seatsConfig({ allow: true, same_user: true, launchers: ["@alex/alex-mbp/orchestrator"] });
  const host: any = hostFor(alex.d.core);
  const platformRun = await fetch("http://walkie/v1/seats/run", { unix: alex.socket, method: "POST",
    headers: { "content-type": "application/json", "X-Walkie-Agent": "orchestrator", "X-Walkie-Orchestrator-Token": host.childToken },
    body: JSON.stringify({ machine: "alex-mbp", runtime: "claude", prompt: "platform orchestration" }) } as RequestInit);
  expect(platformRun.status).toBe(200);
}, 30_000);
