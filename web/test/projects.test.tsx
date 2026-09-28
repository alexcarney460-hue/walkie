// WALKIE-PROJECTS-1 dashboard: the pure board helpers, board deltas, and the rendered list / board / card faces.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentView, BoardView, CardView, Column, ProjectView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { installWindow } from "./window-stub.ts";

const hadWindow = "window" in globalThis;
const hadDocument = "document" in globalThis;
installWindow();
const inert: unknown = new Proxy(() => inert, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : inert), apply: () => undefined });
(globalThis as { document?: unknown }).document ??= inert;
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  if (!hadDocument) delete (globalThis as { document?: unknown }).document;
});

type Lib = typeof import("../src/lib/projects.ts");
type St = typeof import("../src/state/projects.ts");
let lib: Lib, st: St;
let Kanban: typeof import("../src/views/projects/Kanban.tsx").Kanban;
let ProjectList: typeof import("../src/views/projects/ProjectList.tsx").ProjectList;
let StaticStore: (p: { state: State; children: ReactNode }) => ReactNode;
let initialState: State;
beforeAll(async () => {
  lib = await import("../src/lib/projects.ts");
  st = await import("../src/state/projects.ts");
  Kanban = (await import("../src/views/projects/Kanban.tsx")).Kanban;
  ProjectList = (await import("../src/views/projects/ProjectList.tsx")).ProjectList;
  const s = await import("../src/state/store.tsx");
  StaticStore = s.StaticStore;
  initialState = (await import("../src/state/reducer.ts")).initialState;
});

const COLS: Column[] = [
  { id: "todo", name: "To do", role: "todo" }, { id: "doing", name: "In progress", role: "active", wip: 1 },
  { id: "review", name: "In review", role: "review" }, { id: "done", name: "Done", role: "done" },
];
const meter = { mode: "count" as const, done: 1, counted: 4, by_role: { backlog: 0, todo: 2, active: 1, review: 0, done: 1, cancelled: 0 } };
const author = { handle: "maren", node: "a000000000000001" };
const BOARD: BoardView = { id: "a000000000000001:2", name: "Main", columns: COLS, state: "active", created_at: 0, created_by: author, meter, live_cards: 4 };
const PROJECT: ProjectView = {
  channel: "p-00000001", id: "a000000000000001:1", name: "Website", folder: "Acme", description: "", prefix: "WEB",
  paths: [{ path: "~/work/site" }], meter_mode: "count", automations: { pr_opened: true, pr_merged: false, agents_can_close: true },
  state: "active", private: false, admins: ["maren"], creator: "maren", created_at: 0, boards: [BOARD], meter, cards: 4, last_activity: Date.now(),
};
const card = (n: number, column: string, pos: string, extra: Partial<CardView> = {}): CardView => ({
  id: `a000000000000001:${10 + n}`, channel: PROJECT.channel, board: BOARD.id, key: `WEB-${n}`, n, short: "0000", ref: `WEB-${n}-0000`, title: `Card ${n}`, body: "",
  column, pos, assignee: null, reviewer: null, labels: [], estimate: null, due: null, blocked: false, blocked_reason: null,
  state: "open", created_at: 0, created_by: author, updated_at: 0, updated_by: author, comments: 0, rev: 0, ...extra,
});
const CARDS = [card(1, "todo", "m", { labels: ["bug"] }), card(2, "todo", "c", { assignee: "@maren" }), card(3, "doing", "i", { blocked: true }), card(4, "done", "i")];
const agent = (name: string, task: string, state: AgentView["effective_state"] = "working"): AgentView => ({
  id: `maren/mbp/${name}`, handle: "maren", node: "n1", hostname: "mbp", agent: name, status: { agent: name, state, runtime: "claude-code", task },
  updated_at: Date.now(), machine_online: true, effective_state: state, archived: false,
});

test("columns: open cards by position, filtered; the total counts before the filter", () => {
  const cols = lib.columnsOf(BOARD, CARDS, lib.NO_FILTERS, "maren");
  expect(cols.map((c) => c.cards.map((x) => x.key))).toEqual([["WEB-2", "WEB-1"], ["WEB-3"], [], ["WEB-4"]]);
  const mine = lib.columnsOf(BOARD, CARDS, { ...lib.NO_FILTERS, mine: true }, "maren");
  expect(mine[0]?.cards.map((x) => x.key)).toEqual(["WEB-2"]);
  expect(mine[0]?.total).toBe(2);
  expect(lib.columnsOf(BOARD, CARDS, { ...lib.NO_FILTERS, label: "bug" }, null)[0]?.cards.map((x) => x.key)).toEqual(["WEB-1"]);
  expect(lib.columnsOf(BOARD, CARDS, { ...lib.NO_FILTERS, q: "card 3" }, null)[1]?.cards.length).toBe(1);
});

