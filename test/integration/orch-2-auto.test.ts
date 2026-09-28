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
async function cli(n: TestNode, args: string[]) {
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: n.home, WALKIE_SOCKET: n.socket });
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
    await waitFor(async () => launches(c.root, "solo") > n && (await view(solo)).state === "idle", { what: "restarted" });
    expect((await view(solo)).restarts).toBeGreaterThanOrEqual(1);
    const next = await solo.client("").orchestratorSay("hello again", message.thread);
    await waitFor(async () => (await solo.client("").orchestratorMessages({ limit: 500 })).messages.some((m) => m.reply_to === next.message.id), { what: "a reply after the crash" });
  }, 60_000);

  test("the rename: walkie talkie (and the alias walkie orchestrator) and who say WalkieTalkie", async () => {
    const st = await cli(solo, ["talkie", "status", "--json"]);
    expect(st.code).toBe(0);
    expect((JSON.parse(st.out) as OrchestratorView).local).toMatchObject({ running: true, logins: ["claude"] });
    expect((await cli(solo, ["talkie", "status"])).out).toMatch(/^WalkieTalkie: running on this machine/);
    expect((await cli(solo, ["orchestrator", "status"])).out).toMatch(/^WalkieTalkie: running on this machine/);
    expect((await cli(solo, ["who", "--all"])).out).toMatch(/WalkieTalkie\s+(idle|working)/);
    expect((await cli(solo, ["help"])).out).toContain("talkie status [--json]");
  }, 60_000);

  test("a stop by hand sticks (ticks and a daemon restart leave it stopped) until it is started by hand", async () => {
    const st = await cli(solo, ["talkie", "stop"]);
    expect(st.out).toContain("stays stopped until you start it");
    await Bun.sleep(600);
    expect(await view(solo)).toMatchObject({ running: false, state: "stopped", stopped_by_hand: true, auto: false });
    await solo.restart();
    await Bun.sleep(800);
    expect((await view(solo)).running).toBe(false);
    expect((await cli(solo, ["talkie", "status"])).out).toContain("stopped by hand");
    await solo.client("").orchestratorStart({ cwd: c.root });
    await waitFor(async () => (await view(solo)).running, { what: "started by hand" });
    expect((await view(solo)).stopped_by_hand).toBeUndefined();
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

  test("the lead goes away: the standby takes over; it comes back: the standby hands back", async () => {
    const before = launches(c.root, "kira");
    await alex.stop();
    await waitFor(async () => (await view(kira)).running, { what: "kira takes over", timeoutMs: 20_000 });
    await waitFor(async () => launches(c.root, "kira") > before, { what: "kira's Claude launched" });
    await alex.start();
    await waitFor(async () => (await view(alex)).running, { what: "alex leads again", timeoutMs: 20_000 });
    await waitFor(async () => (await view(kira)).state === "standby", { what: "kira hands back", timeoutMs: 20_000 });
    expect((await view(kira)).running).toBe(false);
  }, 90_000);

  test("the lead stopped by hand drops out: the next owner machine leads", async () => {
    await alex.client("").orchestratorStop();
    await waitFor(async () => (await view(kira)).running, { what: "kira leads", timeoutMs: 20_000 });
    expect((await view(alex)).running).toBe(false);
    // A start by hand here now would mean two running: the CLI asks first (no terminal: refused unless --here).
    await waitFor(async () => (await view(alex)).lead === "kiras-mbp", { what: "alex knows the lead" });
    const asked = await cli(alex, ["talkie", "start", "--cwd", c.root]);
    expect(asked.code).not.toBe(0);
    expect(asked.err).toContain("WalkieTalkie is already running on kiras-mbp; start here anyway?");
    expect((await view(alex)).running).toBe(false);
    const here = await cli(alex, ["talkie", "start", "--here", "--cwd", c.root]);
    expect(here.code).toBe(0);
    await waitFor(async () => (await view(alex)).running, { what: "alex started by hand" });
  }, 60_000);
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

  test("ADDMACHINE: the orchestrator's own `walkie team add-machine alex --json` returns a link; audited under its name", async () => {
    await alex.client("").orchestratorStart({ cwd: c.root });
    await waitFor(async () => (await view(alex)).state === "idle", { what: "idle" });
    const { message } = await alex.client("").orchestratorSay("please ADDMACHINE alex");
    await waitFor(async () => (await alex.client("").orchestratorMessages({ limit: 500 })).messages.some((m) => m.reply_to === message.id), { what: "reply", timeoutMs: 30_000 });
    const reply = (await alex.client("").orchestratorMessages({ limit: 500 })).messages.find((m) => m.reply_to === message.id);
    expect(reply?.text).toStartWith("minted: ");
    const res = JSON.parse((reply?.text ?? "").slice("minted: ".length)) as { link: string; handle: string; expires_at: number; command: string };
    expect(res.handle).toBe("alex");
    expect(res.link).toMatch(/^https:\/\//);
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
    stopByHand(): Promise<void>; start(req: { cwd: string }): Promise<void>; serial<T>(op: () => Promise<T>): Promise<T>; applyAuto(d: Stale): Promise<void>;
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

  test("HIGH 2: a pre.6 state file: stopped stays stopped (sticky); running keeps running as a start by hand", async () => {
    await node.stop();
    writeFileSync(join(node.home, "orchestrator.json"), legacy(false));
    await node.start();
    await Bun.sleep(800);
    expect(await view(node)).toMatchObject({ running: false, stopped_by_hand: true });
    await node.stop();
    writeFileSync(join(node.home, "orchestrator.json"), legacy(true));
    await node.start();
    await waitFor(async () => (await view(node)).running, { what: "resumed as before" });
    expect((await view(node)).auto).toBe(false); // a start by hand: outside the election
    expect((JSON.parse(readFileSync(join(node.home, "orchestrator.json"), "utf8")) as { mode?: string }).mode).toBe("manual");
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
    await waitFor(async () => launches(c.root, "rc") > n, { what: "booted" });
    expect(envOf()).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    n = launches(c.root, "rc");
    await node.client("").orchestratorSay("crash please"); // a retry
    await waitFor(async () => launches(c.root, "rc") > n, { what: "retried" });
    expect(envOf()).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    await node.client("").orchestratorStop();
  }, 60_000);

  test("RC delta MEDIUM: a stale standby / needs_login never stops a start by hand, nor republishes over a stop by hand", async () => {
    logins = CLAUDE;
    const h = host();
    for (const stale of [{ kind: "standby", lead: "kiras-mbp" }, { kind: "needs_login", found: [] }] as Stale[]) {
      // queued behind a start by hand: it keeps running
      await h.stopByHand();
      const start = h.start({ cwd: c.root });
      const late = h.serial(() => h.applyAuto(stale));
      await Promise.all([start, late]);
      await Bun.sleep(400);
      expect({ stale: stale.kind, v: await view(node) }).toMatchObject({ stale: stale.kind, v: { running: true, auto: false } });
      expect((await view(node)).state).not.toBe(stale.kind);
      // queued behind a stop by hand: it stays stopped, and its team status stays offline (not able to lead)
      const stop = h.stopByHand();
      const late2 = h.serial(() => h.applyAuto(stale));
      await Promise.all([stop, late2]);
      await Bun.sleep(400);
      expect({ stale: stale.kind, v: await view(node) }).toMatchObject({ stale: stale.kind, v: { running: false, state: "stopped", stopped_by_hand: true } });
      expect({ stale: stale.kind, status: ownStatus() }).toEqual({ stale: stale.kind, status: "offline" });
    }
  }, 60_000);

  test("Opus RC LOW: a migrated pre.6 stop also publishes offline, so peers don't keep electing it", async () => {
    await host().start({ cwd: c.root }); // pre.6 ran it by hand: its status is live (idle)
    await waitFor(async () => ownStatus() === "idle", { what: "a live status" });
    await node.stop(); // a daemon stop leaves that status live
    writeFileSync(join(node.home, "orchestrator.json"), legacy(false)); // what pre.6 wrote after a stop
    await node.start();
    await waitFor(async () => ownStatus() === "offline", { what: "offline after the migration" });
    expect(await view(node)).toMatchObject({ running: false, stopped_by_hand: true });
  }, 60_000);
});
