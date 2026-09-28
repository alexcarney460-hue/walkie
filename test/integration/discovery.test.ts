// Agent discovery wired into the daemon (v0.1.2): a session with no hooks shows up on a teammate's dashboard;
// `discover_agents: false` turns it off.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectSlug } from "../../src/daemon/activity.ts";
import { DISCOVERED_ACTIVITY } from "../../src/daemon/discovery.ts";
import type { ProcessProvider, ProcRow } from "../../src/daemon/procs.ts";
import { Cluster, waitFor } from "../helpers/cluster.ts";

const UID = 4242;

class Procs implements ProcessProvider {
  lists = 0;
  constructor(public procs: ProcRow[], private readonly env: Map<number, Record<string, string>>, private readonly cwds = new Map<number, string>()) {}
  async list(): Promise<ProcRow[]> { this.lists++; return this.procs; }
  async envVars(pids: readonly number[], names: readonly string[]) {
    return new Map(pids.map((p) => [p, Object.fromEntries(Object.entries(this.env.get(p) ?? {}).filter(([k]) => names.includes(k)))]));
  }
  async cwd(pid: number): Promise<string | undefined> { return this.cwds.get(pid); }
  async openFiles(): Promise<string[]> { return []; }
  async claudeSession() { return undefined; }
}

const c = new Cluster();
afterAll(async () => { await c.close(); });

describe("agent discovery in the daemon", () => {
  test("a Claude Code session without hooks appears on a teammate's dashboard, then goes offline when it exits", async () => {
    const procs = new Procs(
      [{ pid: 10, ppid: 1, uid: UID, startedAt: 1_790_000_000_000, command: "claude" }, { pid: 11, ppid: 10, uid: UID, startedAt: 1_790_000_001_000, command: "node mcp.js" }],
      new Map([[11, { CLAUDE_CODE_SESSION_ID: "5e55a0b1-0000-4000-8000-000000000000" }]]),
    );
    const alex = await c.add({ name: "alex", login: "alex@example.com", discovery: { provider: procs, uid: UID, intervalMs: 50 } });
    const kira = await c.add({ name: "kira", login: "kira@example.com" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("kira@example.com", "kira", "member");
    expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
    const seen = await waitFor(async () => (await kira.client().agents()).agents.find((a) => a.agent === "cc-5e55a0"), { what: "discovered agent on kira" });
    expect(seen).toMatchObject({ handle: "alex", status: { state: "idle", runtime: "claude-code", activity: DISCOVERED_ACTIVITY }, effective_state: "idle" });
    procs.procs = [{ pid: 1, ppid: 0, uid: 0, startedAt: 1, command: "/sbin/init" }]; // (an empty list is a failed `ps`)
    await waitFor(async () => (await kira.client().agents()).agents.find((a) => a.agent === "cc-5e55a0")?.status.state === "offline", { what: "offline after exit" });
  });

  test("a headless seat's activity reaches a teammate: working → idle → offline → archive (WALKIE-MISSION-1)", async () => {
    // Alex's node runs 20 min behind: its statuses are old enough for the archive rules the moment they are posted,
    // so the whole life cycle fits in a test without waiting for real minutes.
    const lag = 20 * 60_000;
    const clock = () => Date.now() - lag;
    const root = join(c.root, "seat");
    const cwd = join(root, "repo");
    const cfg = join(root, "claude");
    const sid = "5eeda11c-0000-4000-8000-000000000000";
    mkdirSync(join(cfg, "projects", claudeProjectSlug(cwd)), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const transcript = join(cfg, "projects", claudeProjectSlug(cwd), `${sid}.jsonl`);
    const write = (recs: unknown[]) => {
      writeFileSync(transcript, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const at = new Date(clock());
      utimesSync(transcript, at, at);
    };
    write([{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "bun run build" } }] } }]);
    const seat: ProcRow = { pid: 30, ppid: 1, uid: UID, startedAt: clock(), command: "claude -p go", cpuMs: 500 };
    const procs = new Procs(
      [{ pid: 1, ppid: 0, uid: 0, startedAt: 1, command: "/sbin/init" }, seat, { pid: 31, ppid: 30, uid: UID, startedAt: clock(), command: "walkie mcp" }],
      new Map<number, Record<string, string>>([[30, { CLAUDE_CONFIG_DIR: cfg }], [31, { CLAUDE_CODE_SESSION_ID: sid }]]),
      new Map([[30, cwd]]),
    );
    const alex = await c.add({ name: "seat-alex", login: "seat-alex@example.com", clock, discovery: { provider: procs, uid: UID, intervalMs: 50, now: clock, share: { prompts: false, activity: true } } });
    const kira = await c.add({ name: "seat-kira", login: "seat-kira@example.com" });
    // Alex opted in to sharing tool text: his daemon's projection lets the step through (default: a fixed phrase).
    const cfgPath = join(alex.home, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ ...(JSON.parse(readFileSync(cfgPath, "utf8")) as object), share_activity: true }));
    await alex.client().init("seats", "salex");
    await alex.client().invite("seat-kira@example.com", "skira", "member");
    expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
    const find = async () => (await kira.client().agents()).agents.find((a) => a.agent === "cc-5eeda1");
    const working = await waitFor(async () => { const a = await find(); return a?.effective_state === "working" ? a : undefined; }, { what: "working on kira" });
    expect(working.status).toMatchObject({ activity: "$ bun run build", runtime: "claude-code" });
    expect(working.archived).toBe(false);

    write([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, { type: "system", subtype: "turn_duration" }]);
    utimesSync(transcript, new Date(clock() - 120_000), new Date(clock() - 120_000)); // quiet for 2 minutes
    await waitFor(async () => (await find())?.effective_state === "idle", { what: "idle on kira" });

    procs.procs = procs.procs.filter((p) => p.pid < 30);
    // Offline, and (20 min old by alex's clock) past the 10-minute grace: in kira's archive, out of his live roster.
    await waitFor(async () => !(await find()), { what: "gone from kira's live roster" });
    const arch = await kira.client().agents({ scope: "archive" });
    expect(arch.agents.find((a) => a.agent === "cc-5eeda1")).toMatchObject({ effective_state: "offline", archived: true, status: { activity: "Process exited" } });
    const live = await kira.client().agents();
    expect(live.archive.find((x) => x.node === alex.d.nodeId)).toMatchObject({ offline: 1 });
  });

  test("discover_agents: false in config.json turns it off", async () => {
    const procs = new Procs([{ pid: 20, ppid: 1, uid: UID, startedAt: null, command: "claude" }], new Map());
    const home = join(c.root, "off");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({ discover_agents: false }));
    const off = await c.add({ name: "off", login: "off@example.com", discovery: { provider: procs, uid: UID, intervalMs: 20 } });
    await off.client().init("solo", "off");
    await Bun.sleep(200);
    expect(procs.lists).toBe(0);
    expect((await off.client().agents()).agents).toEqual([]);
  });
});
