// DASH-BLANK-1 (WALKIE-98): the dashboard never goes white. A render error anywhere shows a plain screen with Reload
// (root), a small message in the place of one view (view) or one card (item), and the rest of the page keeps working.
// These tests mount real React trees with react-dom/client (test/mini-dom.ts): React's server renderer, which the other
// web tests use, never calls an error boundary.
import { act, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { AgentState, AgentView, CardView, Column, NodeView, TeamView } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { installDom, type DomEnv, type MiniElement } from "./mini-dom.ts";
import { go, testWindow } from "./window-stub.ts";

let env: DomEnv;
let eb: typeof import("../src/components/ErrorBoundary.tsx");
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let initialState: State;
let MissionControl: typeof import("../src/views/mission/MissionControl.tsx").MissionControl;
let Kanban: typeof import("../src/views/projects/Kanban.tsx").Kanban;
let Board: typeof import("../src/views/board/Board.tsx").Board;
let App: typeof import("../src/App.tsx").App;
let Root: typeof import("../src/Root.tsx").Root;
let projectsStore: typeof import("../src/state/projects.ts").projectsStore;
let routeMod: typeof import("../src/lib/route.ts");
const realFetch = globalThis.fetch;

beforeAll(async () => {
  env = await installDom();
  [eb, { StaticStore }, { initialState }, { MissionControl }, { Kanban }, { Board }, { App }, { Root }, { projectsStore }, routeMod] = await Promise.all([
    import("../src/components/ErrorBoundary.tsx"), import("../src/state/store.tsx"), import("../src/state/reducer.ts"),
    import("../src/views/mission/MissionControl.tsx"), import("../src/views/projects/Kanban.tsx"), import("../src/views/board/Board.tsx"),
    import("../src/App.tsx"), import("../src/Root.tsx"), import("../src/state/projects.ts"), import("../src/lib/route.ts"),
  ]);
});
afterAll(async () => {
  await env.restore();
  globalThis.fetch = realFetch;
});

/** Console lines the boundaries write (React's own caught-error logging is off in these roots). */
let consoleError: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => {
  eb.forgetLoggedErrors();
  consoleError = spyOn(console, "error").mockImplementation(() => {});
  env.caught.length = 0;
  env.uncaught.length = 0;
  go("#/mission");
});
afterEach(() => {
  consoleError.mockRestore();
  globalThis.fetch = realFetch;
  delete (testWindow.location as { reload?: unknown }).reload;
});
const logged = () => consoleError.mock.calls.filter((c) => String(c[0]).startsWith("[walkie]"));

async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function until(cond: () => boolean, ms = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (env.uncaught.length) throw env.uncaught[0]; // a white page: say why
    if (Date.now() - start > ms) throw new Error("timed out waiting for the page");
    await settle(1);
  }
}
const nav = (hash: string) => act(async () => { go(hash); });
const count = (text: string, part: string) => text.split(part).length - 1;
const ITEM = "This item could not be shown";

function Boom({ fail = true, label = "ok", message = "boom" }: { fail?: boolean; label?: string; message?: string }) {
  if (fail) throw new Error(message);
  return <span>{label}</span>;
}

// ---- the boundary itself -------------------------------------------------------------------------------------------

test("item: a child that throws is replaced by a small message; its siblings and the page around it stay", async () => {
  const page = await env.mount(
    <section>
      <h1>Page title</h1>
      <span>one</span>
      <eb.ErrorBoundary scope="item" name="agent seat-2"><Boom message="card exploded" /></eb.ErrorBoundary>
      <span>three</span>
    </section>,
  );
  expect(page.text()).toContain("Page title");
  expect(page.text()).toContain("one");
  expect(page.text()).toContain("three");
  expect(count(page.text(), ITEM)).toBe(1);
  expect(page.one('[data-testid="boundary-item"]')).not.toBeNull();
  expect(env.uncaught).toEqual([]);
  expect(env.caught).toHaveLength(1);
});

