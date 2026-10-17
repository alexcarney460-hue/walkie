// In-process synthetic daemon only: fake Codex, task-owned HOME, no external provider/network/model.
import { afterAll, beforeAll, expect, test, spyOn } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { inspectOssConfig, type OssFixtureRuntime } from "../../src/daemon/seats/oss-runtime.ts";
import { TERMINAL_STATES, seatAgentName, type SeatView } from "../../src/protocol/seats.ts";

let cluster: Cluster, node: TestNode, home: string, log: string, fixture: OssFixtureRuntime;
const linuxOnly = process.platform === "linux" ? test : test.skip;
let readiness: OssFixtureRuntime["readiness"] = async () => ({ service: true, model: true, resources: true });
const request = { runtime: "codex" as const, local_provider: "ollama" as const, model: "fake-local:1", v: 2 as const, prompt: "SOURCE FIXTURE ONLY", timeout_s: 10, max_concurrent: 3 };
const host = () => seatsFor(node.d.core)!;
const client = () => node.client("");
const localRun = (extra = {}) => client().seatRun({ ...request, machine: node.d.nodeId, ...extra });
const processStart = (pid: number): string | null => {
  const result = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)],
    { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
};
const end = (id: string) => waitFor(async () => {
  const seat = (await client().seats(id)).seats[0]; return seat && TERMINAL_STATES.has(seat.state as never) ? seat : null;
}, { timeoutMs: 20_000, what: "fake OSS completion" });