test("a drop lands before the card at the index (itself excluded), else after the last", () => {
  const col = [CARDS[1] as CardView, CARDS[0] as CardView];
  expect(lib.dropTarget(col, 0, "x")).toEqual({ before: CARDS[1]?.id });
  expect(lib.dropTarget(col, 5, "x")).toEqual({ after: CARDS[0]?.id });
  expect(lib.dropTarget(col, 0, CARDS[1]?.id as string)).toEqual({ before: CARDS[0]?.id });
  expect(lib.dropTarget([], 0, "x")).toEqual({});
});

test("keyboard focus: j/k within a column, h/l across, clamped", () => {
  expect(lib.moveFocus({ col: 0, row: -1 }, "j", [2, 1, 0, 1])).toEqual({ col: 0, row: 0 });
  expect(lib.moveFocus({ col: 0, row: 1 }, "l", [2, 1, 0, 1])).toEqual({ col: 1, row: 0 });
  expect(lib.moveFocus({ col: 1, row: 0 }, "l", [2, 1, 0, 1])).toEqual({ col: 2, row: 0 });
  expect(lib.moveFocus({ col: 3, row: 0 }, "l", [2, 1, 0, 1])).toEqual({ col: 3, row: 0 });
  expect(lib.moveFocus({ col: 0, row: 1 }, "j", [2, 1, 0, 1])).toEqual({ col: 0, row: 1 });
});

test("presence: agents by card key and by project; stuck = blocked card or an agent needing a person", () => {
  const agents = [agent("cc-1", "WEB-1"), agent("cc-2", "WEB-3", "waiting"), agent("cc-3", "OTHER-1"), { ...agent("cc-4", "WEB-2", "offline") }];
  const p = lib.presence(agents, [PROJECT], (_ch, n) => n <= 4);
  expect(p.byCard.get("WEB-1")?.map((a) => a.agent)).toEqual(["cc-1"]);
  expect(p.byProject.get(PROJECT.channel)?.length).toBe(2);
  expect(lib.stuck(CARDS[0] as CardView, p.byCard.get("WEB-1"))).toBe(false);
  expect(lib.stuck(CARDS[1] as CardView, [agent("cc-2", "WEB-2", "waiting")])).toBe(true);
  expect(lib.stuck(CARDS[2] as CardView, undefined)).toBe(true);
});

test("board deltas: project replaced, changed cards merged, removed dropped; reset leaves cards for a refetch", () => {
  const s0 = { ...{ status: "ready" as const, error: null, stubs: [], cardsError: {} }, projects: [PROJECT], cards: { [PROJECT.channel]: CARDS }, rooms: {}, roomsError: {} };
  const moved = { ...(CARDS[0] as CardView), column: "done" };
  const added = card(5, "todo", "z");
  const s1 = st.applyDelta(s0, { channel: PROJECT.channel, project: { ...PROJECT, name: "Site" }, cards: [moved, added], removed: [CARDS[3]?.id as string] });
  expect(s1.projects[0]?.name).toBe("Site");
  expect(s1.cards[PROJECT.channel]?.map((c) => `${c.key}:${c.column}`)).toEqual(["WEB-1:done", "WEB-2:todo", "WEB-3:doing", "WEB-5:todo"]);
  const s2 = st.applyDelta(s0, { channel: PROJECT.channel, project: null });
  expect(s2.projects).toEqual([]);
  expect(st.applyDelta(s0, { channel: PROJECT.channel, reset: true }).cards[PROJECT.channel]).toBe(CARDS);
});

