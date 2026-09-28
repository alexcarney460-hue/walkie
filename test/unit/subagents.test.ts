// WALKIE-MISSION-SUB-1: Claude Code sub-agents as their own Mission Control rows. The hook tests replay REAL hook
// payloads recorded from Claude Code 2.1.283 (`claude -p` spawning sub-agents; test/fixtures/claude-subagents,
// docs/plans/MISSION-SUB-1.md), against a stand-in daemon that records every status.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaudeHook } from "../../src/hooks/claude.ts";
import { CLAUDE_EVENTS, withClaudeHooks } from "../../src/hooks/install.ts";
import { claudeHooksDoctor, detectIndent, inspectClaudeHooks, refreshClaudeHooks } from "../../src/hooks/refresh.ts";
import { isSubagentEvent, LAUNCH_ID_TTL_MS, MAX_LAUNCHES, RESUME_GRACE_MS, rowCandidates, runningIds, stateKey } from "../../src/hooks/subagents.ts";
import { describeTool } from "../../src/hooks/activity.ts";
import { isArchived, shownByDefault } from "../../src/protocol/agent-roster.ts";
import { ACTIVITY_PHRASES, projectStatus } from "../../src/protocol/status-projection.ts";
import {
  cleanSubagentType, countSubagents, MAX_SUBAGENTS_PER_PARENT, namedUnder, shareableSubagentType, subagentLabel, subagentName, subagentsText,
  SUBAGENT_ARCHIVE_CAP_PER_NODE, SUBAGENT_ARCHIVE_TTL_MS,
} from "../../src/protocol/subagents.ts";
import { archiveOverflow } from "../../src/daemon/agent-archive.ts";
import type { AgentView, BodyOf } from "../../src/protocol/schemas.ts";
import { fakeDaemon } from "../helpers/fake-daemon.ts";
import { AGENT, hook, status, world } from "../helpers/discovery-world.ts";
import { SWEEP_GRACE_MS } from "../../src/daemon/discovery.ts";
import { PRUNE_BATCH, pruneHookState, SESSION_STATE_TTL_MS } from "../../src/daemon/hook-state-prune.ts";
import { RateLimiter } from "../../src/daemon/ratelimit.ts";

const FIX = join(import.meta.dir, "../fixtures/claude-subagents");
type Line = { event: string; payload: Record<string, unknown> };
const fixture = (name: string): Line[] => readFileSync(join(FIX, name), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Line);

