// Agent auto-discovery (v0.1.2) over an injected process list: naming matches the hooks, a hook's status is never
// overwritten, exits go offline, other users' processes are never looked at.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../../src/daemon/config.ts";
import type { Core } from "../../src/daemon/core.ts";
import { AgentDiscovery, DISCOVERED_ACTIVITY, DISCOVERY_STALE_MS, EXITED_ACTIVITY, runtimeOf } from "../../src/daemon/discovery.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { parsePs, pickEnv, type ProcessProvider, type ProcRow } from "../../src/daemon/procs.ts";
import type { BodyOf } from "../../src/protocol/schemas.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const ME = 501;
const SID = "3f9a2b7c-1111-4222-8333-944455556666";
const PARENT_SID = "9fb4b7fa-0000-4000-8000-000000000000";
const THREAD = "35a3fc06-a27b-7106-8fd8-f2bb6d700e29";

class Fixture implements ProcessProvider {
  procs: ProcRow[] = [];
  env = new Map<number, Record<string, string>>();
  cwds = new Map<number, string>();
  files = new Map<number, string[]>();
  sessions = new Map<number, { sessionId: string; startedAt?: number }>();
  envAsked: { pids: number[]; names: string[] }[] = [];
  looked = new Set<number>();
  async list(): Promise<ProcRow[]> { return this.procs; }
  async envVars(pids: readonly number[], names: readonly string[]): Promise<Map<number, Record<string, string>>> {
    this.envAsked.push({ pids: [...pids], names: [...names] });
    const out = new Map<number, Record<string, string>>();
    for (const pid of pids) {
      this.looked.add(pid);
      const all = this.env.get(pid) ?? {};
      out.set(pid, Object.fromEntries(Object.entries(all).filter(([k]) => names.includes(k))));
    }
    return out;
  }
  async cwd(pid: number): Promise<string | undefined> { this.looked.add(pid); return this.cwds.get(pid); }
  async openFiles(pid: number): Promise<string[]> { this.looked.add(pid); return this.files.get(pid) ?? []; }
  async claudeSession(pid: number) { this.looked.add(pid); return this.sessions.get(pid); }
}

const T0 = 1_790_000_000_000;
function proc(pid: number, ppid: number, command: string, uid = ME, startedAt = T0): ProcRow { return { pid, ppid, uid, startedAt, command }; }

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

function setup(): { core: Core; fx: Fixture; disc: AgentDiscovery; clock: { t: number }; repo: string } {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const clock = { t: now() };
  const core = makeCore(alex, team, cleanups, { clock: () => clock.t });
  expect(core.ingest(create, "local").status).toBe("accepted"); // this node founded the team
  const fx = new Fixture();
  const disc = new AgentDiscovery(core, createLogger({}), { provider: fx, uid: ME, now: () => clock.t });
  const repo = mkdtempSync("/tmp/walkie-disc-");
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat-x\n");
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  return { core, fx, disc, clock, repo };
}

function status(core: Core, agent: string): (BodyOf<"agent.status"> & { _ts: number; _id: string }) | null {
  const row = core.store.agent(core.nodeId, agent);
  return row ? { ...(JSON.parse(row.body) as BodyOf<"agent.status">), _ts: row.ts, _id: row.event_id } : null;
}

/** A Claude Code session (pid 100) started from a shell, with an MCP child that carries the real session id. */
function claudeSession(fx: Fixture, repo: string): void {
  fx.procs.push(proc(90, 1, "-/bin/zsh"), proc(100, 90, "/Users/u/.local/bin/claude --dangerously-skip-permissions"), proc(101, 100, "node /x/mcp.js", ME, T0 + 2_000));
  // The session's own process carries its LAUNCHER's session id (a claude started inside another session).
  fx.env.set(100, { CLAUDE_CODE_SESSION_ID: PARENT_SID, SECRET_TOKEN: "sk-do-not-read" });
  fx.env.set(101, { CLAUDE_CODE_SESSION_ID: SID, CLAUDECODE: "1", SECRET_TOKEN: "sk-do-not-read" });
  fx.cwds.set(100, repo);
}