test("item: the error message and the name of what failed are under Details, closed by default; no stack shows up front", async () => {
  const page = await env.mount(<eb.ErrorBoundary scope="item" name="agent seat-2"><Boom message="card exploded" /></eb.ErrorBoundary>);
  const details = page.one("details") as MiniElement;
  expect(details).not.toBeNull();
  expect(details.hasAttribute("open")).toBe(false);
  expect(details.one("summary")?.textContent).toBe("Details");
  expect(details.textContent).toContain("agent seat-2");
  expect(details.textContent).toContain("card exploded");
  expect(details.one("pre")?.textContent).toContain("Boom"); // the stack names the component that threw
  // outside Details: only the short message
  const outside = page.text().replace(details.textContent, "");
  expect(outside).toContain(ITEM);
  expect(outside).not.toContain("card exploded");
});

test("item in a list: the fallback is an li when asked, so the list stays valid", async () => {
  const page = await env.mount(
    <ul>
      <li>first</li>
      <eb.ErrorBoundary scope="item" name="row" as="li"><Boom /></eb.ErrorBoundary>
      <li>last</li>
    </ul>,
  );
  const list = page.one("ul") as MiniElement;
  expect(list.childNodes).toHaveLength(3);
  expect(list.childNodes.every((n) => (n as MiniElement).localName === "li")).toBe(true); // no stray div among the items
  expect(page.one('li[data-testid="boundary-item"]')).not.toBeNull();
});

test("view: the view's place shows its name and the message while a sibling (the shell) keeps working", async () => {
  const page = await env.mount(
    <div>
      <nav>shell navigation</nav>
      <main><eb.ErrorBoundary scope="view" name="Projects"><Boom message="view exploded" /></eb.ErrorBoundary></main>
    </div>,
  );
  expect(page.text()).toContain("shell navigation");
  const view = page.one('[data-testid="boundary-view"]') as MiniElement;
  expect(view).not.toBeNull();
  expect(view.textContent).toContain("Projects");
  expect(count(page.text(), ITEM)).toBe(1);
  expect(page.one("details")?.textContent).toContain("view exploded");
  expect(env.uncaught).toEqual([]);
});

test("root: a plain screen with the message, a closed Details, Reload and Back to Mission Control", async () => {
  const reloads: number[] = [];
  (testWindow.location as { reload?: () => void }).reload = () => { reloads.push(1); };
  const page = await env.mount(<eb.ErrorBoundary scope="root" name="Walkie dashboard"><Boom message="the store fell over" /></eb.ErrorBoundary>);
  const root = page.one('[data-testid="boundary-root"]') as MiniElement;
  expect(root).not.toBeNull();
  expect(page.one("h1")?.textContent).toBe("Walkie's dashboard hit an error");
  expect(page.one("p.boundary-message")?.textContent).toContain("the store fell over");
  const details = page.one("details") as MiniElement;
  expect(details.hasAttribute("open")).toBe(false);
  expect(details.textContent).toContain("Walkie dashboard"); // where
  expect(details.one("pre")?.textContent).toContain("Boom");
  expect(page.one("p.boundary-message")?.textContent).not.toContain("at Boom"); // no stack outside Details
  const back = page.all("a").find((a) => a.textContent === "Back to Mission Control") as MiniElement;
  expect(back.getAttribute("href")).toBe("#/mission");
  const reload = page.all("button").find((b) => b.textContent === "Reload") as MiniElement;
  expect(reload).toBeDefined();
  await page.click(reload);
  expect(reloads).toEqual([1]);
});

test("root: Back to Mission Control tries the page again without a reload", async () => {
  let failing = true;
  function Flaky() { if (failing) throw new Error("not yet"); return <span>recovered</span>; }
  const page = await env.mount(<eb.ErrorBoundary scope="root" name="Walkie dashboard"><Flaky /></eb.ErrorBoundary>);
  expect(page.one('[data-testid="boundary-root"]')).not.toBeNull();
  failing = false;
  await page.click(page.all("a").find((a) => a.textContent === "Back to Mission Control") as MiniElement);
  expect(page.text()).toBe("recovered");
});

