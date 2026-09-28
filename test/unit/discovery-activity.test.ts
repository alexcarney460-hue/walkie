// WALKIE-MISSION-1: discovered sessions get their state from what they do (transcript writes, CPU), a fresher hook /
// set_status state is never overwritten, ended sessions go offline (their own or, after a grace, a hook's), and
// discovery's own statuses are remembered across a restart.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "../../src/daemon/core.ts";
import {
  AgentDiscovery, ATTENTION_HOLD_MS, mcpFallbackParent, DISCOVERED_ACTIVITY, EXITED_ACTIVITY, HEARTBEAT_MS, IDLE_AFTER_MS, LEGACY_DISCOVERED_ACTIVITY,
  SWEEP_GRACE_MS, WORKING_ACTIVITY,
} from "../../src/daemon/discovery.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { DEFAULT_LIMITS } from "../../src/daemon/ratelimit.ts";
import type { ProcessProvider, ProcRow } from "../../src/daemon/procs.ts";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsView } from "../../src/daemon/views.ts";
import { claudeProjectSlug } from "../../src/daemon/activity.ts";
import type { AgentState, BodyOf } from "../../src/protocol/schemas.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const ME = 501;
const SID = "5eed0001-1111-4222-8333-944455556666";
const AGENT = "cc-5eed00";

