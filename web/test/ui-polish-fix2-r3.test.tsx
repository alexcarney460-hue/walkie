import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { Suspense, useState } from "react";
import type { AccountView, AskView, CardView, Event, ProjectView, Recommendation } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { go, installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const inert: unknown = new Proxy(() => inert, { get: (_target, key) => key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : inert, apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let api: typeof import("../src/api/client.ts").api;
let ApiError: typeof import("../src/api/client.ts").ApiError;
let friendlyError: typeof import("../src/api/client.ts").friendlyError;
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let initialState: State;
let projectProgressSummary: typeof import("../src/lib/project-summary.ts").projectProgressSummary;
let accounts: typeof import("../src/views/Accounts.tsx");
let AccountTile: typeof import("../src/components/Accounts.tsx").AccountTile;
let Team: typeof import("../src/views/Team.tsx").Team;
let Orchestrator: typeof import("../src/views/orchestrator/Orchestrator.tsx").Orchestrator;
let RecommendationItems: typeof import("../src/views/orchestrator/Recommendations.tsx").RecommendationItems;
let RouteLoading: typeof import("../src/App.tsx").RouteLoading;
let ViewOutlet: typeof import("../src/App.tsx").ViewOutlet;
let Board: typeof import("../src/views/board/Board.tsx").Board;
let Asks: typeof import("../src/views/Asks.tsx").Asks;
let ProjectList: typeof import("../src/views/projects/ProjectList.tsx").ProjectList;
let ProjectBoard: typeof import("../src/views/projects/ProjectBoard.tsx").ProjectBoard;
let HomeNeedsContext: typeof import("../src/views/home/needs.tsx").HomeNeedsContext;
let HomeNeedsProvider: typeof import("../src/views/home/needs.tsx").HomeNeedsProvider;
let assembleHomeNeeds: typeof import("../src/views/home/needs.tsx").assembleHomeNeeds;
let HomeTop: typeof import("../src/views/home/Home.tsx").HomeTop;
let Settings: typeof import("../src/views/settings/Settings.tsx").Settings;
let ShortcutsDialog: typeof import("../src/components/ShortcutsDialog.tsx").ShortcutsDialog;
let useGlobalHotkeys: typeof import("../src/lib/hotkeys.ts").useGlobalHotkeys;
let projectsStore: typeof import("../src/state/projects.ts").projectsStore;
let CommandPalette: typeof import("../src/components/CommandPalette.tsx").CommandPalette;
let ProjectSettings: typeof import("../src/views/projects/ProjectSettings.tsx").ProjectSettings;
let ErrorBoundary: typeof import("../src/components/ErrorBoundary.tsx").ErrorBoundary;
let retryableLazy: typeof import("../src/lib/retryable-lazy.tsx").retryableLazy;

beforeAll(async () => {
  const [client, store, reducer, summary, accountView, accountTile, team, talkie, recs, app, board, asks, list, projectBoard, needs, projects, palette, home, settings, shortcuts, hotkeys, projectSettings, boundary, retry] = await Promise.all([
    import("../src/api/client.ts"), import("../src/state/store.tsx"), import("../src/state/reducer.ts"),
    import("../src/lib/project-summary.ts"), import("../src/views/Accounts.tsx"), import("../src/components/Accounts.tsx"),
    import("../src/views/Team.tsx"), import("../src/views/orchestrator/Orchestrator.tsx"),
    import("../src/views/orchestrator/Recommendations.tsx"), import("../src/App.tsx"),
    import("../src/views/board/Board.tsx"), import("../src/views/Asks.tsx"), import("../src/views/projects/ProjectList.tsx"), import("../src/views/projects/ProjectBoard.tsx"),
    import("../src/views/home/needs.tsx"), import("../src/state/projects.ts"), import("../src/components/CommandPalette.tsx"),
    import("../src/views/home/Home.tsx"), import("../src/views/settings/Settings.tsx"),
    import("../src/components/ShortcutsDialog.tsx"), import("../src/lib/hotkeys.ts"),
    import("../src/views/projects/ProjectSettings.tsx"),
    import("../src/components/ErrorBoundary.tsx"), import("../src/lib/retryable-lazy.tsx"),
  ]);
  api = client.api; ApiError = client.ApiError; friendlyError = client.friendlyError;
  StaticStore = store.StaticStore; initialState = reducer.initialState; projectProgressSummary = summary.projectProgressSummary;
  accounts = accountView; AccountTile = accountTile.AccountTile; Team = team.Team; Orchestrator = talkie.Orchestrator;
  RecommendationItems = recs.RecommendationItems; RouteLoading = app.RouteLoading; ViewOutlet = app.ViewOutlet;
  Board = board.Board; Asks = asks.Asks; ProjectList = list.ProjectList; ProjectBoard = projectBoard.ProjectBoard; HomeNeedsContext = needs.HomeNeedsContext;
  HomeNeedsProvider = needs.HomeNeedsProvider;
  assembleHomeNeeds = needs.assembleHomeNeeds; HomeTop = home.HomeTop; Settings = settings.Settings;
  ShortcutsDialog = shortcuts.ShortcutsDialog; useGlobalHotkeys = hotkeys.useGlobalHotkeys;
  projectsStore = projects.projectsStore; CommandPalette = palette.CommandPalette;
  ProjectSettings = projectSettings.ProjectSettings;
  ErrorBoundary = boundary.ErrorBoundary; retryableLazy = retry.retryableLazy;
});

const NOW = Date.UTC(2026, 9, 17, 12);
const meter = { mode: "count", done: 0, counted: 2, by_role: { backlog: 0, todo: 0, active: 1, review: 1, done: 0, cancelled: 0 } };
const project = { id: "project-1", channel: "paperboat", name: "Paperboat", folder: "", prefix: "PAP", state: "active", meter, boards: [
  { id: "active-board", state: "active", columns: [{ id: "doing", role: "active" }, { id: "review", role: "review" }] },
  { id: "old-board", state: "archived", columns: [{ id: "old-doing", role: "active" }] },
] } as ProjectView;
const card = (id: string, board: string, column: string, labels: string[] = [], blocked = false) =>
  ({ id, key: `PAP-${id}`, channel: "paperboat", board, column, state: "open", labels, blocked }) as CardView;

function ownerState(extra: Partial<State> = {}): State {
  return { ...initialState, phase: "ready", me: { handle: "nira", role: "owner", node: { id: "machine-1", hostname: "paperboat-one" } } as State["me"],
    team: { id: "team-1", name: "Paperboat", members: [{ handle: "nira", display_name: "Nira Vale", login: "nira@paperboat.example", role: "owner" }], channels: [] } as State["team"],
    agents: [], nodes: [], accounts: [], asks: [], ...extra };
}

function visibleText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(visibleText).join(" ");
  if (node && typeof node === "object" && "children" in node) return visibleText((node as { children: unknown }).children);
  return "";
}

test("Home and Projects share visible project counts and reject capped sources", () => {
  const cards = [card("1", "active-board", "doing"), card("2", "active-board", "review"),
    card("3", "active-board", "doing", [" confidential "]), card("4", "old-board", "old-doing", [], true)];
  expect(projectProgressSummary(project, cards, true)).toBe("1 in progress · 1 waiting for review");
  expect(projectProgressSummary(project, cards, false)).toBe("Counts unavailable");
  projectsStore.set({ status: "ready", error: null, projects: [project], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  go("#/projects");
  const needs = { asks: [], agents: [], cards: [], projectCards: cards, projectCardsComplete: true,
    recommendations: [], pending: [], logins: [], count: 0 };
  const html = renderToStaticMarkup(<StaticStore state={ownerState()}><HomeNeedsContext.Provider value={needs}>
    <ProjectList />
  </HomeNeedsContext.Provider></StaticStore>);
  expect(html).toContain("1 in progress · 1 waiting for review");
  expect(html).not.toContain("2 in progress");
});

test("Accounts use remembered exhausted clock for pill, summary and ordering", () => {
  const stale = { at: NOW - 30 * 60_000, state: "ok", source: "api", reason: null, windows: [] };
  const exhausted = { key: "limited", provider: "codex", label: "ni***@pa***.example", owners: ["nira"],
    machines: [], usage: stale, clock: [{ kind: "session", scope: null, window_s: 18_000, resets_at: NOW + 60_000,
      observed_at: NOW - 20 * 60_000, exhausted: true, source: "api" }], claimed_by: [], last_seen: NOW } as AccountView;
  const healthy = { ...exhausted, key: "healthy", usage: { ...stale, at: NOW, windows: [{ kind: "session", left_pct: 80 }] }, clock: [] } as AccountView;
  expect(accounts.accountSummary([healthy, exhausted], NOW).exhausted).toBe(1);
  expect(accounts.orderedAccounts([healthy, exhausted], NOW)[0]?.key).toBe("limited");
  const html = renderToStaticMarkup(<AccountTile account={exhausted} now={NOW} />);
  expect(html).toContain("acct-state-exhausted");
  expect(html).toContain("acct-meter is-compact");
});

test("Team sheet keeps input focus through a store update", async () => {
  go("#/team");
  const oldDocument = globalThis.document;
  const oldHTMLElement = globalThis.HTMLElement;
  let active: FakeElement | null = null;
  class FakeElement { focus() { active = this; } }
  (globalThis as { HTMLElement: unknown }).HTMLElement = FakeElement;
  (globalThis as { document: unknown }).document = { get activeElement() { return active; }, getElementById: () => null };
  let tree: ReactTestRenderer | undefined;
  try {
    const s = ownerState();
    await act(async () => { tree = create(<StaticStore state={s}><Team /></StaticStore>, {
      createNodeMock: () => new FakeElement(),
    }); });
    const open = tree!.root.findAllByType("button").find((button) => button.children.includes("Add a teammate"));
    await act(async () => { open!.props.onClick(); });
    expect(tree!.root.findAllByProps({ id: "inv-login" })).toHaveLength(1);
    const input = new FakeElement();
    input.focus();
    await act(async () => { tree!.update(<StaticStore state={{ ...s, nodes: [{ node_id: "machine-2", handle: "nira", hostname: "paperboat-two", online: true }] as State["nodes"] }}><Team /></StaticStore>); });
    expect(active).toBe(input);
  } finally {
    await act(async () => { tree?.unmount(); });
    (globalThis as { document: unknown }).document = oldDocument;
    if (oldHTMLElement) (globalThis as { HTMLElement: unknown }).HTMLElement = oldHTMLElement;
    else delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  }
});

test("Talkie surfaces failed diagnostics", async () => {
  go("#/orchestrator");
  const originals = { orchestrator: api.orchestrator, orchestratorMessages: api.orchestratorMessages,
    channelHealth: api.channelHealth, recommendations: api.recommendations };
  api.orchestrator = async () => ({ local: { running: false, state: "failed", auto: true, last_error: "Fictional login expired" } }) as Awaited<ReturnType<typeof api.orchestrator>>;
  api.orchestratorMessages = async () => ({ messages: [] });
  api.channelHealth = async () => ({ quota_damaged: false, notice: null }) as Awaited<ReturnType<typeof api.channelHealth>>;
  api.recommendations = async () => ({ recs: [], more_open: 0, now: NOW });
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(<StaticStore state={ownerState()}><Orchestrator /></StaticStore>); });
    expect(visibleText(tree!.toJSON())).toContain("Talkie keeps failing: Fictional login expired");
    expect(visibleText(tree!.toJSON())).not.toMatch(/walkie (?:ask|post|projects|talkie|room)/);
  } finally {
    await act(async () => { tree?.unmount(); });
    Object.assign(api, originals);
  }
});

test("Talkie shows Full access in its visible header", async () => {
  go("#/orchestrator");
  const originals = { orchestrator: api.orchestrator, orchestratorMessages: api.orchestratorMessages,
    channelHealth: api.channelHealth, recommendations: api.recommendations };
  api.orchestrator = async () => ({ local: { running: true, state: "idle", auto: true, access: "full" } }) as Awaited<ReturnType<typeof api.orchestrator>>;
  api.orchestratorMessages = async () => ({ messages: [] });
  api.channelHealth = async () => ({ quota_damaged: false, notice: null }) as Awaited<ReturnType<typeof api.channelHealth>>;
  api.recommendations = async () => ({ recs: [], more_open: 0, now: NOW });
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(<StaticStore state={ownerState()}><Orchestrator /></StaticStore>); });
    expect(visibleText(tree!.toJSON())).toContain("Full access");
  } finally {
    await act(async () => { tree?.unmount(); });
    Object.assign(api, originals);
  }
});