test("the console gets the error once, even when the boundary tries again and fails the same way", async () => {
  function Same({ n }: { n: number }) { throw new Error(`same failure ${n >= 0 ? "" : "?"}`); }
  const page = await env.mount(<eb.ErrorBoundary scope="item" name="agent a" resetKeys={[1]}><Same n={1} /></eb.ErrorBoundary>);
  expect(logged()).toHaveLength(1);
  expect(String(logged()[0]?.[0])).toContain("agent a");
  await page.render(<eb.ErrorBoundary scope="item" name="agent a" resetKeys={[2]}><Same n={2} /></eb.ErrorBoundary>);
  expect(count(page.text(), ITEM)).toBe(1);
  expect(logged()).toHaveLength(1); // the retry caught the same error: not logged again
  await page.render(<eb.ErrorBoundary scope="item" name="agent a" resetKeys={[3]}><Boom message="a different failure" /></eb.ErrorBoundary>);
  expect(logged()).toHaveLength(2); // a different error is news
});

test("the boundary tries again when its reset keys change, not before", async () => {
  const wrap = (keys: unknown[], fail: boolean, label = "fixed") => (
    <eb.ErrorBoundary scope="item" name="card" resetKeys={keys}><Boom fail={fail} label={label} /></eb.ErrorBoundary>
  );
  const page = await env.mount(wrap([1], true));
  expect(page.text()).toContain(ITEM);
  await page.render(wrap([1], false)); // the data would render now, but nothing told the boundary
  expect(page.text()).toContain(ITEM);
  await page.render(wrap([2], false)); // the item's data changed
  expect(page.text()).toBe("fixed");
});

test("reset keys of a different length count as a change; the same elements do not", async () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const wrap = (keys: unknown[], fail: boolean) => (
    <eb.ErrorBoundary scope="item" name="card" resetKeys={keys}><Boom fail={fail} label="fixed" /></eb.ErrorBoundary>
  );
  const page = await env.mount(wrap([a], true));
  await page.render(wrap([a], false));
  expect(page.text()).toContain(ITEM); // same elements, new array: not a change
  await page.render(wrap([a, b], false));
  expect(page.text()).toBe("fixed");
});

test("a failure caused by the very update that changed the keys is not retried in a loop", async () => {
  const renders: string[] = [];
  function Counting({ fail }: { fail: boolean }) { renders.push("render"); if (fail) throw new Error("still bad"); return <span>ok</span>; }
  const wrap = (key: number) => <eb.ErrorBoundary scope="item" name="card" resetKeys={[key]}><Counting fail /></eb.ErrorBoundary>;
  const page = await env.mount(wrap(1));
  const before = renders.length;
  await page.render(wrap(2));
  await settle();
  expect(count(page.text(), ITEM)).toBe(1);
  expect(renders.length - before).toBeLessThan(6); // a few attempts, not a loop
});

test("root and view boundaries try again when the route changes", async () => {
  function OnBoard() { if (routeMod.useRoute().view === "board") throw new Error("bad on this route"); return <span>fine here</span>; }
  go("#/board");
  const page = await env.mount(<eb.RootBoundary><OnBoard /></eb.RootBoundary>);
  expect(page.one('[data-testid="boundary-root"]')).not.toBeNull();
  await nav("#/mission");
  expect(page.text()).toBe("fine here");
});

test("a failure in an inner boundary's child does not reach the outer one", async () => {
  const page = await env.mount(
    <eb.ErrorBoundary scope="root" name="Walkie dashboard">
      <eb.ErrorBoundary scope="view" name="Asks">
        <span>view body</span>
        <eb.ErrorBoundary scope="item" name="ask 1"><Boom /></eb.ErrorBoundary>
      </eb.ErrorBoundary>
    </eb.ErrorBoundary>,
  );
  expect(page.text()).toContain("view body");
  expect(page.one('[data-testid="boundary-item"]')).not.toBeNull();
  expect(page.one('[data-testid="boundary-view"]')).toBeNull();
  expect(page.one('[data-testid="boundary-root"]')).toBeNull();
});

