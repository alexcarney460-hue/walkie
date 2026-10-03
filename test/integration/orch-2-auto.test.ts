// ORCH-2 WalkieTalkie over real daemons with the FAKE claude: it starts on its own once a Claude login is there (not
// before: "needs a model login"), opens the first-run conversation once, restarts after a crash, stays stopped after a
// stop by hand (across a daemon restart) until started by hand; ONE lead per team (the roster authority), the other
// owner machine stands by, takes over when the lead is gone and hands back when it returns; the rename shows in the
// CLI (`walkie talkie`, alias `walkie orchestrator`) and `who`; and its own walkie CLI mints an add-machine link under
// AGENT-ADMIN-1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import type { Logins } from "../../src/daemon/orchestrator/logins.ts";
import type { OrchestratorView } from "../../src/protocol/orchestrator.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const FAKE_DIR = join(import.meta.dir, "..", "fixtures", "fake-claude");
const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const NONE: Logins = { found: [], claude: null };
const CLAUDE: Logins = { found: ["claude"], claude: "cli" };

function orchOpts(root: string, name: string, logins: () => Logins, auto = true) {
  const state = join(root, `fake-state-${name}`);
  mkdirSync(state, { recursive: true });
  return {
    restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50, auto, autoCheckMs: 150, leadOfflineMs: 1_500,
    logins: async () => logins(),
    env: { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: join(root, `launches-${name}.jsonl`) },
  };
}
const launches = (root: string, name: string) => {
  const f = join(root, `launches-${name}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter((l) => (JSON.parse(l) as { argv?: string[] }).argv?.includes("-p")).length : 0;
};
const view = async (n: TestNode) => (await n.client("").orchestrator()).local;
async function cli(n: TestNode, args: string[], tty = false) {
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: n.home, WALKIE_SOCKET: n.socket }, { tty });
}

describe("one machine: auto-start, first run, crash, sticky stop, rename", () => {
  let c: Cluster;
  let solo: TestNode;
  let logins = NONE;
  beforeAll(async () => {
    c = new Cluster();
    solo = await c.add({ name: "solo", login: "solo@example.com", hostname: "solo-mbp", orchestrator: orchOpts(mkdtempSync(join(tmpdir(), "orch2-auto-")), "x", () => logins) });
  }, 60_000);
  afterAll(async () => { await c.close(); });

  test("no Claude login: it waits (needs a model login, the one step), and starts on its own once one appears", async () => {
    // The fake-claude log lives under the cluster root: rebuild the node's options with it.
    await solo.stop();
    Object.assign(solo.spec, { orchestrator: orchOpts(c.root, "solo", () => logins) });
    await solo.start();
    await solo.client().init("acme", "solo");
    await waitFor(async () => (await view(solo)).state === "needs_login", { what: "needs_login" });
    const v = await view(solo);
    expect(v.needs).toContain("run: claude");
    expect(v.logins).toEqual([]);
    expect(v.running).toBe(false);
    expect(launches(c.root, "solo")).toBe(0);
    logins = { found: ["codex"], claude: null };
    await waitFor(async () => ((await view(solo)).needs ?? "").includes("Codex/Kimi support is coming"), { what: "codex-only text" });
    logins = CLAUDE;
    await waitFor(async () => (await view(solo)).running && (await view(solo)).state === "idle", { what: "started on its own", timeoutMs: 15_000 });
    const s = await view(solo);
    expect(s).toMatchObject({ auto: true, access: "platform", model_setting: "default", logins: ["claude"] });
    expect(launches(c.root, "solo")).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("first run: it opens a conversation itself, once (flag saved; not again after a daemon restart)", async () => {
    const opened = async () => (await solo.client("").orchestratorMessages({ limit: 500 })).messages.filter((m) => m.role === "orchestrator" && m.text.includes("[WalkieTalkie first run]"));
    await waitFor(async () => (await opened()).length === 1, { what: "the first-run greeting" });
    const greeting = (await opened())[0];
    const thread = (await solo.client("").orchestratorMessages({ thread: greeting?.thread })).messages;
    expect(thread.every((m) => m.role === "orchestrator")).toBe(true); // the person typed nothing
    const saved = JSON.parse(readFileSync(join(solo.home, "orchestrator.json"), "utf8")) as { onboarded_at?: number; mode?: string };
    expect(typeof saved.onboarded_at).toBe("number");
    expect(saved.mode).toBe("auto");
    await solo.restart();
    await waitFor(async () => (await view(solo)).running && (await view(solo)).state === "idle", { what: "resumed" });
    await Bun.sleep(600);
    expect((await opened()).length).toBe(1);
  }, 60_000);

  test("a crash restarts Claude with backoff and it keeps answering", async () => {
    const n = launches(c.root, "solo");
    const { message } = await solo.client("").orchestratorSay("crash now");
    // The restart waits out a backoff; on a loaded machine (a release gate) that can pass 10 s.
    await waitFor(async () => launches(c.root, "solo") > n && (await view(solo)).state === "idle", { what: "restarted", timeoutMs: 30_000 });
    expect((await view(solo)).restarts).toBeGreaterThanOrEqual(1);
    const next = await solo.client("").orchestratorSay("hello again", message.thread);
    await waitFor(async () => (await solo.client("").orchestratorMessages({ limit: 500 })).messages.some((m) => m.reply_to === next.message.id), { what: "a reply after the crash" });
  }, 60_000);

  test("the rename: walkie talkie (and the alias walkie orchestrator) and who say WalkieTalkie", async () => {
    // Running, whatever the crash test before it left (on a loaded machine it can end in "keeps failing").
    if (!(await view(solo)).running) await solo.client("").orchestratorStart({});
    await waitFor(async () => (await view(solo)).running && (await view(solo)).state === "idle", { what: "running", timeoutMs: 30_000 });
    const st = await cli(solo, ["talkie", "status", "--json"]);
    expect(st.code).toBe(0);
    expect((JSON.parse(st.out) as OrchestratorView).local).toMatchObject({ running: true, logins: ["claude"] });
    expect((await cli(solo, ["talkie", "status"])).out).toMatch(/^WalkieTalkie: running on this machine/);
    expect((await cli(solo, ["orchestrator", "status"])).out).toMatch(/^WalkieTalkie: running on this machine/);
    expect((await cli(solo, ["who", "--all"])).out).toMatch(/WalkieTalkie\s+(idle|working)/);
    expect((await cli(solo, ["help"])).out).toContain("talkie status [--json]");
  }, 60_000);

  test("a stop by hand sticks (ticks and a daemon restart leave it stopped); on the lead, Start means automatic (pre.8)", async () => {
    const st = await cli(solo, ["talkie", "stop"]);
    expect(st.out).toContain("stays stopped until you start it");
    await Bun.sleep(600);
    expect(await view(solo)).toMatchObject({ running: false, state: "stopped", stopped_by_hand: true, auto: false });
    await solo.restart();
    await Bun.sleep(800);
    expect((await view(solo)).running).toBe(false);
    expect((await cli(solo, ["talkie", "status"])).out).toContain("stopped by you");
    await waitFor(async () => { await solo.client("").orchestratorStart({ cwd: c.root }); return true; }, { what: "start after authority quarantine" });
    await waitFor(async () => (await view(solo)).running, { what: "started by hand" });
    expect((await view(solo)).stopped_by_hand).toBeUndefined();
    // pre.8: this machine leads, so Start means "run automatically": no manual mode, and it runs again after a restart
    expect((await view(solo)).auto).toBe(true);
    expect((JSON.parse(readFileSync(join(solo.home, "orchestrator.json"), "utf8")) as { mode?: string }).mode).toBe("auto");
    await solo.restart();
    await waitFor(async () => (await view(solo)).running, { what: "runs on its own after a restart" });
  }, 60_000);

  test("an owner's agent stop through admin is sticky across ticks and restart", async () => {
    const agent = new WalkieClient({ socket: solo.socket, underAgent: true });
    await agent.orchestratorStop();
    await Bun.sleep(600);
    expect(await view(solo)).toMatchObject({ running: false, stopped_by_hand: true });
    await solo.restart();
    await Bun.sleep(600);
    expect(await view(solo)).toMatchObject({ running: false, stopped_by_hand: true });
    await waitFor(async () => { await solo.client("").orchestratorStart({ cwd: c.root }); return true; }, { what: "start after authority quarantine" });
    await waitFor(async () => (await view(solo)).running, { what: "explicit start clears agent stop" });
  }, 30_000);

  test("walkie talkie auto (and the dashboard's Resume route) returns a stopped machine to automatic", async () => {
    await cli(solo, ["talkie", "stop"]);
    await waitFor(async () => (await view(solo)).stopped_by_hand === true, { what: "stopped" });
    expect((await view(solo)).running).toBe(false);
    const r = await cli(solo, ["talkie", "auto"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("automatic");
    await waitFor(async () => (await view(solo)).running, { what: "running again, automatically" });
    expect(await view(solo)).toMatchObject({ auto: true });
    expect((await view(solo)).stopped_by_hand).toBeUndefined();
    // the dashboard's Resume: the route is on the dashboard allow-list
    await solo.client("").orchestratorStop();
    const { nonce } = await solo.client().authNonce();
    const res = await fetch(`http://127.0.0.1:${solo.d.localPort as number}/auth?nonce=${nonce}`, { redirect: "manual" });
    const sess = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
    const h = { "X-Walkie-Session": sess, Origin: `http://127.0.0.1:${solo.d.localPort as number}`, "Content-Type": "application/json" };
    const resume = await fetch(`http://127.0.0.1:${solo.d.localPort as number}/v1/orchestrator/auto`, { method: "POST", headers: h, body: "{}" });
    expect(resume.status).toBe(200);
    await waitFor(async () => (await view(solo)).running, { what: "resumed from the dashboard" });
    await solo.client("").orchestratorStop();
  }, 60_000);
});