test("Talkie page renders Resume when stopped by you", async () => {
  go("#/orchestrator");
  const originals = { orchestrator: api.orchestrator, orchestratorMessages: api.orchestratorMessages,
    channelHealth: api.channelHealth, recommendations: api.recommendations };
  api.orchestrator = async () => ({ local: { running: false, state: "stopped", auto: false, stopped_by_hand: true } }) as Awaited<ReturnType<typeof api.orchestrator>>;
  api.orchestratorMessages = async () => ({ messages: [] });
  api.channelHealth = async () => ({ quota_damaged: false, notice: null }) as Awaited<ReturnType<typeof api.channelHealth>>;
  api.recommendations = async () => ({ recs: [], more_open: 0, now: NOW });
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(<StaticStore state={ownerState()}><Orchestrator /></StaticStore>); });
    expect(tree!.root.findAllByType("button").some((button) => button.children.includes("Resume"))).toBe(true);
    expect(tree!.root.findAllByType("button").some((button) => button.children.includes("Start Talkie"))).toBe(false);
    expect(visibleText(tree!.toJSON())).toContain("Resume Talkie above");
  } finally {
    await act(async () => { tree?.unmount(); });
    Object.assign(api, originals);
  }
});

test("suggestion shows the exact outgoing text before approval", () => {
  const outgoing = "Please review the fictional pricing page before launch.";
  const rec = { id: "rec-1", summary: "Ask for review", reason: "A person should approve it", outgoing,
    project_name: "Paperboat", status: "pending", evidence: [], can_approve: true, can_dismiss: true } as Recommendation;
  const html = renderToStaticMarkup(<RecommendationItems recs={[rec]} onAnswer={() => {}} onRefresh={() => {}} />);
  expect(html).toContain("Approving sends this in your name");
  expect(html).toContain(outgoing);
  expect(html).toContain("is-clamped");
  expect(html).toContain("Show all");
});