class Fixture implements ProcessProvider {
  procs: ProcRow[] = [];
  env = new Map<number, Record<string, string>>();
  cwds = new Map<number, string>();
  files = new Map<number, string[]>();
  sessions = new Map<number, { sessionId: string; startedAt?: number }>();
  async list(): Promise<ProcRow[]> { return this.procs; }
  async envVars(pids: readonly number[], names: readonly string[]): Promise<Map<number, Record<string, string>>> {
    return new Map(pids.map((p) => [p, Object.fromEntries(Object.entries(this.env.get(p) ?? {}).filter(([k]) => names.includes(k)))]));
  }
  async cwd(pid: number): Promise<string | undefined> { return this.cwds.get(pid); }
  async openFiles(pid: number): Promise<string[]> { return this.files.get(pid) ?? []; }
  async claudeSession(pid: number) { return this.sessions.get(pid); }
}

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const onlineSync = { isOnline: () => true } as unknown as SyncManager;
const jl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const toolCall = (name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t", name, input }] } });
const endTurn = () => [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, { type: "system", subtype: "turn_duration" }];

interface World { core: Core; fx: Fixture; clock: { t: number }; cfg: string; cwd: string; transcript: string; disc: () => AgentDiscovery; write(recs: unknown[], at?: number): void }

function world(opts: { sharePrompts?: boolean; shareActivity?: boolean } = {}): World {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const clock = { t: now() };
  // Status posts in these tests come faster than the real per-agent limit (2/s of wall time) allows.
  const core = makeCore(alex, team, cleanups, { clock: () => clock.t, limits: { ...DEFAULT_LIMITS, status: { capacity: 1_000, perSecond: 1_000 } } });
  expect(core.ingest(create, "local").status).toBe("accepted");
  writeFileSync(core.paths.config, JSON.stringify({ share_prompts: opts.sharePrompts ?? true, share_activity: opts.shareActivity ?? true }));
  const root = mkdtempSync("/tmp/walkie-discact-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cfg = join(root, "claude-config");
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/walkie-mission-1\n");
  mkdirSync(join(cfg, "projects", claudeProjectSlug(cwd)), { recursive: true });
  const transcript = join(cfg, "projects", claudeProjectSlug(cwd), `${SID}.jsonl`);
  const fx = new Fixture();
  // A headless seat: `claude -p` with CLAUDE_CONFIG_DIR, its MCP child carries the session id.
  fx.procs.push(
    { pid: 1, ppid: 0, uid: 0, startedAt: clock.t - 86_400_000, command: "/sbin/launchd", cpuMs: 0 },
    { pid: 100, ppid: 1, uid: ME, startedAt: clock.t - 60_000, command: "claude -p --output-format stream-json", cpuMs: 1_000 },
    { pid: 101, ppid: 100, uid: ME, startedAt: clock.t - 59_000, command: "walkie mcp", cpuMs: 10 },
  );
  fx.env.set(100, { CLAUDE_CONFIG_DIR: cfg });
  fx.env.set(101, { CLAUDE_CODE_SESSION_ID: SID });
  fx.cwds.set(100, cwd);
  let text = "";
  const write = (recs: unknown[], at = clock.t) => {
    text += jl(...recs);
    writeFileSync(transcript, text);
    utimesSync(transcript, new Date(at), new Date(at));
  };
  const disc = () => new AgentDiscovery(core, createLogger({}), { provider: fx, uid: ME, now: () => clock.t, share: { prompts: opts.sharePrompts ?? true, activity: opts.shareActivity ?? true }, home: join(root, "walkie-home"), claudeConfigDir: cfg, nonAgentDirs: [join(root, "claude-mem")] });
  return { core, fx, clock, cfg, cwd, transcript, disc, write };
}

function status(core: Core, agent: string): (BodyOf<"agent.status"> & { _id: string; _ts: number }) | null {
  const row = core.store.agent(core.nodeId, agent);
  return row ? { ...(JSON.parse(row.body) as BodyOf<"agent.status">), _id: row.event_id, _ts: row.ts } : null;
}

function hook(core: Core, state: AgentState, activity: string, agent = AGENT, runtime: BodyOf<"agent.status">["runtime"] = "claude-code") {
  return core.emit("agent.status", { agent, state, runtime, activity, title: "Hook title" }, { agent });
}

const cpu = (fx: Fixture, pid: number, add: number) => {
  fx.procs = fx.procs.map((p) => (p.pid === pid ? { ...p, cpuMs: (p.cpuMs ?? 0) + add } : p));
};

describe("activity-based state for discovered sessions", () => {
  test("working while the transcript is written (step, model, title), idle after a quiet minute, offline on exit, then archived", async () => {
    const w = world();
    const d = w.disc();
    w.write([{ type: "user", message: { role: "user", content: "<!-- preamble -->\n## Task: accurate Mission Control (ALE-5286)" } }, toolCall("Bash", { command: "bun test test/unit" })]);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({
      state: "working", runtime: "claude-code", activity: "$ bun test test/unit", model: "claude-opus-5-5",
      title: "Task: accurate Mission Control (ALE-5286)", task: "ALE-5286", branch: "walkie-mission-1", session: SID,
    });
    w.clock.t += 15_000;
    w.write([{ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }, ...endTurn()]);
    await d.tick();
    expect(status(w.core, AGENT)?.state).toBe("working"); // written 0 s ago
    w.clock.t += 61_000;
    cpu(w.fx, 100, 100); // an idle CLI: ~0.2 % of a core
    await d.tick();
    expect(status(w.core, AGENT)?.state).toBe("working"); // hysteresis: one idle scan, 61 s quiet (Opus 8)
    w.clock.t += 30_000;
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "idle", activity: DISCOVERED_ACTIVITY, title: "Task: accurate Mission Control (ALE-5286)" });
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    w.clock.t += 1_000;
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "offline", activity: EXITED_ACTIVITY });
    const later = w.clock.t + 10 * 60_000;
    expect(agentsView(w.core, onlineSync, later).find((a) => a.agent === AGENT)).toMatchObject({ effective_state: "offline", archived: true });
  });

  test("a turn in progress stays working through a long reply; CPU counts only for a session without a file", async () => {
    const w = world();
    const d = w.disc();
    w.write([toolCall("Bash", { command: "sleep 200" })]);
    await d.tick();
    w.clock.t += 5 * 60_000; // no write for 5 min, the tool call still running
    await d.tick();
    expect(status(w.core, AGENT)?.state).toBe("working");
    w.write([...endTurn()], w.clock.t - 3 * 60_000);
    await d.tick();
    w.clock.t += 15_000;
    await d.tick();
    expect(status(w.core, AGENT)?.state).toBe("idle");
    w.clock.t += 15_000;
    cpu(w.fx, 101, 4_000); // the session's tree used 4 s in 15 s (27 % of a core): a background process, the turn ended
    await d.tick();
    expect(status(w.core, AGENT)?.state).toBe("idle");
    // A Kimi session with no session file: busy CPU is all there is, and it means working.
    w.fx.procs.push({ pid: 200, ppid: 1, uid: ME, startedAt: w.clock.t - 60_000, command: "kimi", cpuMs: 1_000 });
    await d.tick();
    w.clock.t += 15_000;
    cpu(w.fx, 200, 4_000);
    await d.tick();
    expect(status(w.core, "kimi-pid200")?.state).toBe("idle"); // one busy reading is not enough (Opus r3 #6)
    w.clock.t += 15_000;
    cpu(w.fx, 200, 4_000);
    await d.tick();
    expect(status(w.core, "kimi-pid200")?.state).toBe("working");
  });

  test("an MCP 'Connected to Walkie' idle of a headless seat becomes working once it works; titles off when prompts are private", async () => {
    const w = world({ sharePrompts: false });
    const mcp = w.core.emit("agent.status", { agent: AGENT, state: "idle", runtime: "claude-code", activity: "Connected to Walkie" }, { agent: AGENT });
    const d = w.disc();
    w.clock.t += 30_000;
    w.write([{ type: "user", message: { role: "user", content: "secret project codename" } }, toolCall("Read", { file_path: join(w.cwd, "a.ts") })]);
    await d.tick();
    const s = status(w.core, AGENT);
    expect(s?._id).not.toBe(mcp.id);
    expect(s).toMatchObject({ state: "working", activity: "Read a.ts" });
    expect(s?.title).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("codename");
  });

  test("a fresher hook state is never overwritten: waiting holds, a Stop's idle holds through the turn's last writes", async () => {
    const w = world();
    const d = w.disc();
    w.write([toolCall("Bash", { command: "rm -rf build" })]);
    w.clock.t += 1_000;
    const waiting = hook(w.core, "waiting", "Claude needs your permission to use Bash");
    await d.tick();
    expect(status(w.core, AGENT)?._id).toBe(waiting.id);
    w.clock.t += 60_000;
    w.write([{ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }]); // approved: working again
    await d.tick();
    expect(status(w.core, AGENT)?._id).toBe(waiting.id); // hooks will say so; discovery waits ATTENTION_HOLD_MS
    w.clock.t += ATTENTION_HOLD_MS;
    w.write([toolCall("Edit", { file_path: join(w.cwd, "x.ts") })]);
    await d.tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "working", activity: "Edit x.ts", title: "Hook title" });

    w.clock.t += 1_000;
    const stop = hook(w.core, "idle", "Finished turn");
    w.clock.t += 2_000;
    w.write([...endTurn()]); // written right after the Stop hook
    await d.tick();
    expect(status(w.core, AGENT)?._id).toBe(stop.id);
  });

  test("a hook's working is set idle only when its transcript shows no activity (interrupted turn), and kept fresh while it works", async () => {
    const w = world();
    const d = w.disc();
    w.write([...endTurn()]);
    const working = hook(w.core, "working", "Thinking");
    await d.tick();
    expect(status(w.core, AGENT)?._id).toBe(working.id);
    w.clock.t += IDLE_AFTER_MS + 1_000;
    await d.tick();
    w.clock.t += 15_000;
    await d.tick(); // two idle scans (hysteresis)
    expect(status(w.core, AGENT)).toMatchObject({ state: "idle", title: "Hook title" });

    const again = hook(w.core, "working", "$ bun test");
    w.clock.t += HEARTBEAT_MS;
    w.write([toolCall("Bash", { command: "bun test" })]); // a long tool run the hooks said nothing more about
    await d.tick();
    const s = status(w.core, AGENT);
    expect(s?._id).not.toBe(again.id);
    expect(s).toMatchObject({ state: "working", title: "Hook title" });
  });

  test("discovery's own working status is re-posted on the heartbeat, so it never goes stale", async () => {
    const w = world();
    const d = w.disc();
    w.write([toolCall("Bash", { command: "cargo build" })]);
    await d.tick();
    const first = status(w.core, AGENT);
    for (let i = 0; i < 4; i++) { w.clock.t += HEARTBEAT_MS / 4; cpu(w.fx, 100, 60_000); await d.tick(); }
    const later = status(w.core, AGENT);
    expect(later?.state).toBe("working");
    expect(later?._id).not.toBe(first?._id);
    expect(agentsView(w.core, onlineSync, w.clock.t).find((a) => a.agent === AGENT)?.effective_state).toBe("working");
  });
});