beforeAll(async () => {
  cluster = new Cluster(); home = join(cluster.root, "person"); mkdirSync(home);
  const bin = join(home, "bin"); mkdirSync(bin); log = join(home, "fake-log.jsonl");
  const binary = join(bin, "codex");
  writeFileSync(binary, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--oss --local-provider --model --ignore-user-config --sandbox --json --color --skip-git-repo-check'); process.exit(0); }
if (args[0] === 'login') process.exit(1);
const start = require('node:child_process').execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {encoding:'utf8'}).trim();
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,env:process.env,cwd:process.cwd(),pid:process.pid,start})+'\\n');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fake OSS source result'}}));
if (fs.existsSync(${JSON.stringify(join(home, 'hold'))})) setInterval(() => {}, 100);
else console.log(JSON.stringify({type:'turn.completed'}));
`, { mode: 0o700 });
  fixture = { evidence: "fake-runtime-only", configKnowledge: "fixture-only", binary, path: `${dirname(process.execPath)}:/usr/bin:/bin`,
    inspectConfig: (cwd) => inspectOssConfig(cwd, [join(home, "system-config")], {
      metadata: (p) => { if (!p.startsWith(cluster.root + "/") && p !== cluster.root) return null;
        try { return lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } },
      readText: (p) => readFileSync(p, "utf8"),
    }), readiness: (m, s) => readiness(m, s),
    probeReaders: { inventory: () => new Map(), session: () => null, identity: () => "source-fixture-leader" } };
  node = await cluster.add({ name: "alex", login: "alex@example.com", seats: { ossFixture: fixture,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, OPENAI_API_KEY: "synt" + "hetic-secret", CODEX_HOME: join(home, "poison-codex"),
      OLLAMA_HOST: "http://never.invalid", HTTPS_PROXY: "http://never.invalid", NODE_OPTIONS: "poison", UNKNOWN_SECRET: "poison" },
    keychain: async () => null, seatRegistration: () => ({ state: "absent" }), admin: async () => ({ ok: true, ids: [] }), launchesPerMinute: 100, flushMs: 50 } });
  await client().init("source-fixture", "alex");
  await client().seatsConfig({ allow: true, same_user: true });
  await waitFor(async () => (await client().seats()).local.channel_ok, { what: "synthetic seat channel" });
}, 30_000);
afterAll(async () => {
  const children = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const { pid, start } = JSON.parse(line); return { pid: pid as number, start: start as string };
  }) : [];
  await cluster?.close();
  for (const child of children) {
    expect(processStart(child.pid)).not.toBe(child.start);
  }
  console.log(JSON.stringify({ fixture_children: children, all_reaped_or_pid_reused: true }));
}, 30_000);

test("separate consent rejects agents and under-agent callers and preserves existing settings", async () => {
  const before = { ...host().settings };
  await expect(node.client("builder").seatsCodexOss(true)).rejects.toThrow();
  const response = await fetch("http://walkie/v1/seats/codex-oss", { unix: node.socket, method: "POST",
    headers: { "content-type": "application/json", "x-walkie-under-agent": "1" }, body: JSON.stringify({ codex_oss_ollama: true }) } as RequestInit);
  expect(response.status).toBe(403);
  await client().seatsCodexOss(true);
  expect(host().settings).toEqual({ ...before, codex_oss_ollama: true });
}, 30_000);

test("fake OSS launches with zero credential, lease, login and same-user projection calls", async () => {
  const sourced = join(home, "forbidden-source-marker");
  writeFileSync(join(node.home, "seat-env"), `touch '${sourced}'\nexport UNKNOWN_SECRET=poison\n`);
  const forbidden = ["refreshLogin", "recheckLogin", "sameUserEnv", "bindAccount", "codexProjection", "codexAuthFile", "dedicatedToken", "claudeCredentials"];
  const spies = forbidden.map((name) => spyOn(host() as any, name).mockImplementation(() => { throw new Error(`FORBIDDEN ${name}`); }));
  try {
    const { seat } = await localRun();
    const completed = await end(seat);
    expect(completed.state).toBe("done");
    expect(completed.output.some((o) => o.text.includes("fake OSS source result"))).toBe(true);
    const record = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
    expect(record.args).toContain("--oss"); expect(record.args).toContain('cli_auth_credentials_store="file"');
    expect(Object.keys(record.env).sort()).toEqual(["PATH", "LANG", "LC_ALL", "TERM", "HOME", "CODEX_HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "WALKIE_AGENT", "WALKIE_SOCKET", "WALKIE_SEAT_TOKEN_FILE"].sort());
    expect(record.env.HOME).not.toBe(home); expect(record.env.WALKIE_SOCKET).not.toBe(node.socket);
    expect(existsSync(record.env.HOME)).toBe(false);
    expect(existsSync(record.env.WALKIE_SEAT_TOKEN_FILE)).toBe(false);
    await client().seatsDoctor("ollama"); await client().seats();
    await client().seatsCodexOss(false); await client().seatsDoctor("ollama"); await client().seatsCodexOss(true);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(existsSync(sourced)).toBe(false);
  } finally { for (const spy of spies) spy.mockRestore(); rmSync(join(node.home, "seat-env"), { force: true }); }
}, 30_000);

test("resource/service/model unknown never falls back to authenticated spawn", async () => {
  const before = readFileSync(log, "utf8");
  for (const dimension of ["resources", "service", "model"]) {
    readiness = async () => ({ service: true, model: true, resources: true, [dimension]: false });
    const { seat } = await localRun(); expect((await end(seat)).state).toBe("refused");
  }
  readiness = async () => ({ service: true, model: true, resources: true });
  expect(readFileSync(log, "utf8")).toBe(before);
}, 30_000);

test("readiness rejection does not put a local path in shared seat state", async () => {
  const privatePath = "/private/synthetic-case/tenant-alpha";
  readiness = async () => { throw new Error(`readiness failed at ${privatePath}`); };
  try {
    await client().seatsCodexOss(true);
    const { seat } = await localRun();
    const completed = await end(seat);
    console.log(JSON.stringify({ state: completed.state, reason: completed.reason }));
    expect(completed.state).toBe("failed");
    expect(completed.reason).toBe("local OSS readiness check failed");
  } finally { readiness = async () => ({ service: true, model: true, resources: true }); }
}, 30_000);

test("readiness result getter does not put a local path in shared seat state", async () => {
  const privatePath = "/private/synthetic-case/tenant-alpha";
  readiness = async () => ({
    get service(): boolean { throw new Error(`readiness getter failed at ${privatePath}`); },
    model: true, resources: true,
  });
  try {
    await client().seatsCodexOss(true);
    const { seat } = await localRun();
    const completed = await end(seat);
    console.log(JSON.stringify({ state: completed.state, reason: completed.reason }));
    expect(completed.state).toBe("failed");
    expect(completed.reason).toBe("local OSS readiness check failed");
  } finally { readiness = async () => ({ service: true, model: true, resources: true }); }
}, 30_000);

test("configuration inspection errors do not put local paths in shared seat state", async () => {
  const original = fixture.inspectConfig;
  const privatePath = "/private/synthetic-case/tenant-alpha";
  fixture.inspectConfig = () => { throw new Error(`inspection failed at ${privatePath}`); };
  try {
    await client().seatsCodexOss(true);
    const { seat } = await localRun();
    const completed = await end(seat);
    expect(completed.state).toBe("failed");
    expect(completed.reason).toBe("local OSS configuration check failed");
  } finally { fixture.inspectConfig = original; }
}, 30_000);

test("late configuration inspection does not leak local path", async () => {
  const original = fixture.inspectConfig;
  const privatePath = "/private/synthetic-case/late-tenant";
  let calls = 0;
  fixture.inspectConfig = (cwd) => {
    if (++calls === 2) throw new Error(`late inspection failed at ${privatePath}`);
    original(cwd);
  };
  try {
    await client().seatsCodexOss(true);
    const { seat } = await localRun();
    const completed = await end(seat);
    console.log(JSON.stringify({ calls, state: completed.state, reason: completed.reason }));
    expect(completed.state).toBe("failed");
    expect(completed.reason).toBe("local OSS configuration check failed");
  } finally { fixture.inspectConfig = original; }
}, 30_000);

test("successful probe with a completed group child leaves the pool unblocked", async () => {
  const original = readFileSync(fixture.binary, "utf8");
  writeFileSync(fixture.binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  const child = require('node:child_process').spawnSync('/usr/bin/true', [], { stdio: 'ignore' });
  if (child.status !== 0) process.exit(1);
  console.log('codex-cli 0.160.0'); process.exit(0);
}
if (args.includes('--help')) { console.log('--oss --local-provider --model --ignore-user-config --sandbox --json --color --skip-git-repo-check'); process.exit(0); }
console.log(JSON.stringify({type:'turn.completed'}));
`);
  try {
    await client().seatsCodexOss(true);
    const { seat } = await localRun();
    expect((await end(seat)).state).toBe("done");
    await client().seatsConfig({ allow: false });
    expect(host().poolBlock()).toBeNull();
  } finally {
    writeFileSync(fixture.binary, original);
    await client().seatsConfig({ allow: true, same_user: true });
  }
}, 30_000);