/** Whether Walkie's installed hooks receive this recorded event (the probe logged every event and every tool). */
function delivered(l: Line): boolean {
  return CLAUDE_EVENTS.some((e) => e.event === l.event && (!e.matcher || e.matcher === "*" || new RegExp(`^(${e.matcher})$`).test(String(l.payload.tool_name ?? ""))));
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function hookEnv(config: Record<string, unknown> = {}) {
  const home = mkdtempSync("/tmp/walkie-subhook-");
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const daemon = fakeDaemon({ "POST /v1/status": { event: null }, "GET /v1/asks": { asks: [] }, "GET /v1/events": { events: [] } });
  const saved = { WALKIE_HOME: process.env.WALKIE_HOME, WALKIE_SOCKET: process.env.WALKIE_SOCKET };
  process.env.WALKIE_HOME = home;
  process.env.WALKIE_SOCKET = daemon.socket;
  cleanups.push(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    daemon.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const statuses = () => daemon.requests.filter((r) => r.path === "/v1/status").map((r) => r.body as Record<string, unknown>);
  const replay = async (lines: Line[]) => {
    for (const l of lines.filter(delivered)) await runClaudeHook(JSON.stringify(l.payload), { CLAUDE_CODE_SESSION_ID: String(l.payload.session_id) });
  };
  return { home, daemon, statuses, replay };
}

describe("recorded payloads (Claude Code 2.1.283)", () => {
  test("the payload shapes this feature relies on", () => {
    const lines = fixture("async-two-parallel.jsonl");
    const start = lines.find((l) => l.event === "SubagentStart")?.payload;
    expect(start).toMatchObject({ hook_event_name: "SubagentStart", agent_id: "a6d1c079e3c5436c8", agent_type: "general-purpose" });
    expect(start).not.toHaveProperty("description"); // why the description comes from the launch
    const inner = lines.find((l) => l.event === "PostToolUse" && l.payload.agent_id)?.payload;
    expect(inner).toMatchObject({ tool_name: "Bash", agent_id: "a6d1c079e3c5436c8", session_id: start?.session_id });
    const launch = lines.find((l) => l.event === "PostToolUse" && l.payload.tool_name === "Agent")?.payload;
    expect(launch?.tool_response).toMatchObject({ isAsync: true, agentId: "a6d1c079e3c5436c8", description: "probe echo alpha" });
    const stop = lines.find((l) => l.event === "Stop")?.payload;
    expect(stop?.background_tasks).toEqual([
      { id: "a6d1c079e3c5436c8", type: "subagent", status: "running", description: "probe echo alpha", agent_type: "general-purpose" },
      { id: "a5c80ad3429efc213", type: "subagent", status: "running", description: "probe list cwd", agent_type: "general-purpose" },
    ]);
    const fg = fixture("foreground-one.jsonl");
    // A foreground launch: SubagentStart comes before the launch's reply, which names the id only after SubagentStop.
    expect(fg.map((l) => l.event + (l.payload.agent_id ? "*" : ""))).toEqual([
      "SessionStart", "UserPromptSubmit", "PreToolUse", "SubagentStart*", "PreToolUse*", "PostToolUse*", "SubagentStop*", "PostToolUse", "Stop", "SessionEnd",
    ]);
  });

  test("isSubagentEvent / runningIds", () => {
    expect(isSubagentEvent({ hook_event_name: "SubagentStart" })).toBe(true);
    expect(isSubagentEvent({ hook_event_name: "PostToolUse", agent_id: "a1" })).toBe(true);
    expect(isSubagentEvent({ hook_event_name: "PostToolUse" })).toBe(false);
    expect(runningIds(undefined)).toBeNull();
    expect([...(runningIds([{ id: "a1", type: "subagent", status: "running" }, { id: "b2", type: "subagent", status: "completed" }, { id: "c3", type: "shell", status: "running" }]) ?? [])]).toEqual(["a1"]);
  });
});

describe("hook replay", () => {
  test("two background sub-agents: two child rows titled from their launches, working then ended; the session row stays its own", async () => {
    const h = hookEnv();
    await h.replay(fixture("async-two-parallel.jsonl"));
    const st = h.statuses();
    const subs = st.filter((s) => s.parent);
    expect(new Set(subs.map((s) => s.agent))).toEqual(new Set(["cc-11fd55.a6d1c079e3c5", "cc-11fd55.a5c80ad3429e"]));
    for (const s of subs) expect(s).toMatchObject({ parent: "cc-11fd55", runtime: "claude-code", subagent_type: "general-purpose", ask_policy: "off", provenance: { title: "prompt" } });
    const alpha = subs.filter((s) => s.agent === "cc-11fd55.a6d1c079e3c5");
    expect(alpha.map((s) => [s.state, s.activity])).toEqual([["working", "Sub-agent started"], ["working", "Running a command"], ["offline", "Sub-agent finished"]]);
    expect(alpha.every((s) => s.title === "probe echo alpha")).toBe(true);
    expect(subs.filter((s) => s.agent === "cc-11fd55.a5c80ad3429e").every((s) => s.title === "probe list cwd")).toBe(true);
    // The sub-agents' tool calls no longer land on the session's row.
    const parent = st.filter((s) => s.agent === "cc-11fd55");
    expect(parent.some((s) => s.activity === "Running a command")).toBe(false);
    // Everything of the session is gone after SessionEnd.
    expect(readdirSync(join(h.home, "agents")).filter((f) => f.startsWith("cc-11fd55.") && f !== "cc-11fd55.json")).toEqual([]);
  });

  test("a foreground sub-agent: titled from the pending launch (its id is known only after it stops)", async () => {
    const h = hookEnv();
    await h.replay(fixture("foreground-one.jsonl"));
    const subs = h.statuses().filter((s) => s.agent === "cc-592aa8.abe56847f543");
    expect(subs.map((s) => s.state)).toEqual(["working", "working", "offline"]);
    expect(subs.every((s) => s.title === "probe fg echo")).toBe(true);
  });

  test("tool text inside a sub-agent follows share_activity like the session's", async () => {
    const off = hookEnv();
    await off.replay(fixture("foreground-one.jsonl"));
    expect(JSON.stringify(off.statuses())).not.toContain("echo beta");
    cleanups.pop()?.();
    const on = hookEnv({ share_activity: true });
    await on.replay(fixture("foreground-one.jsonl"));
    expect(on.statuses().some((s) => s.agent === "cc-592aa8.abe56847f543" && String(s.activity).includes("echo beta"))).toBe(true);
  });

  test("a sub-agent event never injects the session's asks (they're the session's to answer)", async () => {
    const h = hookEnv();
    const out = await runClaudeHook(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "5eb0a000-0000-4000-8000-000000000000", agent_id: "a1b2c3d4e5f6a7b8c", agent_type: "Explore", tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: "/tmp" }), { CLAUDE_CODE_SESSION_ID: "5eb0a000-0000-4000-8000-000000000000" });
    expect(out).toBe("");
    expect(h.daemon.requests.some((r) => r.path.startsWith("/v1/asks") || r.path.startsWith("/v1/events"))).toBe(false);
    // Its first event without a SubagentStart (hooks installed mid-run) still makes its row.
    expect(h.statuses()[0]).toMatchObject({ agent: "cc-5eb0a0.a1b2c3d4e5f6", parent: "cc-5eb0a0", subagent_type: "Explore", state: "working" });
  });

  test("parallel foreground launches of one type started in the other order: the launch reply corrects the title", async () => {
    const h = hookEnv();
    const sid = "0ddba11a-0000-4000-8000-000000000000";
    const env = { CLAUDE_CODE_SESSION_ID: sid };
    const ev = (e: Record<string, unknown>) => runClaudeHook(JSON.stringify({ session_id: sid, cwd: "/tmp", ...e }), env);
    await ev({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "toolu_A", tool_input: { description: "first job", subagent_type: "general-purpose" } });
    await ev({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "toolu_B", tool_input: { description: "second job", subagent_type: "general-purpose" } });
    // B's sub-agent starts first: FIFO gives it "first job" (the guess is wrong)...
    await ev({ hook_event_name: "SubagentStart", agent_id: "bbbbbbbb11111111", agent_type: "general-purpose" });
    await ev({ hook_event_name: "SubagentStart", agent_id: "aaaaaaaa22222222", agent_type: "general-purpose" });
    // ...A's reply names its id: A gets "first job", and B (still titled "first job") gets its own at its reply.
    await ev({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_A", tool_input: { description: "first job" }, tool_response: { status: "completed", agentId: "aaaaaaaa22222222" } });
    await ev({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_B", tool_input: { description: "second job" }, tool_response: { status: "completed", agentId: "bbbbbbbb11111111" } });
    await ev({ hook_event_name: "PostToolUse", agent_id: "bbbbbbbb11111111", agent_type: "general-purpose", tool_name: "Read", tool_input: { file_path: "/tmp/x" } });
    const b = h.statuses().filter((s) => s.agent === "cc-0ddba1.bbbbbbbb1111");
    expect(b.at(-1)?.title).toBe("second job");
    const state = JSON.parse(readFileSync(join(h.home, "agents", "cc-0ddba1.aaaaaaaa22222222.json"), "utf8")) as { title?: string };
    expect(state.title).toBe("first job");
  });

  test("at most MAX_SUBAGENTS_PER_PARENT live sub-agents per session; the rest are never reported", async () => {
    const h = hookEnv();
    const sid = "ca9ca9ca-0000-4000-8000-000000000000";
    for (let i = 0; i < MAX_SUBAGENTS_PER_PARENT + 3; i++) {
      await runClaudeHook(JSON.stringify({ hook_event_name: "SubagentStart", session_id: sid, cwd: "/tmp", agent_id: `a${String(i).padStart(7, "0")}ffff`, agent_type: "Explore" }), { CLAUDE_CODE_SESSION_ID: sid });
    }
    const shown = new Set(h.statuses().map((s) => s.agent));
    expect(shown.size).toBe(MAX_SUBAGENTS_PER_PARENT);
    // A capped one's later tool calls stay unreported too.
    await runClaudeHook(JSON.stringify({ hook_event_name: "PostToolUse", session_id: sid, cwd: "/tmp", agent_id: `a${String(MAX_SUBAGENTS_PER_PARENT + 1).padStart(7, "0")}ffff`, tool_name: "Read", tool_input: {} }), { CLAUDE_CODE_SESSION_ID: sid });
    expect(new Set(h.statuses().map((s) => s.agent)).size).toBe(MAX_SUBAGENTS_PER_PARENT);
  });

  test("the session's Stop ends a shown sub-agent that is no longer running (its SubagentStop was missed)", async () => {
    const h = hookEnv();
    const sid = "57a1e000-0000-4000-8000-000000000000";
    const env = { CLAUDE_CODE_SESSION_ID: sid };
    const ev = (e: Record<string, unknown>) => runClaudeHook(JSON.stringify({ session_id: sid, cwd: "/tmp", ...e }), env);
    await ev({ hook_event_name: "SubagentStart", agent_id: "11111111aaaa", agent_type: "Explore" });
    await ev({ hook_event_name: "SubagentStart", agent_id: "22222222bbbb", agent_type: "Explore" });
    await ev({ hook_event_name: "Stop", background_tasks: [{ id: "22222222bbbb", type: "subagent", status: "running", description: "x", agent_type: "Explore" }] });
    const last = (a: string) => h.statuses().filter((s) => s.agent === a).at(-1);
    expect(last("cc-57a1e0.11111111aaaa")).toMatchObject({ state: "offline", activity: "Sub-agent finished" });
    expect(last("cc-57a1e0.22222222bbbb")).toMatchObject({ state: "working" });
    // A Stop from a Claude Code that doesn't list background tasks ends nothing.
    await ev({ hook_event_name: "Stop" });
    expect(last("cc-57a1e0.22222222bbbb")).toMatchObject({ state: "working" });
    await ev({ hook_event_name: "SessionEnd", reason: "other" });
    expect(last("cc-57a1e0.22222222bbbb")).toMatchObject({ state: "offline", activity: "Parent session ended" });
    expect(existsSync(join(h.home, "agents", "cc-57a1e0.subq"))).toBe(false);
  });
});

describe("naming, projection, roster rules", () => {
  test("names: <parent>.<8 of the id>, always a valid agent name", () => {
    expect(subagentName("cc-11fd55", "a6d1c079e3c5436c8")).toBe("cc-11fd55.a6d1c079e3c5");
    const long = "x".repeat(48);
    const n = subagentName(long, "ABCDEF0123456789") as string;
    expect(n.length).toBeLessThanOrEqual(48);
    expect(n).toMatch(/^[a-z0-9][a-z0-9._-]{0,47}$/);
    expect(namedUnder(n, long)).toBe(true);
    expect(namedUnder("cc-other.a6d1c079e3c5", "cc-11fd55")).toBe(false);
    expect(subagentName("cc-1", "---")).toBeNull();
  });

  test("projection: parent only when named under it; a custom type only with share_prompts; the phrases are fixed", () => {
    const body: BodyOf<"agent.status"> = { agent: "cc-11fd55.a6d1c079e3c5", parent: "cc-11fd55", subagent_type: "acme-billing-reviewer", state: "working", runtime: "claude-code", title: "Audit the ExampleCo invoices", activity: "Sub-agent started" };
    const off = projectStatus(body, { title: "prompt", activity: "phrase" }, { prompts: false, activity: false });
    expect(off).toMatchObject({ parent: "cc-11fd55", subagent_type: "custom", activity: "Sub-agent started" });
    expect(off.title).toBeUndefined();
    expect(projectStatus(body, { title: "prompt" }, { prompts: true, activity: false })).toMatchObject({ subagent_type: "acme-billing-reviewer", title: "Audit the ExampleCo invoices" });
    expect(projectStatus({ ...body, subagent_type: "Explore" }, {}, { prompts: false, activity: false }).subagent_type).toBe("Explore");
    expect(projectStatus({ ...body, parent: "cc-other" }, {}, { prompts: false, activity: false }).parent).toBeUndefined();
    // Idempotent (re-signing never differs for this reason alone).
    expect(projectStatus(off, { title: "prompt" }, { prompts: false, activity: false })).toEqual(off);
    for (const p of ["Sub-agent started", "Sub-agent finished", "Parent session ended"]) expect(ACTIVITY_PHRASES.has(p)).toBe(true);
    expect(shareableSubagentType("general-purpose", false)).toBe("general-purpose");
  });

  test("a session with working sub-agents is shown and never archived, whatever its own state", () => {
    const now = Date.now();
    expect(shownByDefault({ effective_state: "idle", subagents: { working: 2 } })).toBe(true);
    expect(shownByDefault({ effective_state: "idle", subagents: { working: 0 } })).toBe(false);
    expect(isArchived({ effective_state: "idle", updated_at: now - 3 * 3_600_000, subagents: { working: 1 } }, now)).toBe(false);
    expect(isArchived({ effective_state: "idle", updated_at: now - 3 * 3_600_000 }, now)).toBe(true);
    expect(subagentsText(1)).toBe("1 sub-agent working");
    expect(subagentsText(3)).toBe("3 sub-agents working");
    expect(subagentLabel("Explore")).toBe("Sub-agent (Explore)");
  });

  test("counts per session: working and live; archived sub-agents don't count", () => {
    const row = (agent: string, parent: string | undefined, effective_state: string, archived = false) => ({ node: "n1", agent, effective_state, archived, status: parent ? { parent } : {} });
    const c = countSubagents([row("cc-1", undefined, "idle"), row("cc-1.a", "cc-1", "working"), row("cc-1.b", "cc-1", "working"), row("cc-1.c", "cc-1", "offline"), row("cc-1.d", "cc-1", "offline", true)]);
    expect(c.get("n1/cc-1")).toEqual({ working: 2, live: 3 });
  });

  test("the archive keeps at most SUBAGENT_ARCHIVE_CAP_PER_NODE sub-agents per machine, for a day; sessions keep their room", () => {
    const now = Date.now();
    const view = (agent: string, ageMs: number, parent?: string): AgentView => ({
      id: `k/m/${agent}`, handle: "k", node: "n1", hostname: "m", agent, updated_at: now - ageMs, machine_online: true,
      effective_state: "offline", archived: true, status: { agent, state: "offline", runtime: "claude-code", ...(parent ? { parent } : {}) },
    });
    const subs = Array.from({ length: SUBAGENT_ARCHIVE_CAP_PER_NODE + 20 }, (_, i) => view(`cc-1.${String(i).padStart(8, "0")}`, 20 * 60_000 + i, "cc-1"));
    const old = view("cc-1.old00000", SUBAGENT_ARCHIVE_TTL_MS + 1, "cc-1");
    const sessions = Array.from({ length: 150 }, (_, i) => view(`cc-s${i}`, 30 * 60_000 + i));
    const drop = archiveOverflow([...subs, old, ...sessions], now);
    const dropped = new Set(drop.map((a) => a.agent));
    expect(dropped.has("cc-1.old00000")).toBe(true);
    expect(subs.filter((a) => dropped.has(a.agent)).length).toBe(20); // the oldest beyond the cap
    // 150 sessions + 100 kept sub-agents = 250 > 200: the oldest 50 of those go, never all sessions.
    expect(sessions.filter((a) => !dropped.has(a.agent)).length).toBeGreaterThan(90);
  });
});

describe("hooks install and upgrade (Opus mission-sub r1 #1-4)", () => {
  const OLD = [
    { event: "SessionStart" }, { event: "UserPromptSubmit" }, { event: "PostToolUse", matcher: "*" },
    { event: "Notification" }, { event: "Stop" }, { event: "SessionEnd" },
  ];
  const CMD = '"/Users/dev/.walkie/bin/walkie"';
  const OURS = `${CMD} hook claude # walkie-managed`;
  type Entry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };
  type S = { theme?: string; hooks: Record<string, Entry[]> };
  const oldInstall = (): S => {
    const hooks: Record<string, Entry[]> = { Stop: [{ hooks: [{ type: "command", command: "bash ~/mine.sh" }] }] };
    for (const { event, matcher } of OLD) hooks[event] = [...(hooks[event] ?? []), { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: OURS, timeout: 5 }] }];
    return { theme: "dark", hooks };
  };
  const sandbox = () => {
    const dir = mkdtempSync("/tmp/walkie-settings-");
    cleanups.push(() => { try { chmodSync(dir, 0o700); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
    const home = join(dir, "walkie-home");
    return { dir, home, path: join(dir, "settings.json") };
  };
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as S;
  const ourEvents = (st: S) => Object.entries(st.hooks).filter(([, es]) => es.some((e) => e.hooks.some((h) => h.command === OURS))).map(([ev]) => ev).sort();

  test("install: the new events, idempotently; a person's hook sharing an entry with ours is kept", () => {
    const events = CLAUDE_EVENTS.map((e) => `${e.event}${e.matcher ? `:${e.matcher}` : ""}`);
    expect(events).toEqual(expect.arrayContaining(["SubagentStart", "SubagentStop", "PreToolUse:Agent|Task", "PostToolUse:*"]));
    const once = withClaudeHooks({}, CMD, true);
    expect(withClaudeHooks(once, CMD, true)).toEqual(once);
    const mixed = { hooks: { Stop: [{ hooks: [{ type: "command", command: OURS, timeout: 5 }, { type: "command", command: "bash ~/notify.sh" }] }] } };
    const re = withClaudeHooks(mixed, CMD, true) as S;
    expect(re.hooks.Stop?.some((e) => e.hooks.length === 1 && e.hooks[0]?.command === "bash ~/notify.sh")).toBe(true);
  });

  test("refresh is additive: only the sub-agent events, as new entries; every existing entry byte-for-byte kept; a backup", () => {
    const { dir, home, path } = sandbox();
    const before = oldInstall();
    before.hooks.Notification = [{ hooks: [{ type: "command", command: OURS, timeout: 30 }] }]; // a person's timeout
    delete (before.hooks as Record<string, unknown>).SessionEnd; // a person removed one of ours on purpose
    writeFileSync(path, JSON.stringify(before));
    const r = refreshClaudeHooks({ settingsPath: path, home, now: 1 });
    expect(r).toEqual({ status: "written", added: ["PreToolUse", "SubagentStart", "SubagentStop"] });
    const next = read(path);
    for (const [ev, entries] of Object.entries(before.hooks)) expect(next.hooks[ev]).toEqual(entries);
    expect(next.hooks.SessionEnd).toBeUndefined();
    expect(next.theme).toBe("dark");
    expect(next.hooks.PreToolUse).toEqual([{ matcher: "Agent|Task", hooks: [{ type: "command", command: OURS, timeout: 5 }] }]);
    expect(readdirSync(dir).filter((f) => f.includes(".bak-walkie-")).length).toBe(1);
    expect(refreshClaudeHooks({ settingsPath: path, home, now: 2 }).status).toBe("current");
    // Removed after Walkie added it: never added again; doctor says so.
    const trimmed = read(path);
    delete (trimmed.hooks as Record<string, unknown>).SubagentStop;
    writeFileSync(path, JSON.stringify(trimmed));
    expect(refreshClaudeHooks({ settingsPath: path, home, now: 3 }).status).toBe("current");
    const doc = claudeHooksDoctor({ settingsPath: path, home });
    expect(doc.some((d) => d.level === "warn" && /removed after Walkie added them \(SubagentStop\)/.test(d.detail))).toBe(true);
    expect(doc.some((d) => /your changes to Walkie's entries kept \(Notification/.test(d.detail))).toBe(true);
  });

  test("a mixed entry (ours + the person's) is left untouched and reported", () => {
    const { home, path } = sandbox();
    const st = oldInstall();
    st.hooks.Stop = [{ hooks: [{ type: "command", command: OURS, timeout: 5 }, { type: "command", command: "bash ~/mine.sh" }] }];
    writeFileSync(path, JSON.stringify(st));
    expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("written");
    expect(read(path).hooks.Stop).toEqual(st.hooks.Stop);
    expect(inspectClaudeHooks(read(path) as never).mixed).toEqual(["Stop"]);
    expect(claudeHooksDoctor({ settingsPath: path, home }).some((d) => /shares an entry with your own hooks \(Stop\)/.test(d.detail))).toBe(true);
  });

  test("a symlinked settings.json stays a link; the target gets the change", () => {
    const { dir, home, path } = sandbox();
    const real = join(dir, "dotfiles", "claude-settings.json");
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(real, JSON.stringify(oldInstall()));
    symlinkSync(real, path);
    expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("written");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(real);
    expect(ourEvents(read(real))).toContain("SubagentStart");
    expect(readdirSync(join(dir, "dotfiles")).filter((f) => f.endsWith(".tmp"))).toEqual([]); // no temp file left
  });

  test("the file's mode is kept exactly (0600 stays 0600; 0660 isn't narrowed by the umask)", () => {
    for (const mode of [0o600, 0o660]) {
      const { home, path } = sandbox();
      writeFileSync(path, JSON.stringify(oldInstall()));
      chmodSync(path, mode);
      expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("written");
      expect(statSync(path).mode & 0o777).toBe(mode);
      expect(statSync(path).uid).toBe(process.getuid?.() as number);
    }
  });

  test("a read-only file (0444) or directory is skipped, unchanged, and doctor warns", () => {
    const { dir, home, path } = sandbox();
    const text = JSON.stringify(oldInstall());
    writeFileSync(path, text);
    chmodSync(path, 0o444);
    expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("read-only");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(claudeHooksDoctor({ settingsPath: path, home }).some((d) => d.level === "warn" && /not writable/.test(d.detail))).toBe(true);
    chmodSync(path, 0o644);
    chmodSync(dir, 0o555); // the rename needs the directory
    expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("read-only");
    chmodSync(dir, 0o700);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("a write before the re-check is never lost: re-read once, then give up", () => {
    const { home, path } = sandbox();
    writeFileSync(path, JSON.stringify(oldInstall()));
    let n = 0;
    const always = () => { const st = read(path); writeFileSync(path, JSON.stringify({ ...st, theme: `t${++n}` })); };
    expect(refreshClaudeHooks({ settingsPath: path, home, beforeRecheck: always }).status).toBe("changed-underneath");
    expect(read(path).theme).toBe("t2"); // the other writer's content, untouched
    let once = 0;
    const first = () => { if (once++ === 0) { const st = read(path); writeFileSync(path, JSON.stringify({ ...st, theme: "person" })); } };
    expect(refreshClaudeHooks({ settingsPath: path, home, beforeRecheck: first }).status).toBe("written");
    expect(read(path).theme).toBe("person"); // kept, and our events added on top
    expect(ourEvents(read(path))).toContain("SubagentStop");
  });

  test("a hard-linked settings.json is left alone (a rename would cut the other link) and doctor says so", () => {
    const { dir, home, path } = sandbox();
    const text = JSON.stringify(oldInstall());
    writeFileSync(path, text);
    linkSync(path, join(dir, "other-link.json"));
    expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("hard-linked");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(statSync(path).nlink).toBe(2);
    expect(claudeHooksDoctor({ settingsPath: path, home }).some((d) => d.level === "warn" && /2 hard links/.test(d.detail))).toBe(true);
  });

  test("a malformed event value (an object, not a list) is never replaced; doctor warns", () => {
    const { home, path } = sandbox();
    const st = oldInstall() as unknown as { hooks: Record<string, unknown> };
    st.hooks.SubagentStart = { hooks: [{ type: "command", command: "bash ~/mine.sh" }] };
    writeFileSync(path, JSON.stringify(st));
    expect(refreshClaudeHooks({ settingsPath: path, home })).toMatchObject({ status: "written", added: ["PreToolUse", "SubagentStop"] });
    expect(read(path).hooks.SubagentStart).toEqual(st.hooks.SubagentStart as never);
    expect(claudeHooksDoctor({ settingsPath: path, home }).some((d) => d.level === "warn" && /not a list of entries \(SubagentStart\)/.test(d.detail))).toBe(true);
    // `hooks` itself not an object: nothing at all.
    writeFileSync(path, JSON.stringify({ hooks: [OURS] }));
    expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("not-installed");
    expect(claudeHooksDoctor({ settingsPath: path, home })[0]?.detail).toMatch(/not an object/);
  });

  test("the file's indentation (4 spaces, tabs) and final newline are kept", () => {
    for (const indent of [4, "\t"] as const) {
      const { home, path } = sandbox();
      writeFileSync(path, JSON.stringify(oldInstall(), null, indent));
      expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("written");
      const text = readFileSync(path, "utf8");
      expect(detectIndent(text)).toBe(indent);
      expect(text.endsWith("\n")).toBe(false);
      expect(text).toBe(JSON.stringify(read(path), null, indent));
    }
    expect(detectIndent("{}")).toBe(2);
  });

  test("the marker records only events seen in the file after the rename; a failed marker write is a warning", () => {
    const { home, path } = sandbox();
    const original = JSON.stringify(oldInstall());
    writeFileSync(path, original);
    // A writer saves its stale copy right after our rename: our events are gone, so nothing is recorded as added.
    const r = refreshClaudeHooks({ settingsPath: path, home, afterRename: () => writeFileSync(path, original) });
    expect(r.status).toBe("changed-underneath");
    expect(existsSync(join(home, "hooks-refresh.json"))).toBe(false);
    // So the next start adds them (they weren't "removed by the person").
    const w = refreshClaudeHooks({ settingsPath: path, home, writeMarker: () => { throw new Error("disk full"); } });
    expect(w).toMatchObject({ status: "written", added: ["PreToolUse", "SubagentStart", "SubagentStop"] });
    expect(w.detail).toMatch(/marker not saved: disk full/);
    expect(ourEvents(read(path))).toContain("SubagentStart");
  });

  test("the backup is taken before the re-check (what's backed up is what was checked)", () => {
    const { dir, home, path } = sandbox();
    const original = JSON.stringify(oldInstall());
    writeFileSync(path, original);
    let backups: string[] = [];
    expect(refreshClaudeHooks({ settingsPath: path, home, now: 7, beforeRecheck: () => { backups = readdirSync(dir).filter((f) => f.includes(".bak-walkie-")); } }).status).toBe("written");
    expect(backups).toEqual(["settings.json.bak-walkie-7"]);
    expect(readFileSync(join(dir, "settings.json.bak-walkie-7"), "utf8")).toBe(original);
  });

  test("never installs where the person didn't", () => {
    const { home, path } = sandbox();
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash ~/mine.sh" }] }] } }));
    expect(refreshClaudeHooks({ settingsPath: path, home }).status).toBe("not-installed");
    expect(refreshClaudeHooks({ settingsPath: `${path}.missing`, home }).status).toBe("no-settings");
    expect(claudeHooksDoctor({ settingsPath: path, home })[0]?.detail).toMatch(/not installed/);
  });
});

describe("discovery and sub-agents", () => {
  const disc: Array<() => void> = [];
  afterEach(() => { while (disc.length) disc.pop()?.(); });

  test("a sub-agent is never swept while its session runs (it is no process of its own); it ends when the session is gone", async () => {
    const w = world(disc);
    const sub = `${AGENT}.aaaaaaaa`;
    hook(w.core, "working", "Sub-agent started", sub, { parent: AGENT, subagent_type: "Explore" });
    w.clock.t += SWEEP_GRACE_MS + 1;
    await w.disc().tick();
    expect(status(w.core, sub)?.state).toBe("working");
    // The session's processes are gone: its sub-agent ended with it.
    w.fx.procs = w.fx.procs.filter((p) => p.pid === 1);
    w.clock.t += SWEEP_GRACE_MS + 1;
    await w.disc().tick();
    expect(status(w.core, sub)).toMatchObject({ state: "offline", parent: AGENT });
  });
});

describe("descriptions, names and stale state (Opus mission-sub r1 #4)", () => {
  const SID = "d15c0000-0000-4000-8000-000000000000";
  const P = "cc-d15c00";
  const env = { CLAUDE_CODE_SESSION_ID: SID };
  const ev = (e: Record<string, unknown>) => runClaudeHook(JSON.stringify({ session_id: SID, cwd: "/tmp", ...e }), env);
  const launch = (tu: string, description: string, type: string) => ev({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: tu, tool_input: { description, subagent_type: type } });

  test("a pending launch titles only a sub-agent of the same type (no any-type fallback)", async () => {
    const h = hookEnv();
    await launch("toolu_P", "Plan the rollout", "Plan");
    await ev({ hook_event_name: "SubagentStart", agent_id: "e0e0e0e0e0e0e0", agent_type: "Explore" });
    const st = h.statuses().at(-1);
    expect(st).toMatchObject({ agent: `${P}.e0e0e0e0e0e0`, subagent_type: "Explore" });
    expect(st?.title).toBeUndefined();
    await ev({ hook_event_name: "SubagentStart", agent_id: "f1f1f1f1f1f1f1", agent_type: "Plan" });
    expect(h.statuses().at(-1)).toMatchObject({ agent: `${P}.f1f1f1f1f1f1`, title: "Plan the rollout" });
  });

  test("a refused launch (recorded: PreToolUse then Stop, no PostToolUse) is dropped at the turn's end, never titling a later one", async () => {
    const h = hookEnv();
    const lines = fixture("denied-launch.jsonl");
    expect(lines.map((l) => l.event)).toEqual(["PreToolUse", "Stop"]);
    await h.replay(lines);
    const sid = String(lines[0]?.payload.session_id);
    const parent = `cc-${sid.slice(0, 6)}`;
    expect(existsSync(join(h.home, "agents", `${parent}.subq`)) ? readdirSync(join(h.home, "agents", `${parent}.subq`)) : []).toEqual([]);
    await runClaudeHook(JSON.stringify({ hook_event_name: "SubagentStart", session_id: sid, cwd: "/tmp", agent_id: "0123456789abcdef", agent_type: "general-purpose" }), { CLAUDE_CODE_SESSION_ID: sid });
    expect(h.statuses().at(-1)?.title).toBeUndefined(); // not "probe denied"
  });

  test("a foreground launch's reply after SubagentStop corrects the title: the ended row is posted again", async () => {
    const h = hookEnv();
    await launch("toolu_1", "first job", "general-purpose");
    await launch("toolu_2", "second job", "general-purpose");
    await ev({ hook_event_name: "SubagentStart", agent_id: "b2b2b2b2b2b2b2", agent_type: "general-purpose" }); // guessed "first job"
    await ev({ hook_event_name: "SubagentStop", agent_id: "b2b2b2b2b2b2b2", agent_type: "general-purpose" });
    const posts = () => h.statuses().filter((s) => s.agent === `${P}.b2b2b2b2b2b2`);
    expect(posts().at(-1)).toMatchObject({ state: "offline", title: "first job" });
    await ev({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_2", tool_input: { description: "second job" }, tool_response: { status: "completed", agentId: "b2b2b2b2b2b2b2" } });
    expect(posts().at(-1)).toMatchObject({ state: "offline", title: "second job", activity: "Sub-agent finished" });
    const n = posts().length;
    await ev({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_2", tool_input: { description: "second job" }, tool_response: { status: "completed", agentId: "b2b2b2b2b2b2b2" } });
    expect(posts().length).toBe(n); // already right: nothing posted
  });

  test("rows are unique: another sub-agent whose id shares the first 12 characters gets a longer name, never the first one's row", async () => {
    const h = hookEnv();
    expect(subagentName(P, "a6d1c079e3c5436c8")).toBe(`${P}.a6d1c079e3c5`);
    // Codex r2 #1's replay: start 1111, start 2222, stop 2222.
    await ev({ hook_event_name: "SubagentStart", agent_id: "aaaaaaaaaaaa1111", agent_type: "Explore" });
    await ev({ hook_event_name: "SubagentStart", agent_id: "aaaaaaaaaaaa2222", agent_type: "Plan" });
    await ev({ hook_event_name: "SubagentStop", agent_id: "aaaaaaaaaaaa2222", agent_type: "Plan" });
    const rows = (a: string) => h.statuses().filter((s) => s.agent === a).map((s) => [s.state, s.session]);
    expect(rows(`${P}.aaaaaaaaaaaa`)).toEqual([["working", "aaaaaaaaaaaa1111"]]);
    expect(rows(`${P}.aaaaaaaaaaaa2222`)).toEqual([["working", "aaaaaaaaaaaa2222"], ["offline", "aaaaaaaaaaaa2222"]]);
    // An ended row isn't taken over either.
    await ev({ hook_event_name: "SubagentStop", agent_id: "aaaaaaaaaaaa1111", agent_type: "Explore" });
    await ev({ hook_event_name: "SubagentStart", agent_id: "aaaaaaaaaaaa3333", agent_type: "Explore" });
    expect(h.statuses().at(-1)).toMatchObject({ agent: `${P}.aaaaaaaaaaaa3333`, session: "aaaaaaaaaaaa3333" });
    // State keys never alias ("abc-def" vs "abcdef"), and the candidates are valid, distinct agent names.
    expect(stateKey(P, "abc-def")).not.toBe(stateKey(P, "abcdef"));
    const c = rowCandidates("x".repeat(48), "ABC-def-0123456789abcdef0123");
    expect(new Set(c).size).toBe(c.length);
    for (const n of c) expect(n).toMatch(/^[a-z0-9][a-z0-9._-]{0,47}$/);
  });

  test("launch replies obey the launch cache's size and expiry (Codex r2 #3)", async () => {
    const h = hookEnv();
    for (let i = 0; i < MAX_LAUNCHES + 40; i++) {
      await ev({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: `toolu_${i}`, tool_input: { description: `job ${i}` }, tool_response: { isAsync: true, agentId: `${String(i).padStart(12, "0")}beef`, description: `job ${i}` } });
    }
    expect(readdirSync(join(h.home, "agents", `${P}.subq`)).length).toBeLessThanOrEqual(MAX_LAUNCHES);
    // An id entry past its expiry titles nothing.
    const dir = join(h.home, "agents", `${P}.subq`);
    const last = `id-${String(MAX_LAUNCHES + 39).padStart(12, "0")}beef.json`;
    const e = JSON.parse(readFileSync(join(dir, last), "utf8")) as { at: number };
    writeFileSync(join(dir, last), JSON.stringify({ ...e, at: e.at - LAUNCH_ID_TTL_MS - 1 }));
    await ev({ hook_event_name: "SubagentStart", agent_id: `${String(MAX_LAUNCHES + 39).padStart(12, "0")}beef`, agent_type: "general-purpose" });
    expect(h.statuses().at(-1)?.title).toBeUndefined();
  });

  test("the daemon prunes hook state by age and by the session's absence, in batches, sessions' own stale state included", async () => {
    const w = world(disc2);
    const home = mkdtempSync("/tmp/walkie-prune-");
    disc2.push(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, "agents");
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const put = (name: string, body: unknown, ageMs: number) => {
      const p = join(dir, name);
      if (body === "dir") mkdirSync(p); else writeFileSync(p, JSON.stringify(body));
      utimesSync(p, new Date(now - ageMs), new Date(now - ageMs));
    };
    const sub = (id: string, parent: string) => ({ agent_id: id, parent, injected: [] });
    hook(w.core, "working", "Thinking", "cc-alive1");
    hook(w.core, "offline", "Session ended", "cc-gone01");
    put("cc-alive1.json", { injected: [] }, 3 * 86_400_000); // its session runs: kept
    put("cc-gone01.json", { injected: [] }, SESSION_STATE_TTL_MS + 1); // an ended session's own state, a week old
    put("cc-gone02.json", { injected: [] }, SESSION_STATE_TTL_MS - 60_000); // ended, but not a week old
    put("cc-alive1.aaaaaaaaaaaa.json", sub("aaaaaaaaaaaa", "cc-alive1"), 60 * 60_000); // session alive: kept
    put("cc-alive1.subq", "dir", 60 * 60_000);
    put("cc-alive1.bbbbbbbbbbbb.json", sub("bbbbbbbbbbbb", "cc-alive1"), 2 * 86_400_000); // too old
    put("cc-gone01.cccccccccccc.json", sub("cccccccccccc", "cc-gone01"), 20 * 60_000); // ended session
    put("cc-gone01.subq", "dir", 20 * 60_000);
    put("cc-norow1.dddddddddddd.json", sub("dddddddddddd", "cc-norow1"), 20 * 60_000); // no status: running per discovery
    put("cc-norow2.ffffffffffff.json", sub("ffffffffffff", "cc-norow2"), 20 * 60_000); // no status, not running
    put("cc-gone01.eeeeeeeeeeee.json", sub("eeeeeeeeeeee", "cc-gone01"), 60_000); // just written: grace
    put(".settings.json.walkie-1.tmp", {}, 2 * 3_600_000);
    // Discovery can't say: a session without a status counts as running.
    expect(await pruneHookState(home, w.core, { now, running: () => null })).toBe(5);
    expect(readdirSync(dir)).toContain("cc-norow2.ffffffffffff.json");
    // A complete scan saw cc-norow1 running, not cc-norow2.
    expect(await pruneHookState(home, w.core, { now, running: () => new Set(["cc-norow1"]) })).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["cc-alive1.aaaaaaaaaaaa.json", "cc-alive1.json", "cc-alive1.subq", "cc-gone01.eeeeeeeeeeee.json", "cc-gone02.json", "cc-norow1.dddddddddddd.json"]);
    // Every entry is visited, a batch at a time.
    for (let i = 0; i < PRUNE_BATCH * 2 + 5; i++) put(`cc-gone01.${String(i).padStart(12, "0")}.json`, sub(String(i), "cc-gone01"), 3 * 86_400_000);
    let pauses = 0;
    expect(await pruneHookState(home, w.core, { now, pause: async () => { pauses++; } })).toBe(PRUNE_BATCH * 2 + 5);
    expect(pauses).toBe(2);
  });
});
const disc2: Array<() => void> = [];
afterEach(() => { while (disc2.length) disc2.pop()?.(); });

describe("info items (Opus mission-sub r1)", () => {
  test("a refusal by the session's shared bucket never spends the sub-agent's own token", () => {
    const l = new RateLimiter();
    const spec = { capacity: 1, perSecond: 0.001 };
    expect(l.can("s", spec, 0)).toBe(true);
    expect(l.can("s", spec, 0)).toBe(true); // can() takes nothing
    expect(l.take("s", spec, 0)).toBe(true);
    expect(l.can("s", spec, 1)).toBe(false);
  });

  test("sub-agent types keep name characters only, for the owner's view too", () => {
    expect(cleanSubagentType("plugin:reviewer\u0007\n<script>")).toBe("plugin:reviewerscript");
    expect(cleanSubagentType("  ")).toBeUndefined();
    expect(cleanSubagentType("x".repeat(90))?.length).toBe(60);
    const w = world(disc2);
    w.core.noteLocalSubagent("cc-1.aaaaaaaaaaaa", { type: "evil\u001b[31m-type" });
    expect(w.core.localSubagents.get("cc-1.aaaaaaaaaaaa")?.type).toBe("evil31m-type");
  });
});

describe("Codex mission-sub r1", () => {
  const SID = "c0de0000-0000-4000-8000-000000000000";
  const P = "cc-c0de00";
  const env = { CLAUDE_CODE_SESSION_ID: SID };
  const ev = (e: Record<string, unknown>) => runClaudeHook(JSON.stringify({ session_id: SID, cwd: "/tmp", ...e }), env);

  test("#1 HIGH: a launch's description and a custom type never become activity text, whatever the policy", () => {
    const desc = { description: "Acquire ExampleCo before earnings", subagent_type: "general-purpose" };
    expect(describeTool("Agent", desc, "/tmp", true)).toBe("Subagent: general-purpose");
    expect(describeTool("Task", { description: "Acquire ExampleCo", subagent_type: "exampleco-deal-desk" }, "/tmp", true)).toBe("Waiting on a subagent");
    expect(describeTool("Agent", { description: "Acquire ExampleCo" }, "/tmp", true)).toBe("Waiting on a subagent");
    // The daemon's projection drops a launch line naming anything else (an older hook, discovery) without share_prompts.
    const body: BodyOf<"agent.status"> = { agent: "cc-1", state: "working", runtime: "claude-code", activity: "Subagent: Acquire ExampleCo before earnings" };
    expect(projectStatus(body, { activity: "tool" }, { prompts: false, activity: true }).activity).toBe("Working");
    expect(projectStatus({ ...body, activity: "Subagent: Explore" }, { activity: "tool" }, { prompts: false, activity: true }).activity).toBe("Subagent: Explore");
    expect(projectStatus(body, { activity: "tool" }, { prompts: true, activity: true }).activity).toBe(body.activity);
  });

  test("#1 HIGH, the hook end to end: share_activity on, share_prompts off: no description in any status the parent sends", async () => {
    const h = hookEnv({ share_activity: true });
    await ev({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "toolu_X", tool_input: { description: "Acquire ExampleCo before earnings", subagent_type: "general-purpose" } });
    await ev({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_X", tool_input: { description: "Acquire ExampleCo before earnings", subagent_type: "general-purpose" }, tool_response: { isAsync: true, agentId: "abcabcabcabc1234", description: "Acquire ExampleCo before earnings" } });
    const parent = h.statuses().filter((s) => s.agent === P);
    expect(parent.length).toBeGreaterThan(0);
    for (const s of parent) expect(JSON.stringify(s)).not.toContain("ExampleCo");
  });

  test("#6: state is keyed by the full id: stopping another id with the same 12 characters leaves the first row alone", async () => {
    const h = hookEnv();
    await ev({ hook_event_name: "SubagentStart", agent_id: "aaaaaaaaaaaa1111", agent_type: "Explore" });
    await ev({ hook_event_name: "SubagentStop", agent_id: "aaaaaaaaaaaa2222", agent_type: "Explore" });
    const rows = h.statuses().filter((s) => s.agent === `${P}.aaaaaaaaaaaa`);
    expect(rows.map((s) => s.state)).toEqual(["working"]);
  });

  test("#7: a resumed sub-agent (a new start, or a tool call after the grace) is working again; a straggler is not", async () => {
    const h = hookEnv();
    const id = "7e5e7e5e7e5e7e5e";
    const rows = () => h.statuses().filter((s) => s.agent === `${P}.7e5e7e5e7e5e`).map((s) => s.state);
    await ev({ hook_event_name: "SubagentStart", agent_id: id, agent_type: "general-purpose" });
    await ev({ hook_event_name: "SubagentStop", agent_id: id, agent_type: "general-purpose" });
    await ev({ hook_event_name: "PostToolUse", agent_id: id, tool_name: "Read", tool_input: {} }); // straggler of that run
    expect(rows()).toEqual(["working", "offline"]);
    await ev({ hook_event_name: "SubagentStart", agent_id: id, agent_type: "general-purpose" }); // resumed
    await ev({ hook_event_name: "PostToolUse", agent_id: id, tool_name: "Read", tool_input: {} });
    expect(rows()).toEqual(["working", "offline", "working", "working"]);
    await ev({ hook_event_name: "SubagentStop", agent_id: id, agent_type: "general-purpose" });
    // A tool call long after the stop (no SubagentStart seen): resumed too.
    const key = join(h.home, "agents", `${P}.${id}.json`);
    const st = JSON.parse(readFileSync(key, "utf8")) as { last_at: number };
    writeFileSync(key, JSON.stringify({ ...st, last_at: st.last_at - RESUME_GRACE_MS - 1 }));
    await ev({ hook_event_name: "PostToolUse", agent_id: id, tool_name: "Read", tool_input: {} });
    expect(rows().at(-1)).toBe("working");
  });

  test("#9: a flood over the cap stores nothing for the refused ones", async () => {
    const h = hookEnv();
    for (let i = 0; i < 120; i++) await ev({ hook_event_name: "SubagentStart", agent_id: `${String(i).padStart(12, "0")}f100d`, agent_type: "Explore" });
    expect(new Set(h.statuses().map((s) => s.agent)).size).toBe(MAX_SUBAGENTS_PER_PARENT);
    const files = readdirSync(join(h.home, "agents")).filter((f) => f.startsWith(`${P}.`) && f.endsWith(".json"));
    expect(files.length).toBe(MAX_SUBAGENTS_PER_PARENT);
  }, 30_000);
});