test("a failure in a fallback's own parent view falls to the next boundary up", async () => {
  const page = await env.mount(
    <eb.ErrorBoundary scope="root" name="Walkie dashboard"><eb.ErrorBoundary scope="view" name="Asks"><Boom message="view-level" /></eb.ErrorBoundary></eb.ErrorBoundary>,
  );
  expect(page.one('[data-testid="boundary-view"]')).not.toBeNull();
  expect(page.one('[data-testid="boundary-root"]')).toBeNull();
});

test("describeError copes with anything that can be thrown", () => {
  expect(eb.describeError(new Error("plain")).message).toBe("plain");
  expect(eb.describeError(new TypeError("typed")).stack).toContain("TypeError");
  expect(eb.describeError("just a string").message).toBe("just a string");
  expect(eb.describeError(null).message.length).toBeGreaterThan(0);
  expect(eb.describeError(undefined).message.length).toBeGreaterThan(0);
  expect(eb.describeError({ code: 7 }).message.length).toBeGreaterThan(0);
  const hostile = { get message(): string { throw new Error("no"); }, toString(): string { throw new Error("no"); } };
  expect(eb.describeError(hostile).message.length).toBeGreaterThan(0);
  expect(eb.describeError(new Error("x".repeat(5_000))).message.length).toBeLessThan(600); // a long message is cut
  expect(eb.describeError(new Error("")).message.length).toBeGreaterThan(0); // an empty one says what it was
});

test("things that are not Errors can be thrown into a boundary too", async () => {
  function ThrowsString(): ReactNode { throw "a plain string"; }
  function ThrowsNull(): ReactNode { throw null; }
  const page = await env.mount(
    <div>
      <eb.ErrorBoundary scope="item" name="s"><ThrowsString /></eb.ErrorBoundary>
      <eb.ErrorBoundary scope="item" name="n"><ThrowsNull /></eb.ErrorBoundary>
      <span>alive</span>
    </div>,
  );
  expect(count(page.text(), ITEM)).toBe(2);
  expect(page.text()).toContain("alive");
  expect(env.uncaught).toEqual([]);
});

// ---- the real components --------------------------------------------------------------------------------------------

const NOW = Date.now();
const NODE: NodeView = { node_id: "n1", handle: "maren", hostname: "maren-mbp", ip: "100.64.0.1", online: true, last_seen: NOW, rtt_ms: 3, self: true, sync: { behind: 0, last_sync: NOW } };
const TEAM: TeamView = {
  id: "t", name: "harbor", authority: "n1", channels: [{ name: "general", last_ts: NOW, count: 3 }], nodes: [NODE], plan: undefined as never,
  members: [{ login: "maren@x", handle: "maren", role: "owner", display_name: "Maren Holt" }],
};
const agent = (name: string, st: AgentState, title: string): AgentView => ({
  id: `maren/maren-mbp/${name}`, handle: "maren", node: "n1", hostname: "maren-mbp", agent: name,
  status: { agent: name, state: st, runtime: "claude-code", title }, updated_at: NOW - 5_000, machine_online: true, effective_state: st, archived: false,
});
const ME = {
  version: "x", protocol: 1, team: { id: "t", name: "harbor" }, node: { id: "n1", hostname: "maren-mbp", ip: "100.64.0.1", port: 7458 }, handle: "maren", role: "owner",
  tailscale: { ok: false, login: null }, plan: null,
} as unknown as NonNullable<State["me"]>;
const state = (over: Partial<State>): State => ({ ...initialState, phase: "ready", team: TEAM, nodes: [NODE], me: ME, ...over });
/** A card whose title is a shape no daemon sends: React cannot draw an object as text, so its card throws while rendering. */
const oddTitle = { text: "not a string" } as unknown as string;
const quietFetch = () => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/v1/stream")) return Promise.resolve(new Response(new ReadableStream({ start() {} })));
    return Promise.resolve(Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 }));
  }) as typeof fetch;
};