test("opt-out during async readiness invalidates preparation and judged request never revives", async () => {
  let release!: () => void, entered = false;
  readiness = async () => { entered = true; await new Promise<void>((r) => { release = r; }); return { service: true, model: true, resources: true }; };
  const before = readFileSync(log, "utf8"); const { seat } = await localRun();
  await waitFor(() => entered, { what: "held readiness" });
  const off = client().seatsCodexOss(false);
  await waitFor(() => host().settings.codex_oss_ollama === false);
  release(); await off; expect((await end(seat)).state).toBe("stopped");
  await client().seatsCodexOss(true); await Bun.sleep(100);
  expect(readFileSync(log, "utf8")).toBe(before);
  readiness = async () => ({ service: true, model: true, resources: true });
}, 30_000);

test("queued local request survives as local, then opt-out invalidates it", async () => {
  await client().seatsBusy({ max: 0 });
  const { seat } = await localRun();
  await waitFor(async () => (await client().seats(seat)).seats.find((s) => s.state === "queued"));
  const view = (await client().seats(seat)).seats[0]!;
  expect(view.local_provider).toBe("ollama");
  expect(JSON.parse(readFileSync(join(node.home, "seats.json"), "utf8")).queued).toContain(seat);
  expect(node.d.core.store.queryEvents({ kinds: ["msg.post"], limit: 100 }).find((r) => r.id === seat)?.json).toContain('"local_provider":"ollama"');
  await client().seatsCodexOss(false); expect((await end(seat)).state).toBe("stopped");
  await client().seatsResume(); await client().seatsCodexOss(true);
});

