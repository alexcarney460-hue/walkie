// WALKIE-LIVE-2: Mission Control order, time-in-state, the cleaned-up Live activity, `hidden`, and the signed-out screen.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountView, AgentState, AgentView, Event, NodeView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { AgentSince } from "../../src/protocol/agent-since.ts";
import { go, installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let mod: {
  MissionControl: () => ReactNode; SignedOut: () => ReactNode; BootError: (p: { message: string }) => ReactNode;
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
  reducer: typeof import("../src/state/reducer.ts").reducer;
  buildActivity: typeof import("../src/views/mission/activity-items.ts").buildActivity;
  useNow: typeof import("../src/lib/time.ts").useNow;
};
beforeAll(async () => {
  const [mc, fr, st, rd, ai, tm] = await Promise.all([
    import("../src/views/mission/MissionControl.tsx"), import("../src/views/FirstRun.tsx"), import("../src/state/store.tsx"),
    import("../src/state/reducer.ts"), import("../src/views/mission/activity-items.ts"), import("../src/lib/time.ts"),
  ]);
  mod = { MissionControl: mc.MissionControl, SignedOut: fr.SignedOut, BootError: fr.BootError, StaticStore: st.StaticStore, initialState: rd.initialState, reducer: rd.reducer, buildActivity: ai.buildActivity, useNow: tm.useNow };
});

const NOW = Date.now();
const MIN = 60_000;
const node = (hostname: string, id: string): NodeView => ({
  node_id: id, handle: "maren", hostname, ip: "100.64.0.1", online: true, last_seen: NOW, rtt_ms: 3, self: hostname === "maren-mbp", sync: { behind: 0, last_sync: NOW },
});
const NODES = [node("maren-mbp", "n1"), node("atlas", "n2")];
const TEAM: TeamView = {
  id: "t", name: "harbor", authority: "n1", channels: [], nodes: NODES, plan: undefined as never,
  members: [{ login: "maren@x", handle: "maren", role: "owner", display_name: "Maren Holt" }],
};
const agent = (hostname: string, name: string, state: AgentState, extra: Partial<AgentView> = {}, activity = "Running a command"): AgentView => ({
  id: `maren/${hostname}/${name}`, handle: "maren", node: NODES.find((n) => n.hostname === hostname)!.node_id, hostname, agent: name,
  status: { agent: name, state, runtime: "claude-code", title: `${name} title`, activity }, updated_at: NOW - MIN, machine_online: true,
  effective_state: state, archived: false, ...extra,
});
const ACCOUNT: AccountView = {
  key: "claude:al", provider: "claude", label: "al***@gm***.com", owners: ["maren"], machines: [{ node: "n2", hostname: "atlas", online: true, agents: ["seat-1"] }],
  usage: null,
} as unknown as AccountView;
const state = (over: Partial<State>): State => ({ ...mod.initialState, phase: "ready", team: TEAM, nodes: NODES, me: { handle: "maren" } as State["me"], ...over });
const render = (s: State, el: ReactNode) => renderToStaticMarkup(<mod.StaticStore state={s}>{el}</mod.StaticStore>);

test("Mission Control order: working agents (with a live count per machine), then Needs you, then the feed, accounts, local models", () => {
  go("#/mission");
  const out = render(state({
    agents: [agent("atlas", "seat-1", "working"), agent("atlas", "seat-2", "working"), agent("maren-mbp", "ux", "blocked")],
    accounts: [ACCOUNT],
  }), <mod.MissionControl />);
  const at = (s: string) => { const i = out.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  expect(out).toMatch(/data-testid="machine-live-atlas"[^>]*>2 working/);
  expect(out).toMatch(/data-testid="machine-live-maren-mbp"[^>]*>0 working/);
  expect(at("seat-1 title")).toBeLessThan(at('id="attention-h"'));
  expect(at('id="attention-h"')).toBeLessThan(at('aria-label="Live activity"'));
  expect(at('aria-label="Live activity"')).toBeLessThan(at('id="acct-row-h"'));
  // Accounts: one compact row (chips), collapsed; the grid of meters only after a click.
  expect(out).toContain('data-testid="accounts-row"');
  expect(out).toContain('aria-expanded="false"');
  expect(out).not.toContain("acct-mini");
});

/**
 * The dashboard's shared clock as a page reads it (one render of the hook). It moves only while something is subscribed, so in a
 * process that has run other tests for a while it is behind the wall clock; a test that asks "how long has this been true" has to
 * measure from the clock the page uses, not from Date.now(), or its answer depends on how long the suite has been running.
 */
function sharedNow(): number {
  const Probe = () => <>{mod.useNow()}</>;
  return Number(renderToStaticMarkup(<Probe />));
}

test("cards show how long the current line has been true ('Running a command · 8m 03s'), not the last update", () => {
  go("#/mission");
  const base = sharedNow();
  const out = render(state({ agents: [agent("atlas", "seat-1", "working", { updated_at: base - 5_000, activity_since: base - (8 * 60 + 3) * 1000, state_since: base - 40 * MIN })] }), <mod.MissionControl />);
  expect(out).toMatch(/data-testid="time-in-state"[^>]*>.*8m 03s/); // exactly, from the page's own clock: no tolerance for a lagging clock is needed
  expect(out).toMatch(/Working for 40m 00s/);
});

test("AgentSince: a re-posted status keeps its start; a new line or state starts again; a change without a status starts now", () => {
  const t = new AgentSince();
  const row = (state: AgentState, activity: string, observed: number) => [{ id: "a", effective_state: state, activity, observed }];
  expect(t.read(row("working", "Running a command", 1_000), 5_000).get("a")).toEqual({ state_since: 1_000, activity_since: 1_000 });
  expect(t.read(row("working", "Running a command", 600_000), 700_000).get("a")).toEqual({ state_since: 1_000, activity_since: 1_000 }); // freshness re-post
  expect(t.read(row("working", "Editing files", 800_000), 800_500).get("a")).toEqual({ state_since: 1_000, activity_since: 800_000 });
  expect(t.read(row("offline", "Editing files", 800_000), 900_000).get("a")).toEqual({ state_since: 900_000, activity_since: 900_000 }); // stale / machine left
  expect(t.read([], 900_001).size).toBe(0); // forgotten when it leaves the roster
});

// ---- Live activity ----------------------------------------------------------------------------------------------

let seq = 0;
const ev = (ts: number, agentName: string, state: AgentState, extra: Record<string, unknown> = {}, nodeId = "n2"): Event => ({
  v: 1, team: "t", id: `e${++seq}`, origin: nodeId, seq, ts, author: { handle: "maren", node: nodeId, agent: agentName }, kind: "agent.status",
  body: { agent: agentName, state, runtime: "claude-code", activity: "Thinking", ...extra }, sig: "x",
} as unknown as Event);
const feed = (chronological: Event[], limit?: number) => mod.buildActivity([...chronological].reverse(), NODES, TEAM.members, limit);

test("flapping: Working → Idle → Working within 60 s is one entry", () => {
  const t = NOW - 10 * MIN;
  const items = feed([ev(t, "a", "idle"), ev(t + 1_000, "a", "working"), ev(t + 20_000, "a", "idle"), ev(t + 40_000, "a", "working"), ev(t + 70_000, "a", "idle"), ev(t + 90_000, "a", "working")]);
  expect(items.filter((i) => i.kind === "state")).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "state", state: "working", count: 2 });
});