test("Mission Control: an agent card that cannot render is replaced by the small message; the other cards and the page stay", async () => {
  quietFetch();
  const odd = agent("seat-odd", "working", "x");
  const agents = [agent("seat-1", "working", "Build the archive view"), { ...odd, status: { ...odd.status, title: oddTitle } }, agent("seat-3", "working", "Fix the ledger")];
  const page = await env.mount(<StaticStore state={state({ agents })}><MissionControl /></StaticStore>);
  await settle();
  expect(page.one("h1.page-title")?.textContent).toBe("Mission Control");
  expect(page.text()).toContain("Build the archive view");
  expect(page.text()).toContain("Fix the ledger");
  expect(count(page.text(), ITEM)).toBe(1);
  expect(page.all("button.agent-card")).toHaveLength(2);
  expect(env.uncaught).toEqual([]);
});

test("Mission Control: the broken card is tried again when its data changes", async () => {
  quietFetch();
  const odd = agent("seat-odd", "working", "x");
  const broken = { ...odd, status: { ...odd.status, title: oddTitle } };
  const fixed = { ...odd, status: { ...odd.status, title: "Back to normal" }, updated_at: NOW };
  const page = await env.mount(<StaticStore state={state({ agents: [broken, agent("seat-1", "working", "Build the archive view")] })}><MissionControl /></StaticStore>);
  await settle();
  expect(count(page.text(), ITEM)).toBe(1);
  await page.render(<StaticStore state={state({ agents: [fixed, agent("seat-1", "working", "Build the archive view")] })}><MissionControl /></StaticStore>);
  await settle();
  expect(page.text()).not.toContain(ITEM);
  expect(page.text()).toContain("Back to normal");
});

test("Mission Control archive: a broken row leaves the other archived agents visible and recovers with new data", async () => {
  quietFetch();
  go("#/mission?tab=archive");
  const base = agent("archived-odd", "idle", "x");
  const broken = { ...base, status: { ...base.status, title: oddTitle } };
  const healthy = agent("archived-ok", "idle", "Finished the guide");
  const render = (item: AgentView) => <StaticStore state={state({ agents: [item, healthy] })}><MissionControl /></StaticStore>;
  const page = await env.mount(render(broken));
  await settle();
  expect(env.uncaught).toEqual([]);
  expect(page.text()).toContain("Finished the guide");
  expect(page.all("button.archive-row")).toHaveLength(1);
  expect(page.one('li[data-testid="boundary-item"]')).not.toBeNull();
  await page.render(render({ ...base, status: { ...base.status, title: "Archive row recovered" } }));
  expect(page.text()).toContain("Archive row recovered");
  expect(page.all("button.archive-row")).toHaveLength(2);
  expect(page.one('[data-testid="boundary-item"]')).toBeNull();
});

test("Mission Control tolerates old peers without optional status fields and an unfamiliar runtime", async () => {
  quietFetch();
  const base = agent("new-runtime", "working", "x");
  const sparse = { ...base, status: { agent: base.agent, state: "working", runtime: "future-runtime" } } as unknown as AgentView;
  const page = await env.mount(<StaticStore state={state({ agents: [sparse] })}><MissionControl /></StaticStore>);
  await settle();
  expect(env.uncaught).toEqual([]);
  expect(page.all("button.agent-card")).toHaveLength(1);
  expect(page.text()).toContain("No status title");
  expect(page.text()).toContain("No activity yet");
  expect(page.one('[data-testid="boundary-item"]')).toBeNull();
});

