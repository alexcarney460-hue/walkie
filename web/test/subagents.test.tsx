// WALKIE-MISSION-SUB-1: a session's sub-agents are rows of their own under its card; the session says how many work,
// stays shown while they do, and the page's working count includes them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentState, AgentView, NodeView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
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
  MissionControl: () => ReactNode; StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
  groupAgents: (list: readonly AgentView[]) => Array<{ agent: AgentView; subs: AgentView[] }>;
};
beforeAll(async () => {
  const [mc, st, rd, sa] = await Promise.all([
    import("../src/views/mission/MissionControl.tsx"), import("../src/state/store.tsx"), import("../src/state/reducer.ts"),
    import("../src/views/mission/Subagents.tsx"),
  ]);
  mod = { MissionControl: mc.MissionControl, StaticStore: st.StaticStore, initialState: rd.initialState, groupAgents: sa.groupAgents };
});

const NOW = Date.now();
const NODE: NodeView = { node_id: "n1", handle: "maren", hostname: "maren-mbp", ip: "100.64.0.1", online: true, last_seen: NOW, rtt_ms: 0, self: true, sync: { behind: 0, last_sync: NOW } };
const TEAM: TeamView = {
  id: "t", name: "harbor", authority: "n1", channels: [], nodes: [NODE], plan: undefined as never,
  members: [{ login: "maren@x", handle: "maren", role: "owner", display_name: "Maren Holt" }],
};
const row = (agent: string, state: AgentState, over: Partial<AgentView["status"]> = {}, extra: Partial<AgentView> = {}): AgentView => ({
  id: `maren/maren-mbp/${agent}`, handle: "maren", node: "n1", hostname: "maren-mbp", agent,
  status: { agent, state, runtime: "claude-code", ...over }, updated_at: NOW - 20_000, machine_online: true, effective_state: state, archived: false, ...extra,
});

const SESSION = row("cc-f7091a", "idle", { title: "Orchestrate the release" }, { subagents: { working: 2, live: 4 } });
const SUBS = [
  row("cc-f7091a.a6d1c079e3c5", "working", { parent: "cc-f7091a", subagent_type: "general-purpose", title: "Build the sub-agent rows", activity: "Editing files" }),
  row("cc-f7091a.a5c80ad3429e", "working", { parent: "cc-f7091a", subagent_type: "Explore", activity: "Searching" }),
  row("cc-f7091a.b0b0b0b0c1c1", "waiting", { parent: "cc-f7091a", subagent_type: "general-purpose", title: "Audit the fee ledger", activity: "Needs your permission" }),
  row("cc-f7091a.c1c1c1c1d2d2", "offline", { parent: "cc-f7091a", subagent_type: "Plan", title: "Plan the rollout", activity: "Sub-agent finished" }),
];

function state(agents: AgentView[]): State {
  return { ...mod.initialState, phase: "ready", team: TEAM, nodes: [NODE], me: { handle: "maren" } as State["me"], agents, archive: [] };
}
const render = (s: State) => renderToStaticMarkup(<mod.StaticStore state={s}><mod.MissionControl /></mod.StaticStore>);

test("the session card says how many sub-agents work, and lists the live ones under it", () => {
  go("#/mission");
  const out = render(state([SESSION, ...SUBS]));
  // The session is idle (its turn ended) but shown: its sub-agents work.
  expect(out).toContain("Orchestrate the release");
  expect(out).toMatch(/data-testid="subagents-cc-f7091a"[^>]*>.*2 sub-agents working/);
  const group = out.slice(out.indexOf('data-testid="agent-group-cc-f7091a"'));
  expect(group).toContain('aria-label="Sub-agents of cc-f7091a"');
  expect(group).toContain('data-testid="subagent-cc-f7091a.a6d1c079e3c5"');
  expect(group).toContain("Build the sub-agent rows");
  expect(group).toContain("Sub-agent (Explore)"); // no title (private): its type
  expect(group).toContain("a5c80ad3429e");
  expect(group).toContain("Audit the fee ledger");
  expect(out).not.toContain("Plan the rollout"); // ended: in the live roster, not shown
  // The true working count: the 2 working sub-agents (the session itself is idle).
  expect(out).toContain("2 agents working");
  // A sub-agent needing a person is in "Needs you" too.
  expect(out).toMatch(/Needs you.*cc-f7091a\.b0b0b0b0/s);
});

test("grouping: sub-agents go under their session; one whose session isn't listed gets its own card", () => {
  const orphan = row("cc-ffffff.12345678", "working", { parent: "cc-ffffff", subagent_type: "Explore" });
  const groups = mod.groupAgents([SESSION, ...SUBS.slice(0, 2), orphan]);
  expect(groups.map((g) => [g.agent.agent, g.subs.map((s) => s.agent)])).toEqual([
    ["cc-f7091a", ["cc-f7091a.a6d1c079e3c5", "cc-f7091a.a5c80ad3429e"]],
    ["cc-ffffff.12345678", []],
  ]);
  go("#/mission");
  const out = render(state([orphan]));
  expect(out).toContain("sub-agent of cc-ffffff");
  expect(out).toContain("Sub-agent (Explore)");
});

test("a session whose sub-agents all ended goes back to the normal rules (idle: not shown)", () => {
  go("#/mission");
  const done = { ...SESSION, subagents: { working: 0, live: 1 } };
  const out = render(state([done, SUBS[3] as AgentView]));
  expect(out).not.toContain("Orchestrate the release");
  expect(out).not.toContain("sub-agents working");
});
