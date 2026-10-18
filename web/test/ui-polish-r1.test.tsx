import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import type { AccountView, AgentView, AskView, CardView, PendingJoin, ProjectView, Recommendation } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { planView, seedPlan } from "../mock/plan.ts";
import { planTone } from "../src/lib/plan.ts";
import { go, installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_t, key) => key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : inert, apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let route: typeof import("../src/lib/route.ts");
let shell: typeof import("../src/components/Shell.tsx");
let needsModule: typeof import("../src/views/home/needs.tsx");
let settingsModel: typeof import("../src/views/settings/model.ts");
let HomeTop: typeof import("../src/views/home/Home.tsx").HomeTop;
let MissionControl: typeof import("../src/views/mission/MissionControl.tsx").MissionControl;
let Settings: typeof import("../src/views/settings/Settings.tsx").Settings;
let LocalModelsPage: typeof import("../src/views/settings/LocalModelsPage.tsx").LocalModelsPage;
let Accounts: typeof import("../src/views/Accounts.tsx").Accounts;
let App: typeof import("../src/App.tsx").App;
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let initialState: State;
let projectsStore: typeof import("../src/state/projects.ts").projectsStore;

beforeAll(async () => {
  [route, shell, needsModule, settingsModel, { HomeTop }, { MissionControl }, { Settings }, { LocalModelsPage }, { Accounts }, { App }, { StaticStore }, { initialState }, { projectsStore }] = await Promise.all([
    import("../src/lib/route.ts"), import("../src/components/Shell.tsx"), import("../src/views/home/needs.tsx"),
    import("../src/views/settings/model.ts"), import("../src/views/home/Home.tsx"), import("../src/views/mission/MissionControl.tsx"), import("../src/views/settings/Settings.tsx"),
    import("../src/views/settings/LocalModelsPage.tsx"), import("../src/views/Accounts.tsx"),
    import("../src/App.tsx"), import("../src/state/store.tsx"), import("../src/state/reducer.ts"), import("../src/state/projects.ts"),
  ]);
});
beforeEach(() => {
  projectsStore.set({ status: "ready", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  go("#/home");
});

const NOW = Date.now();
const node = { node_id: "fictional-node", handle: "nira", hostname: "paperboat-one", ip: "100.64.0.10", online: true,
  last_seen: NOW, rtt_ms: null, self: true, sync: { behind: 0, last_sync: NOW } };
function state(over: Partial<State> = {}): State {
  return { ...initialState, phase: "ready", me: { handle: "nira", role: "owner", node: { id: node.node_id, hostname: node.hostname }, plan: null } as State["me"],
    team: { id: "fictional-team", name: "Paperboat", members: [{ handle: "nira", display_name: "Nira Vale", login: "nira@paperboat.example", role: "owner" }],
      nodes: [node], channels: [], authority: node.node_id, plan: null } as unknown as State["team"], nodes: [node], ...over };
}
function render(s: State, children: ReactNode, needs?: import("../src/views/home/needs.tsx").HomeNeeds): string {
  return renderToStaticMarkup(<StaticStore state={s}>
    {needs ? <needsModule.HomeNeedsContext.Provider value={needs}>{children}</needsModule.HomeNeedsContext.Provider> : children}
  </StaticStore>);
}
function attention(): import("../src/views/home/needs.tsx").HomeNeeds {
  const asks = [3, 2, 1].map((n) => ({ ask: { id: `ask-${n}`, ts: NOW - n * 1000,
    author: { handle: "nira", node: node.node_id, agent: `asker-${n}` }, body: { text: `Question ${n}`, to: "@nira", expires_at: NOW + 60_000 } },
    answers: [], state: "open", expires_at: NOW + 60_000 })) as AskView[];
  const agents = [2, 1].map((n) => ({ id: `agent-${n}`, handle: "nira", node: node.node_id, hostname: node.hostname, agent: `stuck-${n}`,
    effective_state: "blocked", status: { title: `Block ${n}` }, updated_at: NOW - n * 1000 })) as AgentView[];
  const cards = [{ id: "card-1", key: "PAP-1", title: "Choose the color", channel: "paperboat", column: "todo", updated_at: NOW }] as CardView[];
  const recommendations = [{ id: "rec-1", summary: "Review a suggestion", status: "pending" }] as Recommendation[];
  const pending = [{ node_id: "join-1", hostname: "paperboat-two", login: "guest@paperboat.example", requested_at: NOW }] as PendingJoin[];
  const logins = [{ account: { key: "login-1", provider: "codex" } as AccountView, hostname: node.hostname }];
  return { asks, agents, cards, projectCards: [], recommendations, pending, logins, count: 9 };
}

test("route parsing keeps aliases and unknown routes useful", () => {
  for (const hash of ["", "#/", "#/home", "#/unknown"]) expect(route.parseHash(hash).view).toBe("home");
  expect(route.parseHash("#/mission").view).toBe("agents");
  expect(route.parseHash("#/agents").view).toBe("agents");
  expect(route.parseHash("#/settings").view).toBe("settings");
  expect(route.parseHash("#/settings?tab=models")).toEqual({ view: "settings", tab: "models" });
  expect(route.parseHash("#/team?tab=models")).toEqual({ view: "settings", tab: "models" });
  expect(route.hrefFor({ view: "settings", tab: "models" })).toBe("#/settings?tab=models");
});

test("rail and phone navigation have five ordered destinations and highlight secondary routes", () => {
  const expected = ["home", "projects", "orchestrator", "board", "settings"];
  expect(shell.NAV.map((item) => item.view)).toEqual(expected);
  for (const view of ["home", "asks", "agents", "mission", "machine"]) expect(shell.primaryView(view)).toBe("home");
  for (const view of ["settings", "team", "accounts", "seats", "integrations", "artifacts", "updates", "simple"]) {
    expect(shell.primaryView(view as import("../src/lib/route.ts").View)).toBe("settings");
  }
  const s = state();
  const rail = render(s, <shell.Sidebar onSearch={() => {}} />);
  const tabs = render(s, <shell.TabBar />);
  for (const html of [rail, tabs]) {
    const positions = expected.map((view) => html.indexOf(`href="#/${view}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  }
  expect(rail).not.toContain("rail-hint");
  expect(rail).toContain('class="rail-machine has-stats');
  expect(rail).toContain('href="#/machines/fictional-node"');
  expect(rail).toContain("mem n/a");
  expect(rail).toContain("temp n/a");
  expect(rail).not.toContain('nira · paperboat-one');
  go("#/asks");
  expect(render(s, <shell.TabBar />)).toContain('href="#/home" class="tab is-active"');
  go("#/agents");
  expect(render(s, <shell.Sidebar onSearch={() => {}} />)).toContain('href="#/home" class="rail-link is-active"');
  go("#/mission");
  expect(render(s, <shell.Sidebar onSearch={() => {}} />)).toContain('href="#/home" class="rail-link is-active"');
  go("#/machines/fictional-node");
  expect(render(s, <shell.Sidebar onSearch={() => {}} />)).toContain('href="#/home" class="rail-link is-active"');
});

test("Home orders six needs kinds, caps at five, and its badge uses the full list count", async () => {
  const needs = attention();
  const html = render(state(), <><shell.Sidebar onSearch={() => {}} /><HomeTop /></>, needs);
  const positions = ["Question 3", "Question 2", "Question 1", "stuck-2", "stuck-1"].map((label) => html.indexOf(label));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(html.match(/class="home-need"/g)).toHaveLength(5);
  expect(html).not.toContain("PAP-1");
  expect(html).not.toContain("Codex login on paperboat-one");
  expect(html).toContain("Show all (9)");
  expect(html).toContain('>9<span class="sr-only"> pending</span>');
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { tree = create(<StaticStore state={state()}><needsModule.HomeNeedsContext.Provider value={needs}><HomeTop /></needsModule.HomeNeedsContext.Provider></StaticStore>); });
    const showAll = tree!.root.findAllByType("button").find((button) => button.children.includes("Show all (9)"));
    expect(showAll).toBeDefined();
    await act(async () => { showAll!.props.onClick(); });
    const expanded = JSON.stringify(tree!.toJSON());
    const allPositions = ["Question 3", "stuck-2", "PAP-1", "Review a suggestion", "paperboat-two", '"Codex"," login"'].map((label) => expanded.indexOf(label));
    expect(allPositions.every((position) => position >= 0)).toBe(true);
    expect(allPositions).toEqual([...allPositions].sort((a, b) => a - b));
    expect(tree!.root.findAllByProps({ className: "home-need" })).toHaveLength(9);
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("attention count is derived from the visible lists and an ask suppresses its agent duplicate", () => {
  const fixture = attention();
  const duplicate = { ...fixture.asks[0]!, ask: { ...fixture.asks[0]!.ask,
    author: { handle: "nira", node: node.node_id, agent: "stuck-2" } } } as AskView;
  const s = state({ asks: [duplicate, ...fixture.asks.slice(1)], agents: fixture.agents });
  const result = needsModule.assembleHomeNeeds(s, [], [], [], fixture.recommendations, fixture.pending, NOW);
  expect(result.asks).toHaveLength(3);
  expect(result.agents.map((agent) => agent.agent)).toEqual(["stuck-1"]);
  expect(result.count).toBe(result.asks.length + result.agents.length + result.cards.length
    + result.recommendations.length + result.pending.length + result.logins.length);
  expect(result.count).toBe(6);
});

test("Home empty state is calm and has no attention badge", () => {
  const empty: import("../src/views/home/needs.tsx").HomeNeeds = { asks: [], agents: [], cards: [], projectCards: [], recommendations: [], pending: [], logins: [], count: 0 };
  const html = render(state(), <><shell.Sidebar onSearch={() => {}} /><HomeTop /></>, empty);
  expect(html).toContain("Nothing needs you right now.");
  expect(html).not.toContain('>0<span class="sr-only"> pending</span>');
});

test("Home's live lede counts a working agent whose person is missing from the team", () => {
  const worker = { id: "guest/other/cc-1", handle: "guest", node: "other", agent: "cc-1", hostname: "other",
    effective_state: "working", updated_at: NOW, status: { title: "Review the page" } } as AgentView;
  const empty = { ...attention(), asks: [], agents: [], cards: [], recommendations: [], pending: [], logins: [], count: 0 };
  const html = render(state({ agents: [worker] }), <MissionControl home />, empty);
  expect(html).toContain("1 agent working");
  expect(html).not.toContain("Review the page");
});

test("Home live lede counts a working helper and groups it under its parent", () => {
  const parent = { id: "parent", handle: "nira", node: node.node_id, agent: "writer", hostname: "paperboat-one",
    effective_state: "working", updated_at: NOW, status: { title: "Drafting", parent: null } } as AgentView;
  const helper = { ...parent, id: "helper", agent: "helper", status: { title: "Checking", parent: "writer" } };
  const empty = { ...attention(), asks: [], agents: [], cards: [], recommendations: [], pending: [], logins: [], count: 0 };
  const html = render(state({ agents: [parent, helper] }), <MissionControl home />, empty);
  expect(html).toContain("2 agents working");
  expect(html).toContain("Drafting");
  expect(html).toMatch(/data-testid="agent-group-writer"[\s\S]*data-testid="subagent-helper"[\s\S]*Checking/);
});

test("Home names Claude logins and omits the machine list with no machines", () => {
  const login = { account: { key: "login-claude", provider: "claude" } as AccountView, hostname: "paperboat-one" };
  const needs = { ...attention(), asks: [], agents: [], cards: [], recommendations: [], pending: [], logins: [login], count: 1 };
  const html = render(state({ nodes: [] }), <><shell.Sidebar onSearch={() => {}} /><HomeTop /></>, needs);
  expect(html).toContain("Claude login");
  expect(html).not.toContain("rail-machines");
});

test("plan warnings appear at the trial edge and at either limit, but a healthy trial has no badge", () => {
  const healthy = planView(seedPlan("trial", NOW), { people: 2, machines: 2 }, NOW);
  const near = { ...healthy, trial: { ...healthy.trial!, days_left: 3 } };
  const four = { ...healthy, trial: { ...healthy.trial!, days_left: 4 } };
  const freeWithLicense = { ...planView(seedPlan("free", NOW), { people: 1, machines: 1 }, NOW),
    license: planView(seedPlan("grace", NOW), { people: 1, machines: 1 }, NOW).license };
  const seatsFull = { ...healthy, seats: { used: 2, limit: 2 } };
  const machinesFull = { ...healthy, machines: { used: 2, limit: 2 } };
  expect(planTone(near)).toBe("amber");
  expect(planTone(four)).toBe("neutral");
  expect(planTone(freeWithLicense)).toBe("amber");
  expect(planTone(seatsFull)).toBe("amber");
  expect(planTone(machinesFull)).toBe("amber");
  const badge = (plan: typeof healthy) => render(state({ team: { ...state().team!, plan } }), <shell.PlanBadge />);
  expect(badge(healthy)).not.toContain("plan-badge");
  for (const plan of [near, freeWithLicense, seatsFull, machinesFull]) expect(badge(plan)).toContain("plan-badge");
});

test("Home project rows show the existing meter and nonzero work, review and blocked counts", () => {
  const project = { id: "project-1", channel: "paperboat", state: "active", name: "Paperboat launch", prefix: "PAP", folder: "",
    status_report: "off", boards: [{ id: "board-1", state: "active", columns: [
      { id: "active", role: "active" }, { id: "review", role: "review" }, { id: "done", role: "done" } ] }],
    meter: { mode: "count", done: 1, counted: 3, by_role: { backlog: 0, todo: 0, active: 1, review: 1, done: 1, cancelled: 0 } } } as ProjectView;
  projectsStore.set({ status: "ready", error: null, projects: [project], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const needs = { ...attention(), projectCardsComplete: true, projectCards: [
    { id: "work-1", channel: "paperboat", board: "board-1", column: "active", state: "open", labels: [], blocked: true },
    { id: "review-1", channel: "paperboat", board: "board-1", column: "review", state: "open", labels: [], blocked: false },
  ] as CardView[] };
  const html = render(state(), <HomeTop />, needs);
  expect(html).toContain("Paperboat launch");
  expect(html).toContain("1 in progress · 1 waiting for review · 1 blocked");
  expect(html).toContain("1</strong><span class=\"muted\">/3 done");
});

test("Settings has nine whole-row links and warning tones for joining, offline and login problems", () => {
  const account = { key: "login-1", owners: ["nira"], machines: [{ handle: "nira", hostname: node.hostname, usage: { state: "relogin" }, agents: [] }] } as AccountView;
  const s = state({ nodes: [{ ...node, online: false }], accounts: [account] });
  const warnings = settingsModel.settingsWarnings(s, NOW, 1);
  expect(warnings).toEqual({ team: true, agents: true, accounts: true });
  const needs = { ...attention(), asks: [], agents: [], cards: [], recommendations: [], logins: [], count: 1 };
  const html = render(s, <Settings />, needs);
  for (const label of ["Team and billing", "Machines and agents", "Accounts", "Seats", "Integrations", "Files", "Status reports", "Local models", "Plain-language board"]) {
    expect(html).toContain(label);
  }
  expect(html.match(/class="settings-row(?: is-warning)?"/g)).toHaveLength(9);
  expect(html.match(/class="settings-row is-warning"/g)).toHaveLength(3);
  expect(html).toContain('href="#/settings?tab=models"');
  go("#/settings?tab=models");
  expect(render(s, <Settings />, needs)).toContain("Loading Local models");
  expect(render(s, <LocalModelsPage />, needs)).toContain("Back to Settings");
  expect(render(s, <LocalModelsPage />, needs)).toContain('id="model-details"');
  expect(html).toContain("1 machine waiting to join");
});

test("company pool notice appears on Accounts only", () => {
  const s = state({ accountsPool: { policy: "company", at: NOW, by: "nira" } });
  go("#/home");
  expect(render(s, <App />)).not.toContain("The company account pool is on");
  go("#/accounts");
  expect(render(s, <App />)).toContain("Loading Accounts");
  expect(render(s, <Accounts />)).toContain("The company account pool is on");
});