test("churn: sessions that come and go on one machine are one grouped entry per machine", () => {
  const t = NOW - 10 * MIN;
  const list: Event[] = [];
  for (let i = 0; i < 3; i++) {
    list.push(ev(t + i * 15_000, `agent-${i}`, "idle", { activity: "Connected to Walkie", started_at: t + i * 15_000 }));
    list.push(ev(t + i * 15_000 + 10_000, `agent-${i}`, "offline", { activity: "Process exited", started_at: t + i * 15_000 })); // markOffline keeps the body
  }
  list.push(ev(t, "long", "working", { started_at: t - 60 * MIN }), ev(t + 60_000, "long", "offline", { activity: "Process exited" }));
  const items = feed(list);
  const churn = items.filter((i) => i.kind === "churn");
  expect(churn).toHaveLength(1);
  expect(churn[0]).toMatchObject({ who: "atlas", text: "3 agents came and went", count: 3 });
  expect(items.some((i) => i.kind === "state" && i.who.startsWith("long") && i.state === "offline")).toBe(true); // a real exit stays
});

test("tool-level lines appear when shared (not Walkie's fixed phrases); an agent's steps within a minute are one entry", () => {
  const t = NOW - 10 * MIN;
  const items = feed([
    ev(t, "a", "working"), ev(t + 1_000, "a", "working", { activity: "Edit web/src/views/mission/AgentCard.tsx" }),
    ev(t + 5_000, "a", "working", { activity: "Bash bun test web/test" }), ev(t + 9_000, "a", "working", { activity: "Running a command" }),
  ]);
  const steps = items.filter((i) => i.kind === "step");
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ text: "Bash bun test web/test", count: 2 });
});