test("policy, enrollment, launcher and executable races across readiness refuse before spawn", async () => {
  const h = host() as any;
  const changes: Array<() => () => void> = [
    () => { const saved = h.current; h.current = { ...saved, same_user: false }; return () => { h.current = saved; }; },
    () => { const saved = h.current; h.current = { ...saved, inherit_person_config: true }; return () => { h.current = saved; }; },
    () => { const saved = h.current; h.current = { ...saved, tools: { allow: [] } }; return () => { h.current = saved; }; },
    () => { const saved = h.current; h.current = { ...saved, launchers: ["@nobody"] }; return () => { h.current = saved; }; },
    () => { const spy = spyOn(h, "enrollmentRefusal").mockReturnValue("unreadable enrollment"); return () => spy.mockRestore(); },
    () => { const spy = spyOn(h, "recheckLaunch").mockReturnValue({ kind: "lost", why: "host no longer admitted" }); return () => spy.mockRestore(); },
    () => { const saved = readFileSync(fixture.binary, "utf8"); writeFileSync(fixture.binary, saved + "\n// replaced\n"); return () => writeFileSync(fixture.binary, saved); },
    () => { const spy = spyOn(node.d.core.pool!, "seatsConflict").mockReturnValue("seats_pool_conflict: uncertain model cleanup"); return () => spy.mockRestore(); },
  ];
  const before = readFileSync(log, "utf8");
  for (const change of changes) {
    let restore = () => {};
    readiness = async () => { restore = change(); return { service: true, model: true, resources: true }; };
    try {
      const { seat } = await localRun(); const result = await end(seat);
      expect(["refused", "failed"]).toContain(result.state);
    } finally { restore(); }
  }
  readiness = async () => ({ service: true, model: true, resources: true });
  expect(readFileSync(log, "utf8")).toBe(before);
}, 30_000);

test("absence of injected source runtime stays UNVERIFIED even with consent and available fake model", async () => {
  const h = host() as any, saved = h.opts.ossFixture;
  const before = readFileSync(log, "utf8");
  h.opts.ossFixture = undefined;
  try {
    const { seat } = await localRun();
    expect((await end(seat)).reason).toContain("UNVERIFIED");
    expect((await client().seatsDoctor("ollama")).local.codex_oss).toMatchObject({ native: "UNVERIFIED", ready: false });
  } finally { h.opts.ossFixture = saved; }
  expect(readFileSync(log, "utf8")).toBe(before);
});

test("queued OSS shuts down and remains judged across restart without paid conversion", async () => {
  await client().seatsBusy({ max: 0 });
  const { seat } = await localRun();
  await waitFor(async () => (await client().seats(seat)).seats.find((s) => s.state === "queued"));
  const before = readFileSync(log, "utf8");
  await node.restart();
  const result = await end(seat); expect(TERMINAL_STATES.has(result.state as never)).toBe(true);
  expect(result.local_provider).toBe("ollama");
  await client().seatsResume(); await Bun.sleep(100);
  expect(readFileSync(log, "utf8")).toBe(before);
}, 30_000);

test("busy pause/resume, explicit stop and timeout control only the fake child", async () => {
  const marker = join(home, "hold"); writeFileSync(marker, "fixture");
  try {
    const { seat } = await localRun();
    await waitFor(async () => (await client().seats(seat)).seats.find((s) => s.state === "running"));
    await client().seatsBusy({ max: 0 });
    await waitFor(async () => (await client().seats(seat)).seats.find((s) => s.state === "paused"));
    await client().seatsResume();
    await waitFor(async () => (await client().seats(seat)).seats.find((s) => s.state === "running"));
    await client().seatStop(seat); expect((await end(seat)).state).toBe("stopped");
    const timed = await localRun(); expect((await end(timed.seat)).state).toBe("timeout");
    expect(existsSync(marker)).toBe(true); // external service/provider state is never owned by cleanup
  } finally { rmSync(marker, { force: true }); }
}, 30_000);

test("cleanup refuses a substituted root, retains uncertainty, and never follows it into provider state", async () => {
  const marker = join(home, "hold"); writeFileSync(marker, "fixture");
  const provider = join(home, "external-provider"); mkdirSync(provider); writeFileSync(join(provider, "keep"), "never delete");
  const { seat } = await localRun();
  await waitFor(async () => (await client().seats(seat)).seats.find((s) => s.state === "running"));
  const record = await waitFor(() => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.env.WALKIE_AGENT === seatAgentName(seat)));
  const root = dirname(record.env.HOME), held = root + ".held";
  renameSync(root, held); symlinkSync(provider, root);
  try {
    await client().seatStop(seat); await end(seat);
    const pending = await waitFor(async () => (await client().seats()).local.pending_worker_roots?.find((r) => r.id.startsWith(seat + "@")));
    expect(readFileSync(join(provider, "keep"), "utf8")).toBe("never delete");
    rmSync(root); renameSync(held, root);
    host().cleanupPendingRoot(pending.id, () => false); // injected proof for the reaped fake process only
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(join(provider, "keep"), "utf8")).toBe("never delete");
  } finally {
    if (existsSync(held)) { rmSync(root, { force: true }); renameSync(held, root); }
    rmSync(marker, { force: true });
  }
}, 30_000);

