// WALKIE-MISSION-1: Mission Control shows only working agents and those needing a person, with a per-machine count of
// what is in the archive; the Archive tab lists idle and ended agents per machine (live stream + loaded archive).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentState, AgentView, NodeView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";

// route.ts reads window.location at import: a minimal window for server-side rendering (shared, see window-stub.ts).
import { go, installWindow } from "./window-stub.ts";
const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
// Everything else a module touches at import (theme, hotkeys): a permissive stand-in whose methods do nothing.
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;

// Other test files run in this process: leave no browser globals behind.
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let mod: {
  MissionControl: () => ReactNode; ArchiveView: (p: { machine?: string }) => ReactNode;
  AgentDrawer: (p: { id: string }) => ReactNode;
  archiveEntries: (live: AgentView[], archived: AgentView[], now: number) => AgentView[];
  StaticStore: (p: { state: State; children: ReactNode }) => ReactNode; initialState: State;
};
beforeAll(async () => {
  const [mc, ar, st, rd, drawer] = await Promise.all([
    import("../src/views/mission/MissionControl.tsx"), import("../src/views/mission/Archive.tsx"),
    import("../src/state/store.tsx"), import("../src/state/reducer.ts"), import("../src/components/AgentDrawer.tsx"),
  ]);
  mod = { MissionControl: mc.MissionControl, ArchiveView: ar.ArchiveView, AgentDrawer: drawer.AgentDrawer, archiveEntries: ar.archiveEntries, StaticStore: st.StaticStore, initialState: rd.initialState };
});

const NOW = Date.now();
const MIN = 60_000;
const node = (hostname: string, handle: string, id: string): NodeView => ({
  node_id: id, handle, hostname, ip: "100.64.0.1", online: true, last_seen: NOW, rtt_ms: 3, self: hostname === "maren-mbp", sync: { behind: 0, last_sync: NOW },
});
const NODES = [node("maren-mbp", "maren", "n1"), node("atlas", "maren", "n2")];
const TEAM: TeamView = {
  id: "t", name: "harbor", authority: "n1", channels: [], nodes: NODES, plan: undefined as never,
  members: [{ login: "maren@x", handle: "maren", role: "owner", display_name: "Maren Holt" }],
};
const agent = (hostname: string, name: string, state: AgentState, agoMin: number, title = `${name} title`, archived = false): AgentView => {
  const n = NODES.find((x) => x.hostname === hostname) as NodeView;
  return {
    id: `maren/${hostname}/${name}`, handle: "maren", node: n.node_id, hostname, agent: name,
    status: { agent: name, state, runtime: "claude-code", title }, updated_at: NOW - agoMin * MIN, machine_online: true,
    effective_state: state, archived,
  };
};

function state(over: Partial<State>): State {
  return { ...mod.initialState, phase: "ready", team: TEAM, nodes: NODES, me: { handle: "maren" } as State["me"], ...over };
}
const render = (s: State, el: ReactNode) => renderToStaticMarkup(<mod.StaticStore state={s}>{el}</mod.StaticStore>);

const LIVE = [
  agent("atlas", "seat-1", "working", 0.2, "Build the archive view"),
  agent("atlas", "seat-2", "blocked", 3, "Terraform lock held"),
  agent("atlas", "seat-3", "idle", 5, "Waiting for a lane"),
  agent("atlas", "seat-4", "offline", 2, "Lint fixes"),
  agent("maren-mbp", "ux", "waiting", 1, "Which rounding rule?"),
  agent("maren-mbp", "notes", "idle", 40, "Summarised notes"), // aged into the archive since the stream sent it
];

test("Mission Control default: working and needing a person only; per machine 'N idle · M offline in the archive'", () => {
  go("#/mission");
  const out = render(state({ agents: LIVE, archive: [{ node: "n2", idle: 2, offline: 26 }] }), <mod.MissionControl />);
  expect(out).toContain("Build the archive view");
  expect(out).toContain("Terraform lock held");
  expect(out).toContain("Which rounding rule?");
  expect(out).not.toContain("Waiting for a lane");
  expect(out).not.toContain("Lint fixes");
  expect(out).not.toContain("Summarised notes");
  // atlas: 1 idle + 1 offline from the stream, 2 + 26 from the daemon's archive counts.
  expect(out).toMatch(/data-testid="archive-link-atlas"[^>]*>.*3 idle · 27 offline.*in the archive/);
  expect(out).toMatch(/href="#\/mission\?tab=archive&amp;machine=atlas"/);
  expect(out).toMatch(/data-testid="archive-link-maren-mbp"[^>]*>.*1 idle/);
  expect(out).toContain("Needs you");
  expect(out).toContain("Stuck");
  expect(out).toContain("Waiting on you");
  expect(out).toMatch(/data-testid="archive-tab"[^>]*>Archive <span[^>]*>31<\/span>/);
  expect(out).not.toContain(">Idle<"); // no Idle / Offline filter on the live view
});