test("lazy routes have a section skeleton and resolve after load", async () => {
  go("#/settings");
  let tree: ReactTestRenderer | undefined;
  const oldSeats = api.seats, oldIntegrations = api.integrations;
  api.seats = async () => ({ seats: [], local: { allow: false } }) as Awaited<ReturnType<typeof api.seats>>;
  api.integrations = async () => ({ integrations: [] });
  try {
    act(() => { tree = create(<StaticStore state={ownerState()}><ViewOutlet route={{ view: "settings" }} /></StaticStore>); });
    expect(renderToStaticMarkup(<RouteLoading name="Settings" />)).toContain('aria-label="Loading Settings"');
    expect(tree!.root.findAllByProps({ "aria-label": "Loading Settings" })).toHaveLength(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(visibleText(tree!.toJSON())).toContain("Settings");
    expect(visibleText(tree!.toJSON())).toContain("Team and billing");
    expect(tree!.root.findAllByType("a").some((link) => link.props.href === "#/updates")).toBe(true);
  } finally {
    await act(async () => { tree?.unmount(); });
    api.seats = oldSeats; api.integrations = oldIntegrations;
  }
});

test("Home and Settings keep good accounts and other needs when one account is malformed", () => {
  const good = { key: "nira:good", provider: "codex", owners: ["nira"], machines: [{
    handle: "nira", hostname: "paperboat-one", usage: { state: "relogin" }, agents: [],
  }] } as unknown as AccountView;
  const bad = { ...good, key: "nira:bad", owners: undefined, machines: null } as unknown as AccountView;
  const state = ownerState({ accounts: [bad, good] });
  const rec = { id: "rec-2", summary: "Approve fictional copy", status: "pending" } as Recommendation;
  const needs = assembleHomeNeeds(state, [project], [], [], [rec], [], NOW);
  expect(needs.logins).toHaveLength(1);
  expect(needs.recommendations).toHaveLength(1);
  projectsStore.set({ status: "ready", error: null, projects: [project], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  go("#/home");
  const homeHtml = renderToStaticMarkup(<StaticStore state={state}><HomeNeedsContext.Provider value={needs}><HomeTop /></HomeNeedsContext.Provider></StaticStore>);
  expect(homeHtml).toContain("Approve fictional copy");
  expect(homeHtml).toContain("On paperboat-one · needs signing in again");
  go("#/settings");
  const settingsHtml = renderToStaticMarkup(<StaticStore state={state}><HomeNeedsContext.Provider value={needs}><Settings /></HomeNeedsContext.Provider></StaticStore>);
  expect(settingsHtml).toContain("1 accounts · 0 in use");
  expect(settingsHtml).toContain("Settings");
});

test("Home offers project-level Retry after a latest-update failure", async () => {
  const ready = { ...project, status_report: "hourly" } as ProjectView;
  projectsStore.set({ status: "ready", error: null, projects: [ready], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  go("#/home");
  const oldReport = api.statusReport;
  const oldOrchestrator = api.orchestrator;
  let attempts = 0;
  api.statusReport = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("fictional report outage");
    return { report: { markdown: "# Status\nFictional update is ready." } } as Awaited<ReturnType<typeof api.statusReport>>;
  };
  api.orchestrator = async () => ({ local: { running: true, state: "idle" } }) as Awaited<ReturnType<typeof api.orchestrator>>;
  const needs = assembleHomeNeeds(ownerState(), [ready], [], [], [], [], NOW);
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(<StaticStore state={ownerState()}><HomeNeedsContext.Provider value={needs}><HomeTop /></HomeNeedsContext.Provider></StaticStore>); });
    expect(visibleText(tree!.toJSON())).toContain("Couldn't load the latest update");
    const retry = tree!.root.findAllByType("button").find((button) => button.children.includes("Retry"));
    expect(retry).toBeDefined();
    await act(async () => { retry!.props.onClick(); });
    expect(visibleText(tree!.toJSON())).toContain("Fictional update is ready.");
    expect(attempts).toBe(2);
  } finally {
    await act(async () => { tree?.unmount(); });
    api.statusReport = oldReport; api.orchestrator = oldOrchestrator;
  }
});

test("question mark opens shortcuts outside inputs, Escape closes and returns focus", async () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const listeners = new Set<(event: KeyboardEvent) => void>();
  let focused: { focus: () => void } | null = null;
  const origin = { focus: () => { focused = origin; } };
  focused = origin;
  class FakeButton { focus() { focused = this; } }
  (globalThis as { window: unknown }).window = { ...oldWindow,
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => { if (type === "keydown") listeners.add(listener); },
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => { if (type === "keydown") listeners.delete(listener); },
  };
  (globalThis as { document: unknown }).document = { get activeElement() { return focused; } };
  function Harness() {
    const [open, setOpen] = useState(false);
    useGlobalHotkeys(() => undefined, () => setOpen(true));
    return open ? <ShortcutsDialog onClose={() => setOpen(false)} /> : null;
  }
  const key = (target: string, value = "?") => ({ key: value, target: { tagName: target, isContentEditable: false },
    metaKey: false, ctrlKey: false, altKey: false, preventDefault: () => undefined } as unknown as KeyboardEvent);
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(<Harness />, { createNodeMock: () => new FakeButton() }); });
    await act(async () => { for (const listener of [...listeners]) listener(key("INPUT")); });
    expect(tree!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    await act(async () => { for (const listener of [...listeners]) listener(key("BODY")); });
    expect(tree!.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(visibleText(tree!.toJSON())).toContain("Board move focus");
    await act(async () => { for (const listener of [...listeners]) listener(key("BODY", "Escape")); });
    expect(tree!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(focused).toBe(origin);
  } finally {
    await act(async () => { tree?.unmount(); });
    (globalThis as { window: unknown }).window = oldWindow;
    (globalThis as { document: unknown }).document = oldDocument;
  }
});