async function failedConsent(enabled: boolean): Promise<Error> {
  const old = node.d.core.paths.config, blocked = join(home, "blocked-config");
  mkdirSync(blocked, { recursive: true });
  node.d.core.paths.config = blocked;
  try { return await host().configureOss(enabled).then(() => new Error("unexpected success"), (e) => e); }
  finally { node.d.core.paths.config = old; }
}
for (const phase of ["running", "preparing", "queued"] as const) test(`failed opt-out persistence revokes ${phase} local work without revival`, async () => {
  await client().seatsCodexOss(true);
  const before = { ...host().settings }, marker = join(home, "hold");
  let entered = false, release = () => {};
  if (phase === "running") writeFileSync(marker, "fixture");
  if (phase === "queued") await client().seatsBusy({ max: 0 });
  if (phase === "preparing") readiness = async () => { entered = true; await new Promise<void>((r) => { release = r; }); return { service: true, model: true, resources: true }; };
  const { seat } = await localRun();
  try {
    await waitFor(async () => phase === "preparing" ? entered : (await client().seats(seat)).seats.some((s) => s.state === phase));
    const error = await failedConsent(false);
    expect(host().settings).toEqual({ ...before, codex_oss_ollama: false });
    expect(error.message).toContain("config.json could not be written");
    expect(error.message).toContain("restart");
    expect(host().isRunning(seat)).toBe(false);
    expect((await end(seat)).state).toBe("stopped");
    const refused = await localRun(); expect((await end(refused.seat)).state).toBe("refused");
    // The disk still records true. In-process safety must not be presented as durable opt-out.
    expect(JSON.parse(readFileSync(node.d.core.paths.config, "utf8")).seats.codex_oss_ollama).toBe(true);
    release(); readiness = async () => ({ service: true, model: true, resources: true });
    const logged = existsSync(log) ? readFileSync(log, "utf8") : "";
    await client().seatsCodexOss(true); await client().seatsResume(); await Bun.sleep(100);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(logged);
    expect((await end(seat)).state).toBe("stopped");
    expect((await end(refused.seat)).state).toBe("refused");
  } finally {
    release(); readiness = async () => ({ service: true, model: true, resources: true });
    await client().seatStop(seat); await end(seat); rmSync(marker, { force: true });
    await client().seatsCodexOss(false); await client().seatsResume(); await client().seatsCodexOss(true);
  }
}, 30_000);

test("failed enable stays off; failed disable generation wins a deciding/re-enable race", async () => {
  await client().seatsCodexOss(false);
  const before = { ...host().settings };
  expect((await failedConsent(true)).message).not.toBe("unexpected success");
  expect(host().settings).toEqual(before);
  const refused = await localRun(); expect((await end(refused.seat)).state).toBe("refused");
  await client().seatsCodexOss(true);
  let entered = false, release!: (why: null) => void;
  const spy = spyOn(host() as any, "toolRefusal").mockImplementation(() => { entered = true; return new Promise((r) => { release = r; }); });
  const { seat } = await localRun();
  try {
    await waitFor(() => entered);
    expect((await failedConsent(false)).message).toContain("restart");
    expect(host().settings.codex_oss_ollama).toBe(false);
    await client().seatsCodexOss(true); release(null);
    expect((await end(seat)).reason).toContain("revoked while deciding");
  } finally { release?.(null); spy.mockRestore(); }
  const next = await localRun(); expect((await end(next.seat)).state).toBe("done");
  expect((await end(refused.seat)).state).toBe("refused");
}, 30_000);

