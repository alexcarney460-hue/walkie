import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountView, CardView, ProjectView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { go, installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_target, key) => key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : inert, apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

let mod: {
  RememberedDetails: typeof import("../src/components/RememberedDetails.tsx").RememberedDetails;
  accountSummary: typeof import("../src/views/Accounts.tsx").accountSummary;
  orderedAccounts: typeof import("../src/views/Accounts.tsx").orderedAccounts;
  CardDrawer: typeof import("../src/views/projects/CardDrawer.tsx").CardDrawer;
  StatusReportView: typeof import("../src/views/projects/StatusReportPanel.tsx").StatusReportView;
  StaticStore: typeof import("../src/state/store.tsx").StaticStore;
  initialState: State;
  Team: typeof import("../src/views/Team.tsx").Team;
  AuthorName: typeof import("../src/components/Author.tsx").AuthorName;
  HomeTop: typeof import("../src/views/home/Home.tsx").HomeTop;
  ProjectList: typeof import("../src/views/projects/ProjectList.tsx").ProjectList;
  Orchestrator: typeof import("../src/views/orchestrator/Orchestrator.tsx").Orchestrator;
  Board: typeof import("../src/views/board/Board.tsx").Board;
  Asks: typeof import("../src/views/Asks.tsx").Asks;
};
beforeAll(async () => {
  const [details, accounts, drawer, reports, store, reducer, team, author, home, projects, talkie, board, asks] = await Promise.all([
    import("../src/components/RememberedDetails.tsx"), import("../src/views/Accounts.tsx"),
    import("../src/views/projects/CardDrawer.tsx"), import("../src/views/projects/StatusReportPanel.tsx"),
    import("../src/state/store.tsx"), import("../src/state/reducer.ts"), import("../src/views/Team.tsx"),
    import("../src/components/Author.tsx"), import("../src/views/home/Home.tsx"), import("../src/views/projects/ProjectList.tsx"),
    import("../src/views/orchestrator/Orchestrator.tsx"), import("../src/views/board/Board.tsx"), import("../src/views/Asks.tsx"),
  ]);
  mod = { RememberedDetails: details.RememberedDetails, accountSummary: accounts.accountSummary,
    orderedAccounts: accounts.orderedAccounts, CardDrawer: drawer.CardDrawer, StatusReportView: reports.StatusReportView,
    StaticStore: store.StaticStore, initialState: reducer.initialState,
    Team: team.Team, AuthorName: author.AuthorName, HomeTop: home.HomeTop, ProjectList: projects.ProjectList,
    Orchestrator: talkie.Orchestrator, Board: board.Board, Asks: asks.Asks };
});