test("mock missing-route errors are never shown raw", () => {
  expect(friendlyError(new ApiError("not_found", "no route for GET /v1/fictional", 404))).toBe("This part of the dashboard is unavailable. Try again.");
});

test("populated Channels and Asks keep hostnames out of visible agent chips", async () => {
  const askedAt = Date.now();
  const ask = { ask: { id: "ask-1", kind: "ask", channel: "build", ts: askedAt,
    author: { handle: "nira", node: "machine-1", agent: "ux-seat" },
    body: { text: "Can we approve the fictional design?", to: "@nira/paperboat-one", expires_at: askedAt + 60_000 } },
    answers: [], state: "open", expires_at: askedAt + 60_000 } as AskView;
  const event = { id: "event-1", kind: "msg.post", channel: "build", ts: askedAt,
    author: { handle: "nira", node: "machine-1", agent: "ux-seat" }, body: { text: "Fictional page is ready for review." } } as Event;
  const state = ownerState({ asks: [ask], events: [event], nodes: [{ node_id: "machine-1", handle: "nira", hostname: "paperboat-one", online: true }] as State["nodes"],
    team: { ...ownerState().team!, channels: [{ name: "build", topic: "Fictional work" }] } as State["team"] });
  go("#/asks");
  const asksHtml = renderToStaticMarkup(<StaticStore state={state}><Asks /></StaticStore>);
  const asksVisible = asksHtml.replace(/<[^>]+>/g, " ");
  expect(asksVisible).toContain("Nira Vale");
  expect(asksVisible).not.toContain("paperboat-one");
  expect(asksVisible).not.toMatch(/walkie (?:post|ask|projects)/);
  go("#/board/build");
  const oldEvents = api.events;
  api.events = async () => ({ events: [event] });
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(<StaticStore state={state}><Board /></StaticStore>); });
    const shown = visibleText(tree!.toJSON());
    expect(shown).toContain("Fictional page is ready for review.");
    expect(shown).toMatch(/Nira\s*'s agent/);
    expect(shown).not.toContain("paperboat-one");
    expect(shown).not.toMatch(/walkie (?:post|ask|projects)/);
  } finally {
    await act(async () => { tree?.unmount(); });
    api.events = oldEvents;
  }
});