describe("one lead per team: the authority leads, an owner machine stands by, takes over and hands back", () => {
  let c: Cluster;
  let alex: TestNode;
  let kira: TestNode;
  beforeAll(async () => {
    c = new Cluster();
    alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator: orchOpts("/tmp", "unused", () => CLAUDE) });
    kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", orchestrator: orchOpts("/tmp", "unused", () => CLAUDE) });
    for (const [n, name] of [[alex, "alex"], [kira, "kira"]] as const) {
      await n.stop();
      Object.assign(n.spec, { orchestrator: orchOpts(c.root, name, () => CLAUDE) });
      await n.start();
    }
    await alex.client().init("acme", "alex");
    await alex.client().invite("kira@example.com", "kira", "owner");
    expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
  }, 60_000);
  afterAll(async () => { await c.close(); });

  test("the authority runs it; the other owner machine stands by naming the lead, with no Claude process", async () => {
    await waitFor(async () => (await view(alex)).running, { what: "alex leads", timeoutMs: 20_000 });
    await waitFor(async () => (await view(kira)).state === "standby" && (await view(kira)).lead === "alex-mbp", { what: "kira stands by", timeoutMs: 20_000 });
    await Bun.sleep(1_000);
    expect((await view(kira)).running).toBe(false);
    expect((await cli(kira, ["talkie", "status"])).out).toContain("standby (lead: alex-mbp)");
  }, 60_000);

  test("authority outage: standby stays fenced until the authority returns", async () => {
    const before = launches(c.root, "kira");
    await alex.stop();
    await Bun.sleep(3_000);
    expect((await view(kira)).running).toBe(false);
    expect(launches(c.root, "kira")).toBe(before);
    await alex.start();
    await waitFor(async () => (await view(alex)).running, { what: "alex leads again", timeoutMs: 20_000 });
    await waitFor(async () => (await view(kira)).state === "standby", { what: "kira hands back", timeoutMs: 20_000 });
    expect((await view(kira)).running).toBe(false);
  }, 90_000);

  test("a partitioned lease holder stops its child and cannot post or spawn under its old identity", async () => {
    await alex.client("").orchestratorStop();
    await waitFor(async () => (await view(kira)).running, { what: "standby holds lease" });
    const h = hostFor(kira.d.core)!;
    const token = await waitFor(() => { const t = (h as unknown as { childToken: string }).childToken; return t && h.acceptsToken(t) ? t : null; }, { what: "lease-bound child token" });
    const child = (h as unknown as { child: { alive: boolean; reaped: Promise<void> } }).child;
    expect(h.acceptsToken(token)).toBe(true);
    const request = kira.d.client.leadLease.bind(kira.d.client);
    kira.d.client.leadLease = async () => { throw new Error("partition"); };
    try {
      await alex.client("").orchestratorAuto();
      for (let i = 0; i < 25; i++) {
        expect(Number((await view(alex)).running) + Number((await view(kira)).running)).toBeLessThanOrEqual(1);
        await Bun.sleep(30);
      }
      expect((await view(kira)).running).toBe(false);
      expect(h.acceptsToken(token)).toBe(false);
      await child.reaped;
      expect(child.alive).toBe(false);
      for (const path of ["/v1/seats/run", "/v1/post", "/v1/tasks"]) {
        const res = await fetch(`http://127.0.0.1:${kira.d.localPort}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${kira.d.token}`, "Content-Type": "application/json",
            "X-Walkie-Agent": "orchestrator", "X-Walkie-Orchestrator-Token": token }, body: "{}",
        });
        expect(res.status).toBe(403);
      }
    } finally { kira.d.client.leadLease = request; }
    await waitFor(async () => (await view(alex)).running, { what: "authority holds next lease" });
  }, 30_000);

  test("the lead stopped by hand drops out: the next owner machine leads", async () => {
    await alex.client("").orchestratorStop();
    await waitFor(async () => (await view(kira)).running, { what: "kira leads", timeoutMs: 20_000 });
    expect((await view(alex)).running).toBe(false);
    // Returning the authority to auto waits for the standby lease to end before taking over.
    expect((await cli(alex, ["talkie", "auto"])).code).toBe(0);
    await waitFor(async () => (await view(alex)).running, { what: "alex leads again" });
    expect((await view(alex)).auto).toBe(true);
    await waitFor(async () => (await view(kira)).state === "standby", { what: "kira hands back", timeoutMs: 20_000 });
    // On kira (not the lead) a start by hand would mean two running: the CLI asks first (no terminal: refused unless --here).
    await waitFor(async () => (await view(kira)).lead === "alex-mbp", { what: "kira knows the lead" });
    const asked = await cli(kira, ["talkie", "start"]);
    expect(asked.code).not.toBe(0);
    expect(asked.err).toContain("WalkieTalkie is already running on alex-mbp; start here anyway?");
    const agentHere = await cli(kira, ["talkie", "start", "--here"]);
    expect(agentHere.err).toContain("exclusive lease");
    const agentBinary = await cli(kira, ["talkie", "start", "--here", "--claude", "/bin/sh"]);
    expect(agentBinary.err).toContain("only a person can choose WalkieTalkie");
    const here = await cli(kira, ["talkie", "start", "--here", "--cwd", c.root], true);
    expect(here.code).not.toBe(0);
    expect(here.err + here.out).toContain("exclusive lease");
    expect((await view(kira)).running).toBe(false);
    // walkie talkie auto: back to automatic: kira stands by again
    expect((await cli(kira, ["talkie", "auto"])).code).toBe(0);
    await waitFor(async () => (await view(kira)).state === "standby" && !(await view(kira)).running, { what: "kira automatic (standby)", timeoutMs: 20_000 });
  }, 90_000);
});