describe("runtimeOf", () => {
  test("by executable, not by arguments or environment", () => {
    expect(runtimeOf("/Users/u/.local/bin/claude --resume x")).toBe("claude-code");
    expect(runtimeOf("claude -p fix it")).toBe("claude-code");
    expect(runtimeOf("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe("claude-code");
    expect(runtimeOf("codex --yolo")).toBe("codex");
    expect(runtimeOf("codex exec -m gpt -C /w do it")).toBe("codex");
    expect(runtimeOf("kimi")).toBe("kimi");
    expect(runtimeOf("claude mcp serve")).toBeNull();
    expect(runtimeOf("/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://")).toBeNull();
    expect(runtimeOf("bash /w/remote-seat.sh hestia lane codex")).toBeNull();
    expect(runtimeOf("/Users/u/.hermes/node/bin/node /x/server.js")).toBeNull();
    expect(runtimeOf("/Users/u/.kimi-webbridge/bin/kimi-webbridge run")).toBeNull();
  });
});

describe("process parsing", () => {
  test("ps rows (LC_ALL=C lstart) and a single env variable from ps eww", () => {
    const rows = parsePs("    1     0     0 Thu Sep 24 17:53:38 2026     /sbin/launchd\n  6141  6125   501 Fri Sep  4 12:18:20 2026     /Users/u/.local/bin/claude --resume abc\nnoise\n");
    expect(rows).toEqual([
      { pid: 1, ppid: 0, uid: 0, startedAt: new Date("Thu Sep 24 17:53:38 2026").getTime(), command: "/sbin/launchd" },
      { pid: 6141, ppid: 6125, uid: 501, startedAt: new Date("Fri Sep 4 12:18:20 2026").getTime(), command: "/Users/u/.local/bin/claude --resume abc" },
    ]);
    const line = `node server.js --note CLAUDE_CODE_SESSION_ID=fake TERM=xterm CLAUDE_CODE_SESSION_ID=${SID} API_KEY=sk-x`;
    expect(pickEnv(line, ["CLAUDE_CODE_SESSION_ID", "WALKIE_AGENT"])).toEqual({ CLAUDE_CODE_SESSION_ID: SID });
  });
});

describe("agent discovery", () => {
  test("a Claude Code session is named cc-<first 6 of its session id>, from what its hooks would see", async () => {
    const { core, fx, disc, repo } = setup();
    claudeSession(fx, repo);
    const found = await disc.scan();
    expect(found.map((a) => a.agent)).toEqual(["cc-3f9a2b"]);
    await disc.tick();
    const s = status(core, "cc-3f9a2b");
    expect(s).toMatchObject({ agent: "cc-3f9a2b", state: "idle", runtime: "claude-code", activity: DISCOVERED_ACTIVITY, repo: repo.split("/").pop(), branch: "feat-x", session: SID, started_at: T0 });
    expect(status(core, "cc-9fb4b7")).toBeNull(); // never the launcher's id
    // Only the naming variables were asked for, and only of the session's children; of the session process itself
    // only its login directory (ACCOUNTS-1; where its transcript is, WALKIE-MISSION-1), whether it is a seat, and, since
    // ACCOUNTS-2 (merged in pre.4), the wrapper's account id and pid (ids, never a secret).
    const naming = ["WALKIE_AGENT", "CLAUDE_CODE_SESSION_ID", "KIMI_SESSION_ID"];
    const login = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "WALKIE_ACCOUNT", "WALKIE_SWITCH_PID", "WALKIE_AGENT"];
    expect(fx.envAsked.every((a) => (a.pids.every((p) => p === 101) && a.names.every((n) => naming.includes(n)))
      || (a.pids.every((p) => p === 100) && a.names.every((n) => login.includes(n))))).toBe(true);
    expect(JSON.stringify(s)).not.toContain("sk-do-not-read");
  });

  test("a seat running as this user is never published as a discovered session (Opus seats r9 LOW)", async () => {
    const { core, fx, disc } = setup();
    // A Codex seat with no children yet (its own WALKIE_AGENT), and a Claude seat whose MCP child carries it.
    fx.procs.push(proc(500, 1, "codex exec -C /w go"), proc(510, 1, "claude -p go"), proc(511, 510, "node /x/mcp.js", ME, T0 + 2_000), proc(520, 1, "claude -p mine"));
    fx.env.set(500, { WALKIE_AGENT: "seat-0123ab-7" });
    fx.env.set(511, { WALKIE_AGENT: "seat-0123ab-8", CLAUDE_CODE_SESSION_ID: SID });
    expect((await disc.scan()).map((a) => a.agent)).toEqual(["claude-pid520"]);
    await disc.tick();
    expect(status(core, "seat-0123ab-7")).toBeNull();
    expect(status(core, "seat-0123ab-8")).toBeNull();
    expect(status(core, "codex-pid500")).toBeNull();
  });

  test("Claude's own session record wins; no session anywhere falls back to a pid name", async () => {
    const { fx, disc } = setup();
    fx.procs.push(proc(200, 1, "claude"), proc(300, 1, "claude -p go"));
    fx.sessions.set(200, { sessionId: "aa11bb22-0000-4000-8000-000000000000", startedAt: T0 + 1_000 });
    fx.sessions.set(300, { sessionId: "dead0000-0000-4000-8000-000000000000", startedAt: T0 - 3_600_000 }); // an earlier process with this pid
    expect((await disc.scan()).map((a) => a.agent).sort()).toEqual(["cc-aa11bb", "claude-pid300"]);
  });

  test("Codex is named from its open rollout file, as its notify hook names it (codex-<thread tail>)", async () => {
    const { core, fx, disc } = setup();
    fx.procs.push(proc(400, 1, "codex --yolo"), proc(401, 1, "kimi"), proc(402, 401, "sh", ME), proc(403, 1, "codex"));
    fx.files.set(400, ["/dev/null", `/Users/u/.codex/sessions/2026/09/26/rollout-2026-09-26T07-50-56-${THREAD}.jsonl`]);
    fx.env.set(402, { KIMI_SESSION_ID: "k1m2n3o4" });
    await disc.tick();
    expect(status(core, "codex-700e29")).toMatchObject({ state: "idle", runtime: "codex", session: THREAD });
    expect(status(core, "kimi-k1m2n3")).toMatchObject({ state: "idle", runtime: "kimi" });
    expect(status(core, "codex-pid403")).toMatchObject({ state: "idle", runtime: "codex" });
  });

  test("a fresh hook status is never overwritten, nor an old one; discovery's own idle is not re-posted", async () => {
    const { core, fx, disc, clock, repo } = setup();
    claudeSession(fx, repo);
    const hook = core.statuses.submit("cc-3f9a2b", { agent: "cc-3f9a2b", state: "working", runtime: "claude-code", title: "Fix the bug", activity: "Running a command" });
    expect(hook).not.toBeNull();
    await disc.tick();
    expect(status(core, "cc-3f9a2b")).toMatchObject({ state: "working", activity: "Running a command", _id: hook?.id });
    clock.t += DISCOVERY_STALE_MS + 1_000; // a long tool call or a permission prompt: still the hook's word
    await disc.tick();
    expect(status(core, "cc-3f9a2b")?._id).toBe(hook?.id);

    fx.procs.push(proc(500, 1, "claude"));
    await disc.tick();
    const first = status(core, "claude-pid500");
    expect(first?.activity).toBe(DISCOVERED_ACTIVITY);
    clock.t += 60_000;
    await disc.tick();
    expect(status(core, "claude-pid500")?._id).toBe(first?._id as string); // fresh: not re-posted every scan
    clock.t += DISCOVERY_STALE_MS;
    await disc.tick();
    // Idle is never re-posted (it would never reach the archive); a working one is (activity tests).
    expect(status(core, "claude-pid500")?._id).toBe(first?._id as string);
  });

  test("an exited process goes offline; after a restart, discovery's own leftovers do too", async () => {
    const { core, fx, disc, clock, repo } = setup();
    claudeSession(fx, repo);
    fx.procs.push(proc(600, 1, "claude"));
    await disc.tick();
    expect(status(core, "cc-3f9a2b")?.state).toBe("idle");
    fx.procs = fx.procs.filter((p) => p.pid < 100 || p.pid > 101);
    clock.t += 1_000;
    await disc.tick();
    expect(status(core, "cc-3f9a2b")).toMatchObject({ state: "offline", activity: EXITED_ACTIVITY, branch: "feat-x" });
    expect(status(core, "claude-pid600")?.state).toBe("idle");

    // A new daemon (fresh discovery) finds claude-pid600 gone: it was discovery's own status (remembered across the
    // restart), so it goes offline at once.
    fx.procs = [proc(1, 0, "/sbin/launchd", 0)];
    clock.t += 1_000;
    const again = new AgentDiscovery(core, createLogger({}), { provider: fx, uid: ME, now: () => clock.t });
    await again.tick();
    expect(status(core, "claude-pid600")?.state).toBe("offline");
  });

  test("other users' processes are ignored and never inspected", async () => {
    const { core, fx, disc } = setup();
    fx.procs.push(proc(700, 1, "claude", 502), proc(701, 700, "node mcp.js", 502), proc(702, 1, "codex", 0));
    fx.env.set(701, { CLAUDE_CODE_SESSION_ID: SID });
    expect(await disc.scan()).toEqual([]);
    await disc.tick();
    expect(core.store.agents()).toEqual([]);
    expect([...fx.looked]).toEqual([]);
  });

  test("the config switch defaults on", () => {
    expect(ConfigSchema.parse({}).discover_agents).toBe(true);
    expect(ConfigSchema.parse({ discover_agents: false }).discover_agents).toBe(false);
  });
});

describe("ACCOUNTS-2: wrapped sessions", () => {
  test("WALKIE_ACCOUNT counts only on the process the wrapper itself started (its parent is WALKIE_SWITCH_PID)", async () => {
    const { disc, fx } = setup();
    disc.onScan = () => undefined;
    const ACCT = "a".repeat(24);
    fx.procs.push(proc(200, 199, "bun /x/walkie claude"), proc(201, 200, "/Users/u/.local/bin/claude"), proc(300, 1, "/Users/u/.local/bin/claude"));
    fx.env.set(201, { WALKIE_ACCOUNT: ACCT, WALKIE_SWITCH_PID: "200", CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" });
    // Inherited from a wrapped session by a claude that is not the wrapper's own child: not attributed.
    fx.env.set(300, { WALKIE_ACCOUNT: ACCT, WALKIE_SWITCH_PID: "200", CLAUDE_CODE_OAUTH_TOKEN: "sk-do-not-read" });
    const found = await disc.scan();
    const by = Object.fromEntries(found.map((f) => [f.pid, f]));
    expect(by[201]?.account).toBe(ACCT);
    expect(by[201]?.token_login).toBeUndefined();
    expect(by[300]?.account).toBeUndefined();
    expect(by[300]?.token_login).toBe(true);
    expect(JSON.stringify(found)).not.toContain("sk-do-not-read");
  });
});