test("board shortcuts are in the palette and the hint strip is absent", async () => {
  const html = renderToStaticMarkup(<StaticStore state={ownerState()}><CommandPalette onClose={() => {}} /></StaticStore>);
  expect(html).toContain("Keyboard shortcuts");
  expect(html).toContain("Board: move focus");
  expect(html).toContain("Board: move selected cards to a column");
  const ready = { ...project, boards: [{ ...project.boards[0], name: "Board", meter }] } as ProjectView;
  projectsStore.set({ status: "ready", error: null, projects: [ready], stubs: [], cards: { paperboat: [card("1", "active-board", "doing")] }, cardsError: {}, rooms: {}, roomsError: {} });
  const board = renderToStaticMarkup(<StaticStore state={ownerState()}><ProjectBoard channel="paperboat" /></StaticStore>);
  expect(board).toContain("Board");
  expect(board).not.toContain("pboard-keys");
  expect(board).not.toContain("move to column");
});

test("phone CSS keeps five tab columns and wraps Home agent rows", async () => {
  const [shell, polish] = await Promise.all([
    Bun.file(new URL("../src/styles/shell.css", import.meta.url)).text(),
    Bun.file(new URL("../src/styles/polish.css", import.meta.url)).text(),
  ]);
  expect(shell).toContain("repeat(5, minmax(0, 1fr))");
  expect(polish).toContain(".home-need-open { min-width: 0; flex-wrap: wrap; }");
  expect(polish).toContain(".home-need-open .truncate { min-width: 0; flex: 1 1 100%; }");
});