describe("its walkie CLI mints an add-machine link under agent admin (Walkie Direct)", () => {
  let c: Cluster;
  let alex: TestNode;
  beforeAll(async () => {
    c = new Cluster();
    alex = await c.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true, orchestrator: orchOpts("/tmp", "unused", () => NONE, false) });
    await alex.stop();
    Object.assign(alex.spec, { orchestrator: orchOpts(c.root, "alex", () => NONE, false) });
    await alex.start();
    await alex.client().init("acme", "alex");
  }, 60_000);
  afterAll(async () => { await c.close(); });

  test("ADDMACHINE: the orchestrator gets a receipt while its person gets the link; audited under its name", async () => {
    await alex.client("").orchestratorStart({ cwd: c.root });
    await waitFor(async () => (await view(alex)).state === "idle", { what: "idle" });
    const { message } = await alex.client("").orchestratorSay("please ADDMACHINE alex");
    await waitFor(async () => (await alex.client("").orchestratorMessages({ limit: 500 })).messages.some((m) => m.reply_to === message.id), { what: "reply", timeoutMs: 30_000 });
    const reply = (await alex.client("").orchestratorMessages({ limit: 500 })).messages.find((m) => m.reply_to === message.id);
    expect(reply?.text).toStartWith("minted: ");
    const res = JSON.parse((reply?.text ?? "").slice("minted: ".length)) as { delivered: boolean; handle: string; expires_at: number; command: string };
    expect(res.handle).toBe("alex");
    expect(res.delivered).toBe(true);
    expect(JSON.stringify(res)).not.toContain("wk1");
    expect((await alex.client("").orchestratorMessages({ limit: 500 })).messages.some((m) => m.text.includes("Link: https://getwalkie.vercel.app/join#wk1"))).toBe(true);
    expect(res.expires_at).toBeGreaterThan(Date.now());
    expect(readFileSync(join(alex.home, "admin-audit.jsonl"), "utf8")).toMatch(/orchestrator[^\n]*minted an add-machine link for @alex/);
  }, 60_000);
});

