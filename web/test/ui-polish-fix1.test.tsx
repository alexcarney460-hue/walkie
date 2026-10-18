import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { AccountView, AskView, CardView, PendingJoin, ProjectView, Recommendation } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { go, installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const inert: unknown = new Proxy(() => inert, { get: (_t, key) => key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : inert, apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let api: typeof import("../src/api/client.ts").api;
let needs: typeof import("../src/views/home/needs.tsx");
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let HomeTop: typeof import("../src/views/home/Home.tsx").HomeTop;
let Sidebar: typeof import("../src/components/Shell.tsx").Sidebar;
let initialState: State;
let projectsStore: typeof import("../src/state/projects.ts").projectsStore;
beforeAll(async () => {
  [{ api }, needs, { StaticStore }, { HomeTop }, { Sidebar }, { initialState }, { projectsStore }] = await Promise.all([
    import("../src/api/client.ts"), import("../src/views/home/needs.tsx"), import("../src/state/store.tsx"),
    import("../src/views/home/Home.tsx"), import("../src/components/Shell.tsx"), import("../src/state/reducer.ts"), import("../src/state/projects.ts"),
  ]);
});

const NOW = Date.now();
const meter = { mode: "count", done: 0, counted: 1, by_role: { backlog: 0, todo: 0, active: 0, review: 1, done: 0, cancelled: 0 } };
const project = { id: "project-1", channel: "paperboat", name: "Paperboat", prefix: "PAP", state: "active", meter, boards: [
  { id: "board-1", state: "active", columns: [{ id: "review", role: "review" }, { id: "active", role: "active" }] },
] } as ProjectView;
const card = (id: string, labels: string[] = []): CardView => ({
  id, key: `PAP-${id}`, ref: `PAP-${id}`, title: `Card ${id}`, channel: "paperboat", board: "board-1", column: "review",
  state: "open", labels, assignee: "@nira", reviewer: "@nira", updated_at: NOW, pos: id, blocked: false,
} as CardView);
const visible = card("visible");
const secretOld = card("secret");
const secretNew = card("secret", ["confidential"]);
const rec = { id: "rec-1", summary: "Approve a note", status: "pending", evidence: [], can_approve: true, can_dismiss: true } as Recommendation;
const pending = { node_id: "joining-node", hostname: "paperboat-two", login: "guest@paperboat.example", requested_at: NOW } as PendingJoin;
const account = { key: "account-1", provider: "claude", owners: ["nira"], machines: [
  { handle: "nira", hostname: "paperboat-one", usage: { state: "relogin" } },
  { handle: "guest", hostname: "paperboat-two", usage: { state: "relogin" } },
] } as AccountView;
const ask = (id: string, ts: number): AskView => ({ ask: { id, ts, author: { handle: "nira", node: "paperboat-one", agent: id },
  body: { text: `Question ${id}`, to: "@nira", expires_at: NOW + 60_000 } }, answers: [], state: "open", expires_at: NOW + 60_000 } as AskView);

function state(role: "owner" | "observer" = "owner"): State {
  return { ...initialState, phase: "ready", me: { handle: "nira", role, node: { id: "paperboat-one", hostname: "paperboat-one" } } as State["me"],
    team: { id: "fictional-team", name: "Paperboat", members: [{ handle: "nira", display_name: "Nira Vale", login: "nira@paperboat.example", role }], nodes: [], channels: [] } as State["team"],
    asks: [ask("older", NOW - 2000), ask("newer", NOW - 1000)], accounts: [account], agents: [], nodes: [] };
}

function Probe({ onValue }: { onValue: (value: needs.HomeNeeds) => void }) {
  onValue(needs.useHomeNeeds());
  return null;
}

function installApi() {
  const originals = { projects: api.projects, tasks: api.tasks, pending: api.pending, recommendations: api.recommendations };
  const calls = { projects: 0, tasks: 0, pending: 0, recommendations: 0 };
  api.projects = async () => { calls.projects++; return { projects: [project], stubs: [] }; };
  api.tasks = async (query) => {
    calls.tasks++;
    const tasks = query.assignee === "me" ? [secretNew] : query.role === "review" ? [visible] : [visible, secretOld];
    return { tasks, total: tasks.length, truncated: false, projects: [] };
  };
  api.pending = async () => { calls.pending++; return { requests: [pending] }; };
  api.recommendations = async () => { calls.recommendations++; return { recs: [rec], now: NOW, more_open: 0 }; };
  return { calls, restore: () => { api.projects = originals.projects; api.tasks = originals.tasks; api.pending = originals.pending; api.recommendations = originals.recommendations; } };
}

test("provider loads needs off Home, hides conflicting confidential copies, scopes joins and logins, and refreshes on Home", async () => {
  const { calls, restore } = installApi();
  let tree: ReactTestRenderer | undefined;
  let latest: needs.HomeNeeds | undefined;
  const view = (showHome = false) => <StaticStore state={state()}><needs.HomeNeedsProvider>
    <Probe onValue={(value) => { latest = value; }} />{showHome && <><Sidebar onSearch={() => {}} /><HomeTop /></>}
  </needs.HomeNeedsProvider></StaticStore>;
  projectsStore.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  go("#/projects");
  try {
    await act(async () => { tree = create(view()); });
    expect(calls.projects).toBeGreaterThan(0);
    expect(calls.pending).toBe(0);
    expect(calls.recommendations).toBe(1);
    expect(latest?.asks.map((item) => item.ask.id)).toEqual(["newer", "older"]);
    expect(latest?.cards.map((item) => item.id)).toEqual(["visible"]);
    expect(latest?.projectCards.map((item) => item.id)).toEqual(["visible"]);
    expect(latest?.pending).toHaveLength(0);
    expect(latest?.logins.map((item) => item.hostname)).toEqual(["paperboat-one"]);
    expect(latest?.count).toBe(5);
    await act(async () => { go("#/home"); });
    expect(calls.pending).toBe(1);
    expect(calls.recommendations).toBe(2);
    expect(calls.tasks).toBe(6);
    expect(latest?.pending).toHaveLength(1);
    expect(latest?.count).toBe(6);
    await act(async () => { tree?.update(view(true)); });
    expect(tree!.root.findAllByProps({ className: "home-need" })).toHaveLength(5);
    expect(JSON.stringify(tree!.toJSON())).toContain('"6"');
    expect(JSON.stringify(tree!.toJSON())).toContain('" pending"');
  } finally {
    await act(async () => { tree?.unmount(); });
    restore();
  }
});

test("pending joins refresh on focus and visibility at most once per 10 seconds, with immediate retry", async () => {
  const { calls, restore } = installApi();
  const oldNow = Date.now;
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  let clock = oldNow();
  const focus = new Set<() => void>();
  const visible = new Set<() => void>();
  go("#/home");
  Date.now = () => clock;
  (globalThis as { window: unknown }).window = { ...oldWindow,
    addEventListener: (type: string, listener: () => void) => { if (type === "focus") focus.add(listener); },
    removeEventListener: (type: string, listener: () => void) => { if (type === "focus") focus.delete(listener); },
  };
  (globalThis as { document: unknown }).document = {
    visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { if (type === "visibilitychange") visible.add(listener); },
    removeEventListener: (type: string, listener: () => void) => { if (type === "visibilitychange") visible.delete(listener); },
  };
  let latest: needs.HomeNeeds | undefined;
  let tree: ReactTestRenderer | undefined;
  projectsStore.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  try {
    await act(async () => { tree = create(<StaticStore state={state()}><needs.HomeNeedsProvider>
      <Probe onValue={(value) => { latest = value; }} />
    </needs.HomeNeedsProvider></StaticStore>); });
    expect(calls.pending).toBe(1);
    clock += 5_000;
    await act(async () => { for (const listener of [...focus]) listener(); });
    expect(calls.pending).toBe(1);
    clock += 6_000;
    await act(async () => { for (const listener of [...focus]) listener(); });
    expect(calls.pending).toBe(2);
    clock += 1_000;
    await act(async () => { for (const listener of [...visible]) listener(); });
    expect(calls.pending).toBe(2);
    await act(async () => { latest?.retryPending?.(); });
    expect(calls.pending).toBe(3);
    clock += 10_000;
    await act(async () => { for (const listener of [...visible]) listener(); });
    expect(calls.pending).toBe(4);
  } finally {
    await act(async () => { tree?.unmount(); });
    Date.now = oldNow;
    (globalThis as { window: unknown }).window = oldWindow;
    (globalThis as { document: unknown }).document = oldDocument;
    restore();
  }
});

test("observer does not fetch pending joins or show answerable asks", async () => {
  const { calls, restore } = installApi();
  let tree: ReactTestRenderer | undefined;
  let latest: needs.HomeNeeds | undefined;
  projectsStore.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  go("#/projects");
  try {
    await act(async () => { tree = create(<StaticStore state={state("observer")}><needs.HomeNeedsProvider><Probe onValue={(value) => { latest = value; }} /></needs.HomeNeedsProvider></StaticStore>); });
    expect(calls.pending).toBe(0);
    expect(latest?.pending).toHaveLength(0);
    expect(latest?.asks).toHaveLength(0);
    expect(latest?.cards).toHaveLength(1);
  } finally {
    await act(async () => { tree?.unmount(); });
    restore();
  }
});

test("needs are newest first within timestamped kinds", () => {
  const olderAgent = { id: "agent-old", handle: "nira", node: "paperboat-one", agent: "helper-old", effective_state: "blocked",
    updated_at: NOW - 2000, status: { title: "Old blocker" } } as State["agents"][number];
  const newerAgent = { ...olderAgent, id: "agent-new", agent: "helper-new", updated_at: NOW - 1000 };
  const olderCard = { ...visible, id: "old-card", updated_at: NOW - 2000 };
  const newerCard = { ...visible, id: "new-card", updated_at: NOW - 1000 };
  const olderJoin = { ...pending, node_id: "old-join", requested_at: NOW - 2000 };
  const newerJoin = { ...pending, node_id: "new-join", requested_at: NOW - 1000 };
  const result = needs.assembleHomeNeeds({ ...state(), agents: [olderAgent, newerAgent] }, [project],
    [olderCard, newerCard], [olderCard, newerCard], [rec, { ...rec, id: "rec-older" }], [olderJoin, newerJoin], NOW);
  expect(result.asks.map((item) => item.ask.id)).toEqual(["newer", "older"]);
  expect(result.agents.map((item) => item.id)).toEqual(["agent-new", "agent-old"]);
  expect(result.cards.map((item) => item.id)).toEqual(["new-card", "old-card"]);
  expect(result.pending.map((item) => item.node_id)).toEqual(["new-join", "old-join"]);
  expect(result.recommendations.map((item) => item.id)).toEqual(["rec-1", "rec-older"]);
});

test("recommendations refresh at 60 seconds only on Home and stop on unmount", async () => {
  const { calls, restore } = installApi();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  let cleared = false;
  const marker = 987654 as unknown as ReturnType<typeof setInterval>;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) { tick = callback as () => void; return marker; }
    return realSet(callback, delay, ...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    if (id === marker) { cleared = true; return; }
    realClear(id);
  }) as typeof clearInterval;
  let tree: ReactTestRenderer | undefined;
  projectsStore.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  go("#/home");
  try {
    await act(async () => { tree = create(<StaticStore state={state()}><needs.HomeNeedsProvider><Probe onValue={() => {}} /></needs.HomeNeedsProvider></StaticStore>); });
    expect(calls.recommendations).toBe(1);
    expect(tick).toBeDefined();
    await act(async () => { tick?.(); });
    expect(calls.recommendations).toBe(2);
    await act(async () => { tree?.unmount(); });
    tree = undefined;
    expect(cleared).toBe(true);
  } finally {
    await act(async () => { tree?.unmount(); });
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    restore();
  }
});

test("a failed project refresh removes old decisions and provides Retry", async () => {
  const { restore } = installApi();
  let latest: needs.HomeNeeds | undefined;
  let tree: ReactTestRenderer | undefined;
  projectsStore.set({ status: "ready", error: null, projects: [project], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  api.projects = async () => { throw new Error("fictional project-list failure"); };
  go("#/projects");
  try {
    await act(async () => { tree = create(<StaticStore state={state()}><needs.HomeNeedsProvider><Probe onValue={(value) => { latest = value; }} /></needs.HomeNeedsProvider></StaticStore>); });
    expect(latest?.cards).toHaveLength(0);
    expect(latest?.cardsError).toBe(true);
    expect(latest?.retryCards).toBeFunction();
    api.projects = async () => ({ projects: [project], stubs: [] });
    await act(async () => { latest?.retryCards?.(); });
    expect(latest?.cards.map((item) => item.id)).toEqual(["visible"]);
    expect(latest?.cardsError).toBe(false);
  } finally {
    await act(async () => { tree?.unmount(); });
    restore();
  }
});

test("Home isolates a malformed ask row and retains the next row", async () => {
  const malformed = { ask: { id: "bad", author: null } } as unknown as AskView;
  const value: needs.HomeNeeds = { asks: [malformed, ask("good", NOW - 1000)], agents: [], cards: [], projectCards: [], recommendations: [], pending: [], logins: [], count: 2 };
  let tree: ReactTestRenderer | undefined;
  go("#/home");
  const errorLog = console.error;
  try {
    console.error = () => {};
    await act(async () => { tree = create(<StaticStore state={state()}><needs.HomeNeedsContext.Provider value={value}><HomeTop /></needs.HomeNeedsContext.Provider></StaticStore>); });
    const output = JSON.stringify(tree!.toJSON());
    expect(output).toContain("This item could not be shown");
    expect(output).toContain("Question good");
  } finally { console.error = errorLog; await act(async () => { tree?.unmount(); }); }
});

test("provider and Settings badge retain other needs for malformed account data", async () => {
  const { restore } = installApi();
  let latest: needs.HomeNeeds | undefined;
  let tree: ReactTestRenderer | undefined;
  const broken = { ...state(), accounts: [{ key: "broken", machines: null }] as unknown as AccountView[] };
  projectsStore.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  go("#/projects");
  try {
    await act(async () => { tree = create(<StaticStore state={broken}><needs.HomeNeedsProvider><Probe onValue={(value) => { latest = value; }} /><Sidebar onSearch={() => {}} /></needs.HomeNeedsProvider></StaticStore>); });
    expect(latest?.count).toBe(4);
    expect(latest?.cards).toHaveLength(1);
    expect(latest?.asks).toHaveLength(2);
  } finally {
    await act(async () => { tree?.unmount(); });
    restore();
  }
});