test("Archive search skips malformed title data and preserves healthy matching rows and the view", async () => {
  quietFetch();
  go("#/mission?tab=archive");
  const odd = agent("archived-odd", "idle", "x");
  const broken = { ...odd, status: { ...odd.status, title: oddTitle } };
  const healthy = agent("archived-ok", "idle", "Finished the guide");
  const page = await env.mount(<StaticStore state={state({ agents: [broken, healthy] })}><App /></StaticStore>);
  await settle();
  expect(page.all("button.archive-row")).toHaveLength(1);
  expect(page.one('li[data-testid="boundary-item"]')).not.toBeNull();
  const search = page.one('input[type="search"]') as MiniElement;
  expect(search).not.toBeNull();
  await page.fill(search, "guide");
  expect(search.value).toBe("guide");
  expect(page.one('[data-testid="archive-view"]')).not.toBeNull();
  expect(page.one('[data-testid="boundary-view"]')).toBeNull();
  expect(page.text()).toContain("Finished the guide");
  expect(page.all("button.archive-row")).toHaveLength(1);
  expect(page.one('[data-testid="boundary-item"]')).toBeNull();
  await page.fill(search, "no-match");
  expect(page.text()).toContain("Nothing in the archive matches");
  expect(page.one('[data-testid="boundary-view"]')).toBeNull();
  expect(env.uncaught).toEqual([]);
});

test("Mission Control: a sub-agent row that cannot render does not take its session's card with it", async () => {
  quietFetch();
  const parent = agent("cc-1", "working", "Orchestrate the release");
  const sub = (id: string, title: string): AgentView => {
    const a = agent(`cc-1.${id}`, "working", title);
    return { ...a, status: { ...a.status, parent: "cc-1", subagent_type: "Explore" } };
  };
  const badSub = sub("bbbbbbbbbbbb", "x");
  const agents = [{ ...parent, subagents: { working: 2, live: 2 } }, sub("aaaaaaaaaaaa", "Search the repo"), { ...badSub, status: { ...badSub.status, title: oddTitle } }];
  const page = await env.mount(<StaticStore state={state({ agents })}><MissionControl /></StaticStore>);
  await settle();
  expect(page.text()).toContain("Orchestrate the release");
  expect(page.text()).toContain("Search the repo");
  expect(count(page.text(), ITEM)).toBe(1);
});

const statusEvent = (id: string, ts: number, agentName: string, st: AgentState, title: unknown, author: unknown = { handle: "maren", node: "n1", agent: agentName }) => ({
  id, origin: "n1", seq: 1, ts, v: 1, team: "t", author, kind: "agent.status", body: { agent: agentName, state: st, runtime: "claude-code", title }, sig: "s",
});

test("Mission Control: a live-activity entry that cannot render is replaced by the small message; the other entries and the page stay", async () => {
  quietFetch();
  // Newest first, as the store keeps them. Each agent's first status is an appearance; its second is a change the feed shows.
  const events = [
    statusEvent("e4", NOW - 1_000, "seat-8", "working", "Wrote the tests"), statusEvent("e3", NOW - 2_000, "seat-9", "working", oddTitle),
    statusEvent("e2", NOW - 50_000, "seat-8", "idle", "Waiting"), statusEvent("e1", NOW - 60_000, "seat-9", "idle", "Waiting"),
  ];
  const page = await env.mount(<StaticStore state={state({ events: events as unknown as State["events"] })}><MissionControl /></StaticStore>);
  await settle();
  expect(page.one("h1.page-title")?.textContent).toBe("Mission Control");
  const feed = page.one("section.feed-rail") as MiniElement;
  expect(feed.textContent).toContain("Live activity");
  expect(feed.textContent).toContain("Wrote the tests");
  expect(count(feed.textContent, ITEM)).toBe(1);
  expect(env.uncaught).toEqual([]);
});

test("Mission Control: events the activity feed cannot even build leave the feed's own message and keep the rest of the page", async () => {
  quietFetch();
  const events = [statusEvent("e1", NOW - 1_000, "seat-9", "working", "x", null)]; // no author at all
  const page = await env.mount(<StaticStore state={state({ events: events as unknown as State["events"], agents: [agent("seat-1", "working", "Build the archive view")] })}><MissionControl /></StaticStore>);
  await settle();
  expect(page.one("h1.page-title")?.textContent).toBe("Mission Control");
  expect(page.text()).toContain("Build the archive view");
  const feed = page.one("section.feed-rail") as MiniElement;
  expect(feed.textContent).toContain("Live activity");
  expect(count(feed.textContent, ITEM)).toBe(1);
  expect(env.uncaught).toEqual([]);
});