test("the board renders columns with WIP, the Stuck badge, agent faces and the phone's column tabs", () => {
  const cols = lib.columnsOf(BOARD, CARDS, lib.NO_FILTERS, "maren");
  const byCard = new Map([["WEB-1", [agent("cc-1", "WEB-1")]]]);
  const html = renderToStaticMarkup(
    <Kanban columns={cols} byCard={byCard} focus={{ col: 0, row: 0 }} selected={new Set([CARDS[0]?.id as string])} openCard={null} composerFor={null}
      phoneCol={1} onPhoneCol={() => {}} onOpen={() => {}} onMove={() => {}} onCompose={() => {}} onCreate={async () => true} onFocus={() => {}} />,
  );
  expect(html).toContain('data-col="doing"');
  expect(html).toContain("1/1");
  expect(html).toContain("Stuck");
  expect(html).toContain("kcard is-focus");
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('class="kcol role-active is-phone-on"');
  expect(html).toContain("agent working here: cc-1");
  expect(html).toContain('role="tablist"');
});

test("the project list groups by folder, shows the done count and private stubs", () => {
  st.projectsStore.set({ status: "ready", error: null, projects: [PROJECT, { ...PROJECT, channel: "p-00000002", name: "Hiring", folder: "", prefix: "HR" }], stubs: [{ channel: "p-00000003", private: true, stub: true, members: ["maren"] }], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const state = { ...initialState, phase: "ready" as const, me: { handle: "maren", role: "owner" } as State["me"], agents: [agent("cc-1", "WEB-1")] };
  const html = renderToStaticMarkup(<StaticStore state={state}><ProjectList /></StaticStore>);
  expect(html.indexOf("Acme")).toBeLessThan(html.indexOf("No folder"));
  expect(html).toContain("<strong>1</strong>");
  expect(html).toContain("1 private project of the team");
  expect(html).toContain("1 agent on them now");
});

// ---- DATA-ROOM-1 ------------------------------------------------------------------------------------------------

test("Data Room: the room route, the paperclip count on a card tile, and the secret-finding wording", async () => {
  const route = await import("../src/lib/route.ts");
  expect(route.parseHash("#/projects/p-00000001/room")).toMatchObject({ view: "projects", channel: "p-00000001", room: true });
  expect(route.parseHash("#/projects/p-00000001/room").board).toBeUndefined();
  expect(route.hrefFor({ view: "projects", channel: "p-00000001", room: true })).toBe("#/projects/p-00000001/room");
  const cols = lib.columnsOf(BOARD, CARDS, lib.NO_FILTERS, "maren");
  const html = renderToStaticMarkup(
    <Kanban columns={cols} byCard={new Map()} focus={null} selected={new Set()} openCard={null} composerFor={null}
      phoneCol={0} onPhoneCol={() => {}} onOpen={() => {}} onMove={() => {}} onCompose={() => {}} onCreate={async () => true} onFocus={() => {}}
      attached={new Map([[CARDS[0]?.id as string, 3]])} onCardFiles={() => {}} />,
  );
  expect(html).toContain('title="3 files from the Data Room"');
  const { findingText } = await import("../src/views/projects/RoomUpload.tsx");
  expect(findingText(["stripe_key", "secret", "stripe_key"])).toBe("a Stripe key, a password or secret");
  expect(findingText(["sendgrid_key"])).toBe("sendgrid key");
});

test("Data Room: a room delta refetches only a room this tab loaded; a file this tab wrote replaces its row", async () => {
  const calls: string[] = [];
  const client = await import("../src/api/client.ts");
  const orig = client.api.room;
  (client.api as { room: typeof orig }).room = async (channel: string) => { calls.push(channel); return { files: [], limits: { files: 1000, versions: 100 } }; };
  try {
    st.projectsStore.set({ status: "ready", error: null, projects: [PROJECT], stubs: [], cards: {}, cardsError: {}, rooms: { [PROJECT.channel]: [] }, roomsError: {} });
    st.projectsStore.delta({ channel: PROJECT.channel, room: true });
    st.projectsStore.delta({ channel: "p-00000009", room: true });
    await Bun.sleep(0);
    expect(calls).toEqual([PROJECT.channel]);
    const f = { id: "a:1", channel: PROJECT.channel, name: "spec.md", pinned: false, state: "active" as const, hash: "0".repeat(64), size: 3, mime: "text/markdown", version: 1, versions: 1, updated_at: 1, updated_by: { handle: "maren", node: "a" }, created_at: 1, created_by: { handle: "maren", node: "a" }, cards: [], available: true, rev: 0 };
    st.projectsStore.roomFile(f);
    st.projectsStore.roomFile({ ...f, version: 2, versions: 2 });
    expect(st.projectsStore.get().rooms[PROJECT.channel]?.map((x) => x.version)).toEqual([2]);
  } finally {
    (client.api as { room: typeof orig }).room = orig;
  }
});