test("page disclosure starts closed, remembers a toggle, and survives blocked storage", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<mod.RememberedDetails id="fictional" summary="Advanced"><p>Inner</p></mod.RememberedDetails>); });
    expect(tree!.root.findByType("details").props.open).toBe(false);
    await act(async () => { tree!.root.findByType("details").props.onToggle({ currentTarget: { open: true } }); });
    expect(values.get("sqwakie-details:fictional")).toBe("open");
    await act(async () => { tree!.unmount(); });
    expect(renderToStaticMarkup(<mod.RememberedDetails id="fictional" summary="Advanced">Inner</mod.RememberedDetails>)).toContain('<details open=""');
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); },
    } });
    await act(async () => { tree = create(<mod.RememberedDetails id="blocked" summary="Advanced">Inner</mod.RememberedDetails>); });
    expect(tree!.root.findByType("details").props.open).toBe(false);
    await act(async () => { tree!.root.findByType("details").props.onToggle({ currentTarget: { open: true } }); });
    expect(tree!.root.findByType("details").props.open).toBe(true);
    await act(async () => { tree!.unmount(); });
  } finally {
    if (old) Object.defineProperty(globalThis, "localStorage", old);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

const NOW = Date.UTC(2026, 9, 17, 12);
const usage = (state: "ok" | "exhausted" | "relogin" | "stale" | "unknown", until: number | null = null) =>
  ({ at: state === "stale" ? NOW - 20 * 60_000 : NOW, state, reason: null, source: "api", until, windows: [] }) as AccountView["usage"];
const account = (key: string, state: "ok" | "exhausted" | "relogin" | "stale" | "unknown", until: number | null = null) =>
  ({ key, id: key, provider: "codex", label: "fi***@example.test", owners: ["nira"], machines: [], usage: usage(state, until), claimed_by: [], usage_host: null, last_seen: NOW }) as AccountView;

test("Accounts counts states and puts logins needing a person before the rest", () => {
  const list = [account("room", "ok"), account("unknown", "unknown"), account("limit", "exhausted", NOW + 71 * 60_000),
    account("stale", "stale"), account("login", "relogin")];
  expect(mod.accountSummary(list, NOW)).toEqual({ room: 1, exhausted: 1, relogin: 1, stale: 1, unknown: 1, likely: 0, reset: NOW + 71 * 60_000 });
  expect(mod.orderedAccounts(list, NOW).map((item) => item.key)).toEqual(["login", "limit", "stale", "room", "unknown"]);
});

test("card drawer keeps actions and comments ahead of files and puts provenance in closed history", () => {
  const project = { id: "p-1", channel: "p-1", name: "Fictional site", prefix: "FIC", state: "active", boards: [
    { id: "b-1", state: "active", name: "Board", columns: [{ id: "todo", name: "To do", role: "todo" }] },
  ] } as ProjectView;
  const card = { id: "c-1", key: "FIC-1", channel: "p-1", board: "b-1", column: "todo", title: "Review page", body: "Check it",
    state: "open", rev: 1, labels: [], comments: 0, blocked: false } as CardView;
  const state = { ...mod.initialState, phase: "ready" as const, me: { handle: "nira", role: "owner" } as State["me"] };
  const html = renderToStaticMarkup(<mod.StaticStore state={state}><mod.CardDrawer card={card} project={project} byCard={new Map()} onClose={() => {}} /></mod.StaticStore>);
  const sections = [...html.matchAll(/<h3 class="drawer-h">([\s\S]*?)<\/h3>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, "").trim());
  expect(sections).toEqual(["Description", "Activity and comments", "Blocked", "Agents on it", "Files Data Room"]);
  const order = ["Move to", "Assignee", "Description", "Activity and comments", "Files", "Estimate", "Due", "Labels", "History of changes"].map((label) => html.indexOf(label));
  expect(order.every((position) => position >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(html).toContain("<summary>History of changes</summary>");
  expect(html).not.toContain("<details open");
});

test("project report shows its verdict first and keeps full markdown closed", () => {
  const html = renderToStaticMarkup(<mod.StatusReportView onRetry={() => {}} state={{ status: "ready", data: {
    mode: "hourly", report: { markdown: "**On track:** review is next.\n\n## Full report\nAll details.", header: null,
      as_of: NOW, at: NOW, by: { handle: "nira", agent: "talkie" } },
  } }} />);
  expect(html).toContain("<strong>On track:</strong> review is next.");
  expect(html).toContain("Read full report");
  expect(html).not.toContain("**On track:**");
  expect(html).not.toContain("status-report-title");
  expect(html).not.toContain("<details open");
});

test("an old project report has one visible disclosure line", () => {
  const html = renderToStaticMarkup(<mod.StatusReportView onRetry={() => {}} state={{ status: "ready", data: {
    mode: "off", report: { markdown: "A prior report.", header: null, as_of: NOW, at: NOW, by: { handle: "nira", agent: "talkie" } },
  } }} />);
  expect(html).toContain("Last report");
  expect(html).toContain("hourly reports are off");
  expect(html).not.toContain('<h2 id="status-report-title"');
});

const fictionalTeam = {
  id: "fictional-team", name: "Paperboat", plan: null, authority: "node-1",
  members: [{ handle: "nira", display_name: "Nira Vale", login: "nira@paperboat.example", role: "owner" }],
  nodes: [], channels: [],
} as State["team"];
const ownerState = () => ({ ...mod.initialState, phase: "ready" as const,
  me: { handle: "nira", role: "owner", node: { id: "node-1", hostname: "paperboat-one" } } as State["me"],
  team: fictionalTeam, nodes: [], asks: [], agents: [], accounts: [] });

test("Team opens Add a teammate in a sheet, and machine details stay off its table", async () => {
  go("#/team");
  const api = await import("../src/api/client.ts");
  const original = api.api.pending;
  api.api.pending = async () => ({ requests: [] });
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { tree = create(<mod.StaticStore state={ownerState()}><mod.Team /></mod.StaticStore>); });
    const button = tree!.root.findAllByType("button").find((item) => item.children.includes("Add a teammate"));
    expect(button).toBeDefined();
    await act(async () => { button!.props.onClick(); });
    expect(tree!.root.findAllByProps({ role: "dialog" }).some((item) => item.props["aria-label"] === "Add a teammate")).toBe(true);
    const html = renderToStaticMarkup(<mod.StaticStore state={ownerState()}><mod.Team /></mod.StaticStore>);
    expect(html).not.toContain("Latency</th>");
    expect(html).not.toContain("Sync</th>");
  } finally {
    api.api.pending = original;
    await act(async () => { tree?.unmount(); });
  }
});

test("agent author chips keep the machine in a tooltip only", () => {
  const state = { ...ownerState(), nodes: [{ node_id: "node-1", handle: "nira", hostname: "paperboat-one", online: true }] as State["nodes"] };
  const html = renderToStaticMarkup(<mod.StaticStore state={state}><mod.AuthorName author={{ handle: "nira", node: "node-1", agent: "ux-seat" }} /></mod.StaticStore>);
  expect(html).toContain("Nira&#x27;s agent");
  expect(html).toContain('title="Open nira/paperboat-one/ux-seat"');
  expect(html).not.toContain("agent on paperboat-one");
});

test("empty human pages show dashboard actions without visible CLI instructions", () => {
  const state = ownerState();
  const views = [
    ["#/home", <mod.HomeTop />], ["#/projects", <mod.ProjectList />], ["#/orchestrator", <mod.Orchestrator />],
    ["#/board", <mod.Board />], ["#/asks", <mod.Asks />],
  ] as const;
  for (const [hash, view] of views) {
    go(hash);
    const html = renderToStaticMarkup(<mod.StaticStore state={state}>{view}</mod.StaticStore>);
    expect(html).not.toMatch(/walkie (?:ask|post|projects|talkie|room)/);
  }
});