const column = (id: string, role: Column["role"], name: string): Column => ({ id, role, name });
const card = (n: number, title: string): CardView => ({
  id: `c${n}`, channel: "p-aaaaaaaa", board: "b1", key: `WALK-${n}`, n, short: `0000000${n}`, ref: `WALK-${n}-0000000${n}`, title, body: "", column: "todo", pos: `${n}`,
  assignee: null, reviewer: null, labels: [], estimate: null, due: null, blocked: false, blocked_reason: null, state: "open",
  created_at: NOW, created_by: { handle: "maren", node: "n1" }, updated_at: NOW, updated_by: { handle: "maren", node: "n1" }, comments: 0, rev: 1,
});
const noop = () => {};

test("board: a card that cannot render is replaced by the small message; the other cards and the columns stay", async () => {
  const broken = { ...card(2, "x"), title: oddTitle };
  const columns = [
    { column: column("todo", "todo", "To do"), cards: [card(1, "Write the guide"), broken, card(3, "Ship the build")], total: 3 },
    { column: column("done", "done", "Done"), cards: [card(4, "Cut the release")], total: 1 },
  ];
  const page = await env.mount(
    <Kanban
      columns={columns} byCard={new Map()} focus={null} selected={new Set()} openCard={null} composerFor={null} phoneCol={0}
      onPhoneCol={noop} onOpen={noop} onMove={noop} onCompose={noop} onCreate={async () => true} onFocus={noop}
    />,
  );
  expect(page.text()).toContain("To do");
  expect(page.text()).toContain("Write the guide");
  expect(page.text()).toContain("Ship the build");
  expect(page.text()).toContain("Cut the release");
  expect(count(page.text(), ITEM)).toBe(1);
  expect(page.all("article.kcard")).toHaveLength(3);
  expect(env.uncaught).toEqual([]);
});

test("channel board: a message that cannot render is replaced by the small message; the others and the composer stay", async () => {
  const ev = (id: string, ts: unknown, text: string, handle = "maren") => ({
    id, origin: "n1", seq: 1, ts, v: 1, team: "t", author: { handle, node: "n1" }, kind: "msg.post", channel: "general", body: { text }, sig: "s",
  });
  // Messages from three people, so none is folded under the previous one. The middle one carries a timestamp nothing can format.
  const events = [ev("e1", NOW - 3_000, "first message", "maren"), ev("e2", "not-a-time", "second message", "lena"), ev("e3", NOW - 1_000, "third message", "omar")];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/v1/events")) return Promise.resolve(Response.json({ events }));
    if (path.startsWith("/v1/stream")) return Promise.resolve(new Response(new ReadableStream({ start() {} })));
    return Promise.resolve(Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 }));
  }) as typeof fetch;
  go("#/board/general");
  const page = await env.mount(<StaticStore state={state({})}><Board /></StaticStore>);
  await until(() => page.text().includes("third message"));
  expect(page.text()).toContain("first message");
  expect(count(page.text(), ITEM)).toBe(1);
  expect(page.text()).not.toContain("second message");
  expect(page.one("textarea")).not.toBeNull();
  expect(env.uncaught).toEqual([]);
});