test("the feed keeps the newest 50", () => {
  const t = NOW - 60 * MIN;
  const list: Event[] = [];
  for (let i = 0; i < 80; i++) list.push({ ...ev(t + i * 30_000, "a", "working"), kind: "msg.post", channel: "build", body: { text: `post ${i}` } } as unknown as Event);
  const items = feed(list);
  expect(items.length).toBe(50);
  expect(items[0]!.text).toContain("post 79");
  expect(items[49]!.text).toContain("post 30");
});

// ---- stream `hidden` + signed out ---------------------------------------------------------------------------------

test("`hidden` drops the events (and asks / answers) it names", () => {
  const post = { ...ev(NOW, "a", "working"), id: "p1", kind: "msg.post", body: { text: "x" } } as unknown as Event;
  const ask = { ...ev(NOW, "a", "working"), id: "q1", kind: "ask", body: { to: "@maren", text: "?" } } as unknown as Event;
  const ans = { ...ev(NOW, "a", "working"), id: "r1", kind: "answer" } as unknown as Event;
  const s0 = state({ events: [post, ask], asks: [{ ask, answers: [ans], state: "answered", expires_at: NOW + MIN }] });
  const s1 = mod.reducer(s0, { type: "events/hidden", ids: ["p1", "r1"] });
  expect(s1.events.map((e) => e.id)).toEqual(["q1"]);
  expect(s1.asks[0]!.answers).toEqual([]);
  expect(s1.asks[0]!.state).toBe("open"); // its only answer is gone: actionable again (Codex r1 #5)
  const declined = { ...ans, id: "r2", body: { ask: "q1", text: "no", declined: true } } as unknown as Event;
  const two = mod.reducer(state({ events: [ask], asks: [{ ask, answers: [ans, declined], state: "answered", expires_at: NOW + MIN }] }), { type: "events/hidden", ids: ["r1"] });
  expect(two.asks[0]!.state).toBe("declined"); // follows the first remaining answer
  const late = mod.reducer(state({ events: [ask], asks: [{ ask, answers: [ans], state: "answered", expires_at: NOW - 1 }] }), { type: "events/hidden", ids: ["r1"] });
  expect(late.asks[0]!.state).toBe("expired");
  const s2 = mod.reducer(s1, { type: "events/hidden", ids: ["q1"] });
  expect(s2.asks).toEqual([]);
  expect(mod.reducer(s2, { type: "events/hidden", ids: ["nope"] })).toBe(s2);
});

test("a 401 shows 'Signed out', not 'Can't reach the daemon'", () => {
  const s = mod.reducer(state({}), { type: "boot/error", error: "session ended", signedOut: true });
  expect(s.signedOut).toBe(true);
  const out = render(s, <mod.SignedOut />);
  expect(out).toContain("Signed out of this dashboard");
  expect(out).toContain("walkie dashboard");
  expect(out).not.toContain("reach the");
  expect(render(state({}), <mod.BootError message="x" />)).toContain("reach the Walkie daemon");
});

// ---- LIVE-3 (Opus r1 UX) ------------------------------------------------------------------------------------------

test("a 'Needs you (N)' banner sits at the very top when something needs the person; working agents stay first below it", () => {
  go("#/mission");
  const busy = render(state({ agents: [agent("atlas", "seat-1", "working"), agent("maren-mbp", "ux", "waiting")] }), <mod.MissionControl />);
  const banner = busy.indexOf('data-testid="needs-you-banner"');
  expect(banner).toBeGreaterThan(-1);
  expect(busy).toMatch(/Needs you <span class="tnum">\(1\)<\/span>/);
  expect(banner).toBeLessThan(busy.indexOf("seat-1 title"));
  expect(busy.indexOf("seat-1 title")).toBeLessThan(busy.indexOf('id="attention-h"'));
  const calm = render(state({ agents: [agent("atlas", "seat-1", "working")] }), <mod.MissionControl />);
  expect(calm).not.toContain("needs-you-banner");
});

test("the card footer labels its two times: 'for 42s' (this line) and 'session 20m'", () => {
  go("#/mission");
  const a = agent("atlas", "seat-1", "working", { activity_since: NOW - 42_000 });
  const out = render(state({ agents: [{ ...a, status: { ...a.status, started_at: NOW - 20 * MIN } }] }), <mod.MissionControl />);
  expect(out).toMatch(/data-testid="time-in-state"[^>]*>.*for \d+s</); // the shared clock may lag the test
  expect(out).toMatch(/session (19|20)m/);
});