describe("pre.7 RC fixes (Codex): a stop beats a stale auto decision; pre.6 state migrates; a vault login is used on every boot and retry", () => {
  let c: Cluster;
  let node: TestNode;
  let logins: Logins = CLAUDE;
  const fakeVault = { list: () => [], claudeToken: async () => "vault-token-value" };
  beforeAll(async () => {
    c = new Cluster();
    node = await c.add({ name: "rc", login: "rc@example.com", hostname: "rc-mbp", orchestrator: orchOpts("/tmp", "unused", () => logins) });
    await node.stop();
    Object.assign(node.spec, { orchestrator: orchOpts(c.root, "rc", () => logins) });
    await node.start();
    await node.client().init("acme", "rc");
  }, 60_000);
  afterAll(async () => { await c.close(); });
  type Stale = { kind: "run" } | { kind: "standby"; lead: string | null } | { kind: "needs_login"; found: string[] };
  const host = () => hostFor(node.d.core) as unknown as {
    stopByHand(): Promise<void>; start(req: { cwd: string }): Promise<void>; serial<T>(op: () => Promise<T>): Promise<T>; applyAuto(d: Stale, gen?: number): Promise<void>;
    handGen: number;
  };
  const ownStatus = () => (JSON.parse(node.d.core.store.agent(node.d.core.nodeId, "orchestrator")?.body ?? "{}") as { state?: string }).state;
  const legacy = (active: boolean) => JSON.stringify({ active, owner: "rc", started_at: Date.now(), cwd: c.root, permission_mode: "default", claude: join(FAKE_DIR, "claude"), sessions: {} });

  test("HIGH 1: an auto `run` decided before a stop by hand, applied after it, doesn't restart it", async () => {
    await waitFor(async () => (await view(node)).running, { what: "auto started", timeoutMs: 15_000 });
    const h = host();
    const stop = h.stopByHand();
    const stale = h.serial(() => h.applyAuto({ kind: "run" })); // queued behind the stop, as a tick's would be
    await Promise.all([stop, stale]);
    await Bun.sleep(600); // several real ticks too
    expect(await view(node)).toMatchObject({ running: false, stopped_by_hand: true });
  }, 60_000);

  test("HIGH 2 + pre.8: a pre.6 idle state clears its invented stop; running on the lead remains automatic", async () => {
    await node.stop();
    writeFileSync(join(node.home, "orchestrator.json"), legacy(false));
    await node.start();
    await waitFor(async () => (await view(node)).running, { what: "legacy idle becomes automatic" });
    expect((await view(node)).stopped_by_hand).not.toBe(true);
    await node.stop();
    writeFileSync(join(node.home, "orchestrator.json"), legacy(true));
    await node.start();
    await waitFor(async () => (await view(node)).running, { what: "resumed as before" });
    // this machine leads: no manual mode on the lead (pre.8), so it becomes automatic on the first check
    await waitFor(async () => (JSON.parse(readFileSync(join(node.home, "orchestrator.json"), "utf8")) as { mode?: string }).mode === "auto", { what: "auto on the lead" });
    expect((await view(node)).auto).toBe(true);
  }, 60_000);

  test("pre.8 upgrade: a pre.7 manual file on the lead becomes automatic", async () => {
    await node.stop();
    writeFileSync(join(node.home, "orchestrator.json"), JSON.stringify({ ...JSON.parse(legacy(true)), mode: "manual", access: "platform" }));
    await node.start();
    await waitFor(async () => (JSON.parse(readFileSync(join(node.home, "orchestrator.json"), "utf8")) as { mode?: string }).mode === "auto", { what: "auto on the lead" });
    await waitFor(async () => (await view(node)).running, { what: "running" });
    expect((await view(node)).auto).toBe(true);
  }, 60_000);

  test("MEDIUM 3: a vault-only Claude login reaches the child on a boot and on a crash retry", async () => {
    logins = { found: ["claude"], claude: "vault", vaultAccount: "acct1" };
    node.d.core.vault = fakeVault;
    const envOf = () => {
      const lines = readFileSync(join(c.root, "launches-rc.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; env?: string[] });
      return lines.filter((l) => l.argv?.includes("-p")).at(-1)?.env ?? [];
    };
    let n = launches(c.root, "rc");
    await node.client("").orchestratorStop();
    await node.client("").orchestratorStart({ cwd: c.root }); // a boot
    await waitFor(async () => launches(c.root, "rc") > n && envOf().includes("CLAUDE_CODE_OAUTH_TOKEN"), { what: "booted with the vault login" });
    n = launches(c.root, "rc");
    await node.client("").orchestratorSay("crash please"); // a retry
    await waitFor(async () => launches(c.root, "rc") > n, { what: "retried" });
    await Bun.sleep(300); // the retry's own log line
    expect(envOf()).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    await node.client("").orchestratorStop();
  }, 60_000);

  test("RC delta MEDIUM: a stale standby / needs_login never stops a start by hand, nor republishes over a stop by hand", async () => {
    logins = CLAUDE;
    const h = host();
    for (const stale of [{ kind: "standby", lead: "kiras-mbp" }, { kind: "needs_login", found: [] }] as Stale[]) {
      // queued behind a start by hand: it keeps running
      await h.stopByHand();
      const g = h.handGen; // decided before the start
      const start = h.start({ cwd: c.root });
      const late = h.serial(() => h.applyAuto(stale, g));
      await Promise.all([start, late]);
      await Bun.sleep(400);
      expect({ stale: stale.kind, v: await view(node) }).toMatchObject({ stale: stale.kind, v: { running: true } });
      expect((await view(node)).state).not.toBe(stale.kind);
      // queued behind a stop by hand: it stays stopped, and its team status stays offline (not able to lead)
      const g2 = h.handGen;
      const stop = h.stopByHand();
      const late2 = h.serial(() => h.applyAuto(stale, g2));
      await Promise.all([stop, late2]);
      await Bun.sleep(400);
      expect({ stale: stale.kind, v: await view(node) }).toMatchObject({ stale: stale.kind, v: { running: false, state: "stopped", stopped_by_hand: true } });
      // (the offline status may wait for the status rate limit; nothing may republish over it afterwards)
      await waitFor(async () => ownStatus() === "offline", { what: `offline (${stale.kind})` });
      await Bun.sleep(600);
      expect({ stale: stale.kind, status: ownStatus() }).toEqual({ stale: stale.kind, status: "offline" });
    }
  }, 60_000);

  test("pre.8 clears a pre.7 invented stop flag", async () => {
    await host().start({ cwd: c.root }); // pre.6 ran it by hand: its status is live (idle)
    await waitFor(async () => ownStatus() === "idle", { what: "a live status" });
    await node.stop(); // a daemon stop leaves that status live
    writeFileSync(join(node.home, "orchestrator.json"), JSON.stringify({ ...JSON.parse(legacy(false)), stopped_by_hand: true }));
    await node.start();
    await waitFor(async () => (await view(node)).running, { what: "pre.7 invented stop cleared" });
    expect((await view(node)).stopped_by_hand).not.toBe(true);
  }, 60_000);
});

test("a promotion decided before a hand start cannot change the newer manual state", async () => {
  const { OrchestratorHost } = await import("../../src/daemon/orchestrator/host.ts");
  const proto = OrchestratorHost.prototype as unknown as { autoHost: (this: unknown) => { promote: (leads: boolean, gen: number) => Promise<void> } };
  const h = { state: { mode: "manual", active: true }, handGen: 2, serial: (f: () => unknown) => Promise.resolve(f()), save: () => {}, log: { info: () => {} } };
  await proto.autoHost.call(h).promote(true, 1);
  expect(h.state.mode).toBe("manual");
  await proto.autoHost.call(h).promote(true, 2);
  expect(h.state.mode).toBe("auto");
});