test("Talkie keeps manual scroll after a rerender and scrolls a recommendation deep link once", async () => {
  go("#/orchestrator?tab=rec-fictional-2");
  const originals = { orchestrator: api.orchestrator, orchestratorMessages: api.orchestratorMessages,
    channelHealth: api.channelHealth, recommendations: api.recommendations };
  const oldDocument = globalThis.document;
  const scroller = { scrollTop: 0, scrollHeight: 1500, clientHeight: 400 };
  let scrolled = 0;
  (globalThis as { document: unknown }).document = {
    getElementById: (id: string) => id === "rec-fictional-2" ? { scrollIntoView: () => { scroller.scrollTop = 500; scrolled++; } } : null,
    addEventListener: () => {}, removeEventListener: () => {}, visibilityState: "visible",
  };
  api.orchestrator = async () => ({ local: { running: false, state: "stopped", auto: false } }) as Awaited<ReturnType<typeof api.orchestrator>>;
  api.orchestratorMessages = async () => ({ messages: [] });
  api.channelHealth = async () => ({ quota_damaged: false, notice: null }) as Awaited<ReturnType<typeof api.channelHealth>>;
  api.recommendations = async () => ({ recs: [{ id: "fictional-2", summary: "Review a fictional page", reason: "Needs a person",
    project_name: "Paperboat", status: "pending", outgoing: null, evidence: [], can_approve: true, can_dismiss: true } as Recommendation], more_open: 0, now: NOW });
  let tree: ReactTestRenderer | undefined;
  try {
    const state = ownerState();
    await act(async () => { tree = create(<StaticStore state={state}><Orchestrator /></StaticStore>, {
      createNodeMock: ({ props }) => props.className === "orch-scroll" ? scroller : {},
    }); });
    expect(scrolled).toBe(1);
    expect(scroller.scrollTop).toBe(500);
    scroller.scrollTop = 350;
    await act(async () => { tree!.update(<StaticStore state={{ ...state, nodes: [] }}><Orchestrator /></StaticStore>); });
    expect(scroller.scrollTop).toBe(350);
    expect(scrolled).toBe(1);
    // A refresh hands the effect a new recommendations array: the deep link must not scroll again.
    const words = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map(words).join(" ") : "";
    const refresh = tree!.root.findAll((n) => n.type === "button" && words(n.props.children).includes("Refresh"))[0];
    expect(refresh).toBeDefined();
    await act(async () => { refresh!.props.onClick(); });
    expect(scrolled).toBe(1);
    expect(scroller.scrollTop).toBe(350);
  } finally {
    await act(async () => { tree?.unmount(); });
    Object.assign(api, originals);
    (globalThis as { document: unknown }).document = oldDocument;
  }
});