test("a view that throws leaves the shell; going to another view brings the app back", async () => {
  quietFetch();
  const project = {
    channel: "p-aaaaaaaa", id: "p-aaaaaaaa:1", name: { text: "not a string" }, prefix: "WALK", paths: [], folder: "", description: "", meter_mode: "count",
    meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } },
    automations: {}, state: "active", steward: "off", steward_node: "", private: false, admins: [], creator: "maren", created_at: 0,
    boards: [{ id: "b1", name: "Main", state: "active", columns: [column("todo", "todo", "To do")], meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } } }],
    cards: 0, last_activity: 0,
  };
  projectsStore.set({ status: "ready", error: null, projects: [project as never], stubs: [], cards: { "p-aaaaaaaa": [] }, cardsError: {}, rooms: {}, roomsError: {} });
  try {
    go("#/projects/p-aaaaaaaa");
    const page = await env.mount(<StaticStore state={state({})}><App /></StaticStore>);
    await settle();
    expect(page.one("aside.rail")).not.toBeNull(); // the shell is still there
    expect(page.one("nav.rail-nav")?.textContent).toContain("Mission Control");
    const view = page.one('[data-testid="boundary-view"]') as MiniElement;
    expect(view).not.toBeNull();
    expect(view.textContent).toContain("Projects");
    expect(page.one("main.main")?.textContent).toContain(ITEM);
    expect(env.uncaught).toEqual([]);
    await nav("#/mission");
    await settle();
    expect(page.one('[data-testid="boundary-view"]')).toBeNull();
    expect(page.one("h1.page-title")?.textContent).toBe("Mission Control");
  } finally {
    projectsStore.set({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  }
});

test("the agent drawer has its own boundary: a broken drawer does not take the page with it", async () => {
  quietFetch();
  const odd = agent("seat-odd", "working", "x");
  const broken = { ...odd, status: { ...odd.status, title: oddTitle } };
  go(`#/mission?agent=${encodeURIComponent(broken.id)}`);
  const page = await env.mount(<StaticStore state={state({ agents: [broken, agent("seat-1", "working", "Build the archive view")] })}><App /></StaticStore>);
  await settle();
  expect(page.one("aside.rail")).not.toBeNull();
  expect(page.text()).toContain("Build the archive view");
  expect(page.one('[data-testid="boundary-root"]')).toBeNull();
  expect(env.uncaught).toEqual([]);
});

/** The daemon answers as it would for a team with one machine; `channels` is left out of /v1/team when `poison` is set. */
function daemon(poison: boolean): void {
  const team = { id: "t", name: "harbor", members: TEAM.members, nodes: [NODE], authority: "n1", ...(poison ? {} : { channels: [] }) };
  const routes: Record<string, unknown> = {
    "/v1/me": ME, "/v1/team": team, "/v1/agents": { agents: [], archive: [] }, "/v1/peers": { nodes: [NODE] },
    "/v1/events": { events: [] }, "/v1/asks": { asks: [] }, "/v1/accounts": { accounts: [] }, "/v1/projects": { projects: [], stubs: [] },
  };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/v1/stream")) return Promise.resolve(new Response(new ReadableStream({ start() {} })));
    const body = routes[path.split("?")[0] as string];
    return Promise.resolve(body ? Response.json(body) : Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 }));
  }) as typeof fetch;
}

test("root: the app itself starts and shows Mission Control from a well-formed daemon answer (control for the next test)", async () => {
  daemon(false);
  const page = await env.mount(<Root />);
  await until(() => page.one("h1.page-title") !== null);
  expect(page.one("h1.page-title")?.textContent).toBe("Mission Control");
  expect(page.one('[data-testid="boundary-root"]')).toBeNull();
  expect(env.uncaught).toEqual([]);
});

test("root: an answer the store cannot fold (the team without its channels) shows the plain error screen, not a white page", async () => {
  daemon(true);
  (testWindow.location as { reload?: () => void }).reload = () => {};
  const page = await env.mount(<Root />);
  await until(() => page.one('[data-testid="boundary-root"]') !== null || env.uncaught.length > 0);
  expect(env.uncaught).toEqual([]);
  expect(page.one("h1")?.textContent).toBe("Walkie's dashboard hit an error");
  expect(page.all("button").some((b) => b.textContent === "Reload")).toBe(true);
  expect(page.text()).toContain("Back to Mission Control");
  expect(logged()).toHaveLength(1);
});