test("running seats remain separate visible agents under their host, including idle seats", () => {
  go("#/mission");
  const host = agent("atlas", "seats", "working", 0.1, "Seats · 2 queued");
  const seats = Array.from({ length: 3 }, (_, i) => {
    const a = agent("atlas", `seat-abc123-${i + 1}`, i === 0 ? "working" : "idle", 0.1, `Brief ${i + 1}`);
    return { ...a, status: { ...a.status, parent: "seats", launcher: "maren", model: "test-model", activity: `Step ${i + 1}` } };
  });
  const out = render(state({ agents: [host, ...seats] }), <mod.MissionControl />);
  expect(out).toContain("Seats · 2 queued");
  for (let i = 1; i <= 3; i++) {
    expect(out).toContain(`seat-abc123-${i}`);
    expect(out).toContain(`Brief ${i}`);
    expect(out).toContain(`Step ${i}`);
  }
  expect(out).toContain('data-testid="agent-group-seats"');
  expect(out).toContain("@maren");
  expect(out).toContain("test-model");
});

test("a machine with nothing working says so, keeps the archive link; one with nothing at all shows the setup hint", () => {
  go("#/mission");
  const quiet = render(state({ agents: [agent("atlas", "seat-9", "idle", 2)], archive: [] }), <mod.MissionControl />);
  expect(quiet).toContain("Nothing working on this machine right now.");
  expect(quiet).toContain("walkie hooks install claude"); // maren-mbp reports nothing at all
});

test("Archive tab: idle and ended agents of the chosen machine, from the stream and the loaded archive, newest first", () => {
  go("#/mission?tab=archive&machine=atlas");
  const archived = [agent("atlas", "seat-11", "offline", 180, "Audit invoice cents", true), agent("maren-mbp", "old", "offline", 300, "Old notes", true)];
  const out = render(state({ agents: LIVE, archivedAgents: archived, archive: [{ node: "n2", idle: 0, offline: 1 }] }), <mod.MissionControl />);
  expect(out).toContain('data-testid="archive-view"');
  expect(out).toContain("Waiting for a lane");
  expect(out).toContain("Lint fixes");
  expect(out).toContain("Audit invoice cents");
  expect(out).not.toContain("Old notes"); // another machine
  expect(out).not.toContain("Build the archive view"); // working: live, not archived
  expect(out.indexOf("Lint fixes")).toBeLessThan(out.indexOf("Audit invoice cents")); // newest first
  expect(out).toMatch(/1 idle · 2 offline/);
  expect(out).toContain('aria-selected="true" href="#/mission?tab=archive"');
});

test("archive entries: an archived agent that reported again leaves the archive; stream copies win", () => {
  const back = agent("atlas", "seat-11", "working", 0.1);
  const list = mod.archiveEntries([back, agent("atlas", "seat-3", "idle", 5)], [agent("atlas", "seat-11", "offline", 180, "x", true), agent("atlas", "seat-3", "idle", 90, "older", true)], NOW);
  expect(list.map((a) => a.agent)).toEqual(["seat-3"]);
  expect(list[0]?.status.title).toBe("seat-3 title");
});

test("discovered runtimes have headless labels, elapsed time, project and machine model load", () => {
  go("#/mission");
  const base = agent("atlas", "kimi-pid100", "working", 0.1);
  const found: AgentView[] = [
    { ...base, status: { agent: base.agent, runtime: "kimi", launch: "headless", state: "working", repo: "project", activity: "Working (seen from the process)", started_at: NOW - 300000 } },
    { ...base, agent: "claude-pid101", id: "claude-pid101", status: { agent: "claude-pid101", runtime: "claude-code", launch: "headless", state: "working" } },
    { ...base, agent: "grok-pid102", id: "grok-pid102", status: { agent: "grok-pid102", runtime: "other", runtime_name: "grok", launch: "headless", state: "working" } },
  ];
  const nodes = NODES.map((n) => n.hostname === "atlas" ? { ...n, stats: { at: NOW, mem: null, temp_c: null, model_servers: [{ name: "ollama", count: 1 }] } } : n);
  const out = render(state({ agents: found, nodes }), <mod.MissionControl />);
  expect(out).toContain("Kimi · headless");
  expect(out).toContain("Claude Code · headless");
  expect(out).toContain("Grok · headless");
  expect(out).toMatch(/session \d+m/); // elapsed session time (exact minutes depend on the shared-process clock)
  expect(out).toContain("project");
  expect(out).toContain("Models: ollama");
});

test("Hermes status is visible without an ask or control affordance", () => {
  go("#/mission");
  const base = agent("atlas", "hermes-example-billing", "working", 0.1, undefined);
  const hermes = { ...base, status: { agent: base.agent, runtime: "other" as const, runtime_name: "hermes", state: "working" as const } };
  const s = state({ agents: [hermes] });
  const card = render(s, <mod.MissionControl />);
  const drawer = render(s, <mod.AgentDrawer id={hermes.id} />);
  expect(card).toContain("Hermes");
  expect(card).toContain("View only");
  expect(drawer).toContain("Unavailable — view only");
  expect(drawer).not.toContain("Ask this agent");
  expect(drawer).not.toContain("walkie ask");
});