test("project counts show a skeleton during load and keep counts when already available", () => {
  projectsStore.set({ status: "ready", error: null, projects: [project], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const base = { asks: [], agents: [], cards: [], recommendations: [], pending: [], logins: [], count: 0 };
  const loading = { ...base, projectCards: [], projectCardsComplete: false, projectCardsStatus: "loading" as const };
  go("#/projects");
  const list = renderToStaticMarkup(<StaticStore state={ownerState()}><HomeNeedsContext.Provider value={loading}><ProjectList /></HomeNeedsContext.Provider></StaticStore>);
  expect(list).toContain('aria-label="Loading project counts"');
  expect(list).not.toContain("Counts unavailable");
  go("#/home");
  const home = renderToStaticMarkup(<StaticStore state={ownerState()}><HomeNeedsContext.Provider value={loading}><HomeTop /></HomeNeedsContext.Provider></StaticStore>);
  expect(home).toContain('aria-label="Loading project counts"');
  expect(home).not.toContain("Counts unavailable");
  const ready = { ...base, projectCards: [card("1", "active-board", "doing")], projectCardsComplete: true, projectCardsStatus: "ready" as const };
  const refreshed = renderToStaticMarkup(<StaticStore state={ownerState()}><HomeNeedsContext.Provider value={ready}><HomeTop /></HomeNeedsContext.Provider></StaticStore>);
  expect(refreshed).toContain("1 in progress");
});

test("Home and Projects navigation keeps the last project counts during a refresh", async () => {
  go("#/home");
  const oldTasks = api.tasks, oldPending = api.pending, oldRecs = api.recommendations;
  const oldRefresh = projectsStore.refresh;
  projectsStore.set({ status: "ready", error: null, projects: [project], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  let calls = 0;
  api.tasks = async () => ++calls <= 3 ? { tasks: [card("1", "active-board", "doing")] } as Awaited<ReturnType<typeof api.tasks>>
    : new Promise<Awaited<ReturnType<typeof api.tasks>>>(() => {});
  api.pending = async () => ({ requests: [] });
  api.recommendations = async () => ({ recs: [], more_open: 0, now: NOW });
  projectsStore.refresh = async () => {};
  let latest: import("../src/views/home/needs.tsx").HomeNeeds | undefined;
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(<StaticStore state={ownerState()}><HomeNeedsProvider>
      <HomeNeedsContext.Consumer>{(value) => { latest = value; return null; }}</HomeNeedsContext.Consumer>
    </HomeNeedsProvider></StaticStore>); });
    expect(latest?.projectCardsStatus).toBe("ready");
    expect(latest?.projectCards).toHaveLength(1);
    await act(async () => { go("#/projects"); });
    expect(latest?.projectCardsStatus).toBe("ready");
    expect(latest?.projectCards).toHaveLength(1);
    await act(async () => { go("#/home"); });
    expect(latest?.projectCardsStatus).toBe("ready");
    expect(latest?.projectCards).toHaveLength(1);
  } finally {
    await act(async () => { tree?.unmount(); });
    api.tasks = oldTasks; api.pending = oldPending; api.recommendations = oldRecs;
    projectsStore.refresh = oldRefresh;
  }
});

test("project report switch and immediate hint stay inside the padded dialog body above the form", () => {
  const configured = { ...project, creator: "nira", private: false,
    automations: { agents_can_close: false, pr_opened: false, pr_merged: false } } as ProjectView;
  const html = renderToStaticMarkup(<StaticStore state={ownerState()}><ProjectSettings project={configured} onClose={() => {}} /></StaticStore>);
  expect(html).toMatch(/<div class="dialog-body"><div class="project-report-immediate"><div class="project-report-switch">/);
  expect(html).toMatch(/Hourly status report[\s\S]*?\(applies now\)[\s\S]*?<form/);
});

test("a failed lazy page offers Reload and retries its import after navigation", async () => {
  let attempts = 0;
  const Page = retryableLazy(async () => {
    attempts++;
    if (attempts === 1) throw new Error("Fictional stale chunk");
    return { default: () => <p>Fictional page ready</p> };
  });
  const view = <ErrorBoundary scope="view" name="Fictional page"><Suspense fallback={<p>Loading</p>}><Page /></Suspense></ErrorBoundary>;
  const oldError = console.error;
  console.error = () => {};
  let tree: ReactTestRenderer | undefined;
  try {
    await act(async () => { tree = create(view); });
    expect(visibleText(tree!.toJSON())).toContain("Reload");
    await act(async () => { tree!.unmount(); });
    go("#/fictional-next-route");
    await act(async () => { tree = create(view); });
    expect(visibleText(tree!.toJSON())).toContain("Fictional page ready");
    expect(attempts).toBe(2);
  } finally {
    await act(async () => { tree?.unmount(); });
    console.error = oldError;
  }
});

test("Talkie lifecycle and compute errors hide raw missing route text", async () => {
  const [{ lifecycleError }, { ComputeError }, { computeErrorText }] = await Promise.all([
    import("../src/views/orchestrator/lifecycle-error.ts"), import("../src/api/compute.ts"),
    import("../src/views/compute/AddComputeSheet.tsx"),
  ]);
  const message = "no route for GET /v1/fictional";
  expect(lifecycleError(new ApiError("not_found", message, 404))).toBe("This part of the dashboard is unavailable. Try again.");
  expect(computeErrorText(new ComputeError("not_found", message, 404))).toBe("This part of the dashboard is unavailable. Try again.");
});