test("failed local opt-out leaves running and queued authenticated Codex seats intact", async () => {
  const h = host() as any, marker = join(home, "hold");
  writeFileSync(marker, "fixture");
  // Synthetic login projection only; actual authenticated launch/queue paths still execute.
  const projection = spyOn(h, "codexProjection").mockResolvedValue({ copy: '{"fixture":true}', source: join(home, "synthetic-codex") });
  const login = spyOn(h, "recheckLogin").mockResolvedValue(undefined);
  const authRun = () => client().seatRun({ machine: node.d.nodeId, runtime: "codex", prompt: "synthetic authenticated seat", timeout_s: 30, max_concurrent: 3 });
  let running = "", queued = "";
  try {
    running = (await authRun()).seat;
    await waitFor(() => h.isRunning(running));
    await client().seatsBusy({ max: 0 });
    queued = (await authRun()).seat;
    await waitFor(async () => (await client().seats(queued)).seats.some((s) => s.state === "queued"));
    expect((await failedConsent(false)).message).toContain("restart");
    expect(h.isRunning(running)).toBe(true);
    expect((await client().seats(queued)).seats[0]!.state).toBe("queued");
    await client().seatStop(running); await end(running); running = "";
    rmSync(marker); await client().seatsResume();
    expect((await end(queued)).state).toBe("done");
    const record = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
    expect(record.args).not.toContain("--oss");
  } finally {
    if (running) { await client().seatStop(running); await end(running); }
    if (queued) { await client().seatStop(queued); await end(queued); }
    rmSync(marker, { force: true }); projection.mockRestore(); login.mockRestore();
    await client().seatsResume(); await client().seatsCodexOss(true);
  }
}, 30_000);

test("verified normal fake child cleanup clears pool exclusion after deny", async () => {
  await client().seatsCodexOss(true); writeFileSync(join(home, "hold"), "fixture");
  const { seat } = await localRun();
  try {
    const active = await waitFor(() => { const s = (host() as any).seats.get(seat); return s?.child ? s : null; });
    expect(host().poolBlock()).not.toBeNull();
    const root = active.workerRoot.root;
    await client().seatStop(seat); await end(seat);
    expect(existsSync(root)).toBe(false);
    expect(host().pendingWorkerRoots()).toEqual([]);
    await client().seatsConfig({ allow: false });
    expect(host().poolBlock()).toBeNull();
    await node.restart();
    await waitFor(() => host().poolBlock() === null, { what: "synthetic helper startup after verified cleanup" });
    expect(host().poolBlock()).toBeNull();
  } finally {
    rmSync(join(home, "hold"), { force: true });
    await client().seatStop(seat); await client().seatsConfig({ allow: true, same_user: true });
    await client().seatsCodexOss(true);
  }
}, 30_000);

for (const persistence of ["saved", "write-failed", "missing-state"] as const)
linuxOnly(`uncertain probe custody holds pool through deny/restart with ${persistence} pending state (Linux setsid and /proc)`, async () => {
  await client().seatsCodexOss(true);

  const original = readFileSync(fixture.binary, "utf8"), marker = join(home, "probe-holder-" + persistence);
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  writeFileSync(fixture.binary, `#!/bin/sh
/usr/bin/setsid /bin/sh -c 'cat /proc/$$/stat > "${marker}"; exec /bin/sleep 5' &
while [ ! -s "${marker}" ]; do sleep 0.01; done
printf 'codex-cli 0.160.0\\n'
exit 0
`);
  let seat = "", saveSpy: ReturnType<typeof spyOn> | undefined;
  const h = host() as any, oldState = h.statePath;
  try {
    seat = (await localRun()).seat;
    await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8").length > 0);
    if (persistence === "write-failed") {
      const blocked = join(home, "blocked-pending-state"); mkdirSync(blocked, { recursive: true }); h.statePath = blocked;
    }
    const at = performance.now();
    await client().seatsCodexOss(false);
    expect(performance.now() - at).toBeLessThan(1000);
    expect((await end(seat)).state).toBe("stopped");
    const pending = host().pendingWorkerRoots().find((r) => r.id.startsWith(seat + "@"))!;
    expect(pending.reason).toBe("process identity unknown");
    if (persistence !== "write-failed") expect(JSON.parse(readFileSync(join(node.home, "seats.json"), "utf8")).pending_roots).toContainEqual({ id: pending.id, uncertain: true });
    (host() as any).retryPendingRoots();
    expect(host().pendingWorkerRoots()).toContainEqual(pending);
    expect(() => host().cleanupPendingRoot(pending.id, () => false)).toThrow("nothing was removed");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
    await client().seatsConfig({ allow: false });
    expect(host().poolBlock()).toContain("worker root");
    if (persistence === "missing-state") {
      rmSync(oldState); saveSpy = spyOn(h, "save").mockReturnValue(false); // owned state-loss fixture; keep close from repairing it
    }
    writeFileSync(fixture.binary, original); // restart never invokes the adversarial probe as a login fixture
    await node.restart();
    expect(host().settings.allow).toBe(false);
    const recovered = host().pendingWorkerRoots().find((r) => r.id === pending.id);
    expect(recovered?.reason).toBe("process identity unknown");
    expect(host().poolBlock()).toContain("worker root");
    const raw = readFileSync(marker, "utf8"), pid = Number(raw.slice(0, raw.indexOf(" ")));
    const stamp = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
    const now = readFileSync(`/proc/${pid}/stat`, "utf8");
    expect(now.slice(now.lastIndexOf(")") + 2).split(" ")[19]).toBe(stamp);
    console.log(JSON.stringify({ persistence, holder_alive: true, pending: recovered, pool_block: host().poolBlock() }));
  } finally {
    saveSpy?.mockRestore(); h.statePath = oldState;
    writeFileSync(fixture.binary, original);
    if (existsSync(marker)) {
      const raw = readFileSync(marker, "utf8"), pid = Number(raw.slice(0, raw.indexOf(" ")));
      const start = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
      let current: string | undefined;
      try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); current = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; } catch { /* fixture already exited */ }
      if (current === start) process.kill(pid, "SIGKILL");
      console.log(JSON.stringify({ owned_probe_holder: { pid, start }, signalled: current === start }));
    }
    if (seat) { await client().seatStop(seat); await end(seat); }
    await client().seatsConfig({ allow: true, same_user: true }); await client().seatsCodexOss(true);
  }
}, 30_000);