describe("ended sessions", () => {
  test("hook/MCP agents of this machine with no running session go offline after the grace; cli/other never", async () => {
    const w = world();
    w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
    hook(w.core, "idle", "Connected to Walkie", "cc-ghost1");
    hook(w.core, "working", "Edit x", "codex-ghost2", "codex");
    hook(w.core, "working", "manual", "ci-bot", "cli");
    hook(w.core, "idle", "custom", "hermes", "other");
    const d = w.disc();
    await d.tick();
    expect(status(w.core, "cc-ghost1")?.state).toBe("idle"); // within the grace
    w.clock.t += SWEEP_GRACE_MS;
    await d.tick();
    expect(status(w.core, "cc-ghost1")).toMatchObject({ state: "offline", activity: EXITED_ACTIVITY });
    expect(status(w.core, "codex-ghost2")?.state).toBe("offline");
    expect(status(w.core, "ci-bot")?.state).toBe("working");
    expect(status(w.core, "hermes")?.state).toBe("idle");
  });

  test("an MCP server's fallback name (agent-<parent pid>) goes offline when that parent is gone or is a session reported under its own name; long-archived ghosts are left alone", async () => {
    const w = world();
    const t0 = w.clock.t;
    w.fx.procs.push({ pid: 400, ppid: 1, uid: ME, startedAt: t0, command: "/Applications/Zed.app/zed", cpuMs: 1 });
    hook(w.core, "idle", "Connected to Walkie", "agent-ancient", "cli"); // an MCP status from hours ago: archived already
    w.clock.t = t0 + 60 * 60_000;
    hook(w.core, "idle", "Connected to Walkie", `agent-${(400).toString(36)}`, "cli"); // parent pid 400: running, not a session
    hook(w.core, "idle", "Connected to Walkie", `agent-${(100).toString(36)}`, "cli"); // parent pid 100: the session cc-5eed00
    hook(w.core, "idle", "Connected to Walkie", `agent-${(4242).toString(36)}`, "cli"); // parent pid 4242: gone
    w.clock.t += SWEEP_GRACE_MS;
    await w.disc().tick();
    expect(status(w.core, `agent-${(400).toString(36)}`)?.state).toBe("idle");
    expect(status(w.core, `agent-${(100).toString(36)}`)).toMatchObject({ state: "offline", activity: EXITED_ACTIVITY }); // a duplicate card
    expect(status(w.core, AGENT)?.state).toBeDefined();
    expect(status(w.core, `agent-${(4242).toString(36)}`)).toMatchObject({ state: "offline", activity: EXITED_ACTIVITY });
    const ancient = status(w.core, "agent-ancient");
    expect(ancient?.state).toBe("idle"); // no new "just seen" offline status for a session dead for an hour
    expect(ancient?._ts).toBe(t0);
    expect(mcpFallbackParent("agent-2s")).toBe(100);
    expect(mcpFallbackParent("cc-3f9a2b")).toBeNull();
  });

  test("a running session is never swept (incl. an MCP's agent-<pid> name under a host process); a Codex app host keeps Codex agents", async () => {
    const w = world();
    w.write([...endTurn()], w.clock.t - 3_600_000);
    w.fx.procs.push({ pid: 300, ppid: 1, uid: ME, startedAt: w.clock.t, command: "/Applications/Codex.app/codex app-server", cpuMs: 1 });
    hook(w.core, "idle", "Connected to Walkie", `agent-${(300).toString(36)}`);
    hook(w.core, "idle", "Finished turn", "codex-app1", "codex");
    w.clock.t += SWEEP_GRACE_MS + 1;
    await w.disc().tick();
    expect(status(w.core, `agent-${(300).toString(36)}`)?.state).toBe("idle");
    expect(status(w.core, "codex-app1")?.state).toBe("idle");
    expect(status(w.core, AGENT)?.state).toBe("idle");
  });

  test("an empty process list (ps failed) sweeps nothing", async () => {
    const w = world();
    hook(w.core, "idle", "x", "cc-ghost3");
    w.fx.procs = [];
    w.clock.t += SWEEP_GRACE_MS * 10;
    await w.disc().tick();
    expect(status(w.core, "cc-ghost3")?.state).toBe("idle");
  });

  test("discovery's own statuses are remembered across a restart (and pre-MISSION ones by their text)", async () => {
    const w = world();
    w.write([toolCall("Bash", { command: "make" })]);
    await w.disc().tick();
    expect(status(w.core, AGENT)?.state).toBe("working");
    w.write([...endTurn()]);
    w.core.emit("agent.status", { agent: "claude-pid77", state: "idle", runtime: "claude-code", activity: LEGACY_DISCOVERED_ACTIVITY }, { agent: "claude-pid77" });
    // Restart: a fresh discovery; the session went quiet 3 minutes ago.
    w.clock.t += 3 * 60_000;
    await w.disc().tick();
    expect(status(w.core, AGENT)).toMatchObject({ state: "idle", activity: DISCOVERED_ACTIVITY }); // its own working, updated
    expect(status(w.core, "claude-pid77")?.state).toBe("offline"); // a leftover of the old version, process gone
    expect(WORKING_ACTIVITY).toBeTruthy();
  });
});