test("unknown worker-root inventory holds pool until a later startup can inspect it", async () => {
  const c = new Cluster(), synthetic = join(c.root, "inventory-home"); mkdirSync(synthetic);
  const roots = join(synthetic, ".walkie-workers"); writeFileSync(roots, "not a directory");
  try {
    const n = await c.add({ name: "inventory", login: "inventory@example.com", seats: {
      env: { HOME: synthetic, PATH: "/nonexistent-fixture-bin" }, keychain: async () => null,
      seatRegistration: () => ({ state: "absent" }), admin: async () => ({ ok: true, ids: [] }),
    } });
    await n.client("").init("inventory-fixture", "inventory");
    expect(seatsFor(n.d.core)!.settings.allow).not.toBe(true);
    expect(seatsFor(n.d.core)!.pendingWorkerRoots()).toEqual([]);
    expect(seatsFor(n.d.core)!.poolBlock()).toContain("worker root");
    rmSync(roots); // only the synthetic ordinary file this test created; no roots/processes existed here
    await n.restart();
    await waitFor(() => seatsFor(n.d.core)!.poolBlock() === null, { what: "synthetic helper startup after inventory inspection" });
    expect(seatsFor(n.d.core)!.poolBlock()).toBeNull();
  } finally { await c.close(); }
}, 30_000);

linuxOnly("clean-environment detached probe retains its root and blocks the pool after deny (Linux /proc identity and environment)", async () => {
  const original = readFileSync(fixture.binary, "utf8"), marker = join(home, "escaped-success-holder");
  writeFileSync(fixture.binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  const child = require('node:child_process').spawn('/bin/sleep', ['5'], { detached: true, env: {}, cwd: '/', stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(marker)}, fs.readFileSync('/proc/' + child.pid + '/stat'));
  child.unref();
  console.log('codex-cli 0.160.0'); process.exit(0);
}
if (process.argv.includes('--help')) { console.log('--oss --local-provider --model --ignore-user-config --sandbox --json --color --skip-git-repo-check'); process.exit(0); }
console.log(JSON.stringify({type:'turn.completed'}));
`);
  try {
    await client().seatsCodexOss(true);
    const { seat } = await localRun();
    expect((await end(seat)).state).toBe("failed");
    const pending = host().pendingWorkerRoots().find((r) => r.id.startsWith(seat + "@"));
    expect(pending?.reason).toBe("process identity unknown");
    await client().seatsConfig({ allow: false });
    expect(host().poolBlock()).toContain("worker root");
  } finally {
    writeFileSync(fixture.binary, original);
    if (existsSync(marker)) {
      const raw = readFileSync(marker, "utf8"), pid = Number(raw.slice(0, raw.indexOf(" ")));
      const start = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const current = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
        if (current === start) process.kill(pid, "SIGKILL");
      } catch { /* exited */ }
    }
    await client().seatsConfig({ allow: true, same_user: true });
  }
}, 30_000);
