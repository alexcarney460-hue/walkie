// WALK-75 Simple mode. The view module does not exist on grok-base, so this file fails there before any assertion.
import { act } from "react";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { ApiError } from "../src/api/client.ts";
import type { AgentView, AskView, CardView, Column, Event, ProjectView, TimelineEntry } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { installDom, type DomEnv, type MiniElement, type Mounted } from "./mini-dom.ts";
import { go, hashAssignNotifies, testWindow } from "./window-stub.ts";

let env: DomEnv;
let SimpleBoard: typeof import("../src/views/simple/SimpleBoard.tsx").SimpleBoard;
let lib: typeof import("../src/lib/simple-board.ts");
let api: typeof import("../src/api/client.ts").api;
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let initialState: State;

const NODE = "aaaaaaaaaaaaaaaa";
const author = { handle: "alex", node: NODE };
const columns: Column[] = [
  { id: "backlog", name: "Backlog", role: "backlog" },
  { id: "todo", name: "To do", role: "todo" },
  { id: "doing", name: "In progress", role: "active" },
  { id: "review", name: "In review", role: "review" },
  { id: "done", name: "Done", role: "done" },
  { id: "cancelled", name: "Cancelled", role: "cancelled" },
];

function project(name: string, channel: string, state: ProjectView["state"]): ProjectView {
  return {
    channel, id: `${NODE}:1`, name, folder: "", description: "", prefix: "WEB", paths: [],
    meter_mode: "count", automations: { pr_opened: false, pr_merged: false, agents_can_close: true },
    state, steward: "on", steward_node: "", status_report: "off", private: false, admins: [], creator: "alex",
    created_at: 0, boards: [{
      id: "board-main", name: "Main", columns, state: "active", created_at: 0, created_by: author,
      meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } },
      live_cards: 0,
    }],
    meter: { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } },
    cards: 0, last_activity: 0,
  };
}

const website = project("Website", "p-0000000a", "active");
website.boards.push({
  id: "board-old", name: "Old", columns, state: "archived", created_at: 0, created_by: author,
  meter: website.boards[0]!.meter, live_cards: 0,
});
const archived = project("Archive shelf", "p-0000000b", "archived");

function card(partial: Partial<CardView> & Pick<CardView, "id" | "title" | "column" | "n">): CardView {
  return {
    channel: "p-0000000a", board: "board-main", key: `WEB-${partial.n}`, short: "abcd1234", ref: `WEB-${partial.n}-abcd1234`,
    body: "", pos: "m", assignee: "@alex", reviewer: null, labels: [], estimate: null, due: null, blocked: false, blocked_reason: null,
    state: "open", created_at: 1, created_by: author, updated_at: 1, updated_by: author, comments: 0, rev: 1,
    ...partial,
  };
}

const welcome = card({ id: "c-welcome", title: "Write the welcome note", column: "todo", n: 4, pos: "a", labels: ["launch"], estimate: 13, due: "2026-10-10" });
const draw = card({ id: "c-draw", title: "Draw the map", column: "doing", n: 2, pos: "b", assignee: "@bea" });
const check = card({ id: "c-check", title: "Check the homepage", column: "review", n: 3, pos: "c", assignee: "@bea", reviewer: "@alex" });
const publish = card({ id: "c-publish", title: "Publish the notes", column: "done", n: 5, pos: "d" });
const merger = card({ id: "c-merger", title: "Merger plan", column: "todo", n: 9, key: "WEB-9", ref: "WEB-9-abcd1234", labels: ["confidential"] });
const drop = card({ id: "c-drop", title: "Drop the old banner", column: "cancelled", n: 7, pos: "e" });
const pick = card({ id: "c-pick", title: "Pick the sign-in", column: "todo", n: 6, pos: "f", labels: ["decision-needed"] });
const shelf = card({ id: "c-shelf", title: "Shelf only", column: "todo", n: 1, channel: "p-0000000b" });
const oldBoard = card({ id: "c-oldboard", title: "Old board note", column: "todo", n: 15, board: "board-old" });
const buried = card({ id: "c-buried", title: "Buried welcome draft", column: "todo", n: 40, pos: "z" });
const buriedReview = card({ id: "c-buried-review", title: "Buried sign-off", column: "review", n: 41, pos: "y", assignee: "@bea", reviewer: "@alex" });

const alexAgent: AgentView = {
  id: "alex/host/cc-9", handle: "alex", node: NODE, hostname: "host", agent: "cc-9",
  status: { agent: "cc-9", state: "working", runtime: "other", task: "WEB-4" },
  updated_at: 1, machine_online: true, effective_state: "working", archived: false,
};
const oliveAgent: AgentView = {
  id: "olive/host/oo-1", handle: "olive", node: "cccccccccccccccc", hostname: "host", agent: "oo-1",
  status: { agent: "oo-1", state: "idle", runtime: "other", ask_policy: "human" },
  updated_at: 1, machine_online: true, effective_state: "idle", archived: false,
};

function ask(id: string, to: string, text: string, who: { handle: string; agent?: string }, expires: number): AskView {
  const event = {
    v: 1, team: "0123456789abcdef", id, origin: "bbbbbbbbbbbbbbbb", seq: 1, ts: 1,
    author: { handle: who.handle, node: "bbbbbbbbbbbbbbbb", ...(who.agent ? { agent: who.agent } : {}) },
    kind: "ask", body: { to, text, expires_at: expires }, sig: "c2ln",
  } as Event;
  return { ask: event, answers: [], state: "open", expires_at: expires };
}

const now = Date.UTC(2026, 9, 2);
// Open asks expire: a day past the later of the fixture day and the real clock, so the asks stay open whenever this runs.
const later = Math.max(now, Date.now()) + 86_400_000;
const beaAsk = ask("bbbbbbbbbbbbbbbb:1", "@alex", "Should we publish the welcome note?", { handle: "bea" }, later);
const oliveAsk = ask("bbbbbbbbbbbbbbbb:2", "@olive/host/oo-1", "Can the agent ship the notes?", { handle: "olive", agent: "oo-1" }, later);
const leakAsk = ask("bbbbbbbbbbbbbbbb:3", "@alex", "What about Merger plan?", { handle: "maren" }, later);
const otherAsk = ask("bbbbbbbbbbbbbbbb:4", "@bea", "Ship the footer?", { handle: "bea" }, later);
const expiredAsk = ask("bbbbbbbbbbbbbbbb:5", "@alex", "Is the banner ready?", { handle: "bea" }, now - 1_000);

const welcomeTimeline: TimelineEntry[] = [
  { id: "t1", ts: 1, author: { handle: "alex", node: NODE }, kind: "create" },
  { id: "t2", ts: 2, author: { handle: "bea", node: "bbbbbbbbbbbbbbbb", agent: "cc-9" }, kind: "comment", text: "Please see WEB-4 and tell the agent" },
  { id: "t3", ts: 3, author: { handle: "alex", node: NODE }, kind: "op", changes: { column: "review" } },
  { id: "t4", ts: 4, author: { handle: "alex", node: NODE }, kind: "op", changes: { labels: ["launch"] } },
];

interface World {
  cards: CardView[];
  projects: ProjectView[];
  stubs: ProjectView[];
  asks: AskView[];
  agents: AgentView[];
  truncated: boolean;
  mineTruncated: boolean;
  reviewTruncated: boolean;
  hang: boolean;
  fail: boolean;
  activityFail: boolean;
  commentError: Error | null;
  actionError: Error | null;
  updateError: Error | null;
  taskCalls: string[];
  taskQueries: Array<Record<string, unknown>>;
  extraMine: CardView[];
  extraReview: CardView[];
  updateCalls: Array<[string, Record<string, unknown>]>;
  commentCalls: Array<[string, string]>;
  actionCalls: Array<[string, string]>;
  answerCalls: Array<{ ask: string; text: string; declined?: boolean }>;
}

function freshWorld(): World {
  return {
    cards: [welcome, draw, check, publish, merger, drop, pick, shelf, oldBoard],
    projects: [website, archived],
    stubs: [],
    asks: [beaAsk, oliveAsk, leakAsk, otherAsk, expiredAsk],
    agents: [alexAgent, oliveAgent],
    truncated: false, mineTruncated: false, reviewTruncated: false, hang: false, fail: false, activityFail: false,
    commentError: null, actionError: null, updateError: null,
    taskCalls: [], taskQueries: [], extraMine: [], extraReview: [], updateCalls: [], commentCalls: [], actionCalls: [], answerCalls: [],
  };
}

let world = freshWorld();

const PROTO_KEYS = ["focus", "querySelector", "scrollIntoView"] as const;
let protoSaved: Array<{ key: (typeof PROTO_KEYS)[number]; desc: PropertyDescriptor | undefined }> = [];
let lastFocused: MiniElement | null = null;

function installApi(): void {
  const gate = async <T,>(value: T): Promise<T> => {
    if (world.hang) return new Promise<T>(() => {});
    if (world.fail) throw new ApiError("synthetic", "Synthetic failure", 503);
    return value;
  };
  api.projects = () => gate({ projects: world.projects, stubs: [] });
  api.tasks = (p = {}) => {
    world.taskQueries.push({ ...p });
    let tasks = world.cards;
    if (p.assignee === "me") tasks = [...tasks.filter((c) => c.assignee === "@alex" || !!c.assignee?.startsWith("@alex/")), ...world.extraMine];
    else if (typeof p.role === "string" && p.role.split(",").includes("review")) tasks = [...tasks.filter((c) => c.column === "review"), ...world.extraReview];
    const teamQuery = p.assignee === undefined && p.role === undefined;
    const mineQuery = p.assignee === "me";
    const reviewQuery = typeof p.role === "string" && p.role.split(",").includes("review");
    const truncated = (teamQuery && world.truncated) || (mineQuery && world.mineTruncated) || (reviewQuery && world.reviewTruncated);
    return gate({ tasks, total: tasks.length, truncated, projects: [] });
  };
  api.asks = () => gate({ asks: world.asks });
  api.task = async (ref: string) => {
    world.taskCalls.push(ref);
    if (world.activityFail && ref === welcome.id) throw new ApiError("synthetic", "Synthetic activity failure", 503);
    const found = world.cards.find((c) => c.id === ref) ?? welcome;
    return { card: found, project: website, timeline: ref === welcome.id ? welcomeTimeline : [], agents: [] };
  };
  api.updateTask = async (ref, body) => {
    world.updateCalls.push([ref, body]);
    if (world.updateError) throw world.updateError;
    const found = world.cards.find((c) => c.id === ref) ?? welcome;
    return { task: { ...found, ...body } };
  };
  api.commentTask = async (ref, text) => {
    world.commentCalls.push([ref, text]);
    if (world.commentError) throw world.commentError;
    const found = world.cards.find((c) => c.id === ref) ?? welcome;
    return { event: beaAsk.ask, task: { ...found } };
  };
  api.taskDone = async (ref) => {
    world.actionCalls.push([ref, "done"]);
    if (world.actionError) throw world.actionError;
    const found = world.cards.find((c) => c.id === ref) ?? welcome;
    return { task: { ...found, column: "done", blocked: false } };
  };
  api.answer = async (body) => {
    world.answerCalls.push(body);
    return { event: beaAsk.ask };
  };
}

beforeAll(async () => {
  env = await installDom();
  const proto = HTMLElement.prototype;
  protoSaved = PROTO_KEYS.map((key) => ({ key, desc: Object.getOwnPropertyDescriptor(proto, key) }));
  Object.assign(proto, {
    focus() { lastFocused = this as unknown as MiniElement; },
    querySelector: () => null,
    scrollIntoView() {},
  });
  hashAssignNotifies(true);
  go("#/simple");
  const [view, simple, client, store, reducer] = await Promise.all([
    import("../src/views/simple/SimpleBoard.tsx"),
    import("../src/lib/simple-board.ts"),
    import("../src/api/client.ts"),
    import("../src/state/store.tsx"),
    import("../src/state/reducer.ts"),
  ]);
  SimpleBoard = view.SimpleBoard;
  lib = simple;
  api = client.api;
  StaticStore = store.StaticStore;
  initialState = reducer.initialState;
});

afterAll(async () => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  for (const { key, desc } of protoSaved) {
    if (desc) Object.defineProperty(proto, key, desc);
    else delete proto[key];
  }
  await env.restore();
  hashAssignNotifies(false);
  go("#/mission");
});

beforeEach(() => {
  world = freshWorld();
  installApi();
  lastFocused = null;
  go("#/simple");
});

function boardState(role: "owner" | "observer" = "owner"): State {
  return {
    ...initialState, phase: "ready",
    me: {
      version: "0", protocol: 1, handle: "alex", role,
      team: { id: "0123456789abcdef", name: "Northwind" },
      node: { id: NODE, hostname: "host", ip: "127.0.0.1", port: 1 },
      tailscale: { ok: false, login: null }, plan: null,
    },
    team: {
      id: "0123456789abcdef", name: "Northwind", authority: null, nodes: [], channels: [],
      plan: null as unknown as State["team"] extends infer T ? T extends { plan: infer P } ? P : never : never,
      members: [
        { login: "alex@example.com", handle: "alex", role: "owner", display_name: "Alex" },
        { login: "bea@example.com", handle: "bea", role: "member", display_name: "Bea" },
        { login: "olive@example.com", handle: "olive", role: "member", display_name: "Olive" },
        { login: "maren@example.com", handle: "maren", role: "member", display_name: "Maren" },
      ],
    },
    agents: world.agents,
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function until(page: Mounted, cond: () => boolean, ms = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (env.uncaught.length) throw env.uncaught[0];
    if (Date.now() - start > ms) throw new Error(`timed out. page text: ${page.text().slice(0, 500)}`);
    await settle();
  }
}

async function render(role: "owner" | "observer" = "owner"): Promise<Mounted> {
  return env.mount(<StaticStore state={boardState(role)}><SimpleBoard /></StaticStore>);
}

function labeled(page: Mounted, label: string): MiniElement {
  const el = page.all("[aria-label]").find((e) => e.getAttribute("aria-label") === label);
  if (!el) throw new Error(`missing aria-label ${label}\n${page.text().slice(0, 400)}`);
  return el;
}

function byText(page: Mounted, tag: string, text: string): MiniElement {
  const el = page.all(tag).find((e) => e.textContent.trim() === text);
  if (!el) throw new Error(`missing ${tag} ${text}`);
  return el;
}

async function press(page: Mounted, target: MiniElement, key: string): Promise<void> {
  const event = {
    type: "keydown", key, target, srcElement: target, currentTarget: page.container, bubbles: true, cancelable: true,
    defaultPrevented: false, timeStamp: Date.now(),
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {},
  };
  await act(async () => { for (const fn of page.container.listenersFor("keydown")) fn(event); });
}

async function openCard(page: Mounted, title: string): Promise<void> {
  const button = page.all("button.simple-card").find((b) => b.textContent.includes(title));
  if (!button) throw new Error(`no card ${title}`);
  await page.click(button);
  await until(page, () => page.one("[role=dialog]") !== null);
}

test("plain status names and the three blocks hide keys, labels, estimates, and the word agent", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Write the welcome note"));
  const text = page.text();
  const my = page.one('[data-block="my-work"]')!.textContent;
  const decisions = page.one('[data-block="decisions"]')!.textContent;
  const team = page.one('[data-block="team"]')!.textContent;
  expect(page.one("h1")?.textContent).toBe("Simple");
  expect(page.one("h2")?.textContent).toBe("My work");
  expect(my.indexOf("Write the welcome note")).toBeLessThan(my.indexOf("Publish the notes"));
  expect(my).not.toContain("Pick the sign-in");
  expect(my).not.toContain("Check the homepage");
  expect(decisions.indexOf("Pick the sign-in")).toBeLessThan(decisions.indexOf("Check the homepage"));
  expect(decisions.indexOf("Check the homepage")).toBeLessThan(decisions.indexOf("Should we publish the welcome note?"));
  expect(decisions).not.toContain("Can the assistant ship the notes?");
  expect(decisions).not.toContain("Olive's assistant");
  expect(decisions).not.toContain("?, from");
  expect(decisions).toContain("? From ");
  expect(team).toContain("Website");
  expect(team).toContain("To do 2");
  expect(team).toContain("Working on 1");
  expect(team).toContain("Waiting for review 1");
  expect(team).toContain("Done 1");
  expect(team).toContain("Your assistant is working.");
  expect(text).toContain("Work marked confidential is left off this page.");
  for (const hidden of ["Draw the map", "Drop the old banner", "Merger plan", "Shelf only", "Old board note", "Archive shelf", "WEB-", "cc-9", "launch", "13", "decision-needed", "Backlog", "In progress", "In review", "Cancelled", "p-0000000", "Main"]) {
    expect(text).not.toContain(hidden);
  }
  expect(text).not.toMatch(/\bagents?\b/i);
  expect(page.html()).not.toContain("draggable");
  expect(page.text()).toContain("Move to:");
  expect(page.text()).toContain("To do, current");
  expect(page.all("button").some((b) => b.getAttribute("aria-label") === "Already in To do")).toBe(false);
  expect(labeled(page, "Move Write the welcome note to Working on").getAttribute("disabled")).toBeNull();
  const welcomeBtn = page.all("button.simple-card").find((b) => b.textContent.includes("Write the welcome note"));
  const publishBtn = page.all("button.simple-card").find((b) => b.textContent.includes("Publish the notes"));
  expect(welcomeBtn?.getAttribute("aria-label")).toContain("due October 10, 2026");
  expect(welcomeBtn?.getAttribute("aria-label")).not.toContain("due No");
  expect(publishBtn?.getAttribute("aria-label")).toContain("no due date");
  expect(publishBtn?.getAttribute("aria-label")).not.toContain("due No");
  expect(page.html()).not.toContain("aria-current");
  expect(page.one("[data-cursor=true]")).not.toBeNull();
  await page.unmount();
});

test("Move to calls updateTask with only the column", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Write the welcome note"));
  await page.click(labeled(page, "Move Write the welcome note to Working on"));
  await until(page, () => page.text().includes("Write the welcome note, Working on"));
  expect(world.updateCalls).toEqual([[welcome.id, { column: "doing" }]]);
  expect(world.actionCalls).toEqual([]);
  const card = page.all("button.simple-card").find((b) => b.getAttribute("aria-label")?.includes("Write the welcome note"));
  expect(card?.getAttribute("aria-label")).toContain("Working on");
  await page.unmount();
});

test("loading, empty, and error states", async () => {
  world.hang = true;
  const loading = await render();
  expect(loading.text()).toContain("Loading your work…");
  expect(loading.text()).toContain("Loading decisions…");
  expect(loading.text()).toContain("Loading team status…");
  expect(loading.one(".simple")?.getAttribute("aria-busy")).toBe("true");
  expect(loading.text()).not.toContain("Write the welcome note");
  await loading.unmount();

  world = freshWorld();
  world.fail = true;
  installApi();
  const broken = await render();
  await until(broken, () => broken.text().includes("Synthetic failure"));
  expect(broken.all('[role="alert"]').length).toBeGreaterThan(0);
  for (const block of ["my-work", "decisions", "team"]) expect(broken.one(`[data-block="${block}"]`)!.textContent).toContain("Synthetic failure");
  world.fail = false;
  await broken.click(broken.all("button").find((b) => b.textContent.trim() === "Retry")!);
  await until(broken, () => broken.text().includes("Write the welcome note"));
  await broken.unmount();

  world = freshWorld();
  world.cards = [];
  world.projects = [];
  world.asks = [];
  world.agents = [];
  installApi();
  const empty = await render();
  await until(empty, () => empty.text().includes("Nothing is assigned to you."));
  expect(empty.text()).toContain("Nothing needs your decision.");
  expect(empty.text()).toContain("No projects yet.");
  await empty.unmount();

  world = freshWorld();
  world.cards = [];
  world.projects = [website];
  world.asks = [];
  world.agents = [];
  installApi();
  const zeros = await render();
  await until(zeros, () => zeros.text().includes("Website"));
  const team = zeros.one('[data-block="team"]')!.textContent;
  expect(team).toContain("Working on 0");
  expect(team).toContain("No assistants are working right now.");
  expect(team).not.toContain("No projects yet.");
  await zeros.unmount();
});

test("a failed refresh keeps the cards", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Write the welcome note"));
  world.fail = true;
  await page.click(byText(page, "button", "Refresh"));
  await until(page, () => page.text().includes("Synthetic failure"));
  expect(page.text()).toContain("Write the welcome note");
  await page.unmount();
});

test("keyboard opens the second card and Escape returns", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Publish the notes"));
  const section = page.one('[data-block="my-work"]')!;
  await press(page, section, "ArrowDown");
  await press(page, section, "Enter");
  await until(page, () => page.text().includes("Publish the notes") && page.one("[role=dialog]") !== null);
  expect(page.one("h1")?.textContent).toBe("Publish the notes");
  await page.unmount();
  go("#/simple");

  const again = await render();
  await until(again, () => again.text().includes("Publish the notes"));
  const second = again.all('[data-block="my-work"] button.simple-card')[1]!;
  await press(again, second, "Enter");
  await until(again, () => again.one("h1")?.textContent === "Publish the notes");
  const dialog = again.one("[role=dialog]")!;
  await press(again, dialog, "Escape");
  await until(again, () => again.one("h1")?.textContent === "Simple");
  expect(testWindow.location.hash).toBe("#/simple");
  await until(again, () => lastFocused?.getAttribute("data-card-id") === "c-publish");
  expect(again.html()).not.toContain("aria-modal");
  expect(again.one('[data-card-id="c-publish"]')?.getAttribute("data-cursor")).toBe("true");
  await again.unmount();
});

test("card detail shows who, due date, and a plain activity summary", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Check the homepage"));
  await openCard(page, "Check the homepage");
  const detail = page.text();
  expect(detail).toContain("Status: Waiting for review");
  expect(detail).toContain("Bea");
  expect(detail).toContain("Reviewer");
  expect(detail).toContain("You");
  expect(page.one("h1")?.textContent).toBe("Check the homepage");
  expect(page.html()).not.toContain("aria-modal");
  await page.click(byText(page, "button", "Back"));
  await until(page, () => page.one("h1")?.textContent === "Simple");
  await until(page, () => lastFocused?.getAttribute("data-card-id") === "c-check");

  await openCard(page, "Write the welcome note");
  await until(page, () => page.text().includes("You added this."));
  const activity = page.text();
  expect(activity).toContain("October 10, 2026");
  expect(activity).toContain("You added this.");
  expect(activity).not.toContain("You started this work.");
  expect(activity).toContain("Bea's assistant wrote: Please see WEB-4 and tell the agent");
  expect(activity).toContain("You moved this to Waiting for review.");
  expect(activity).not.toContain("launch");
  expect(activity).not.toContain("cc-9");
  await page.unmount();
});

test("activity failure stays on the title and Retry loads it", async () => {
  world.activityFail = true;
  const page = await render();
  await until(page, () => page.text().includes("Write the welcome note"));
  await openCard(page, "Write the welcome note");
  await until(page, () => page.text().includes("Synthetic activity failure"));
  expect(page.one("h1")?.textContent).toBe("Write the welcome note");
  world.activityFail = false;
  await page.click(byText(page, "button", "Retry"));
  await until(page, () => page.text().includes("You added this."));
  await page.unmount();
});

test("Approve, Needs changes, and Ask a question on a card use comments and done", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Write the welcome note"));
  await openCard(page, "Write the welcome note");
  await page.click(byText(page, "button", "Needs changes"));
  await page.click(byText(page, "button", "Send"));
  expect(page.text()).toContain("Write what needs to change.");
  expect(world.commentCalls).toEqual([]);
  expect(world.updateCalls).toEqual([]);
  await page.fill(page.one("textarea")!, "Check the spelling");
  await page.click(byText(page, "button", "Send"));
  await until(page, () => world.updateCalls.length > 0);
  expect(world.commentCalls).toEqual([[welcome.id, "Needs changes: Check the spelling"]]);
  expect(world.updateCalls).toEqual([[welcome.id, { column: "doing" }]]);
  await page.unmount();

  world = freshWorld();
  installApi();
  go("#/simple");
  const askPage = await render();
  await until(askPage, () => askPage.text().includes("Write the welcome note"));
  await openCard(askPage, "Write the welcome note");
  await askPage.click(byText(askPage, "button", "Ask a question"));
  expect(askPage.text()).toContain("This posts your question on the work.");
  await askPage.fill(askPage.one("textarea")!, "When is the photo ready?");
  await askPage.click(byText(askPage, "button", "Send"));
  await until(askPage, () => askPage.text().includes("Your question was posted."));
  expect(world.commentCalls).toEqual([[welcome.id, "When is the photo ready?"]]);
  expect(world.answerCalls).toEqual([]);
  await askPage.unmount();

  world = freshWorld();
  installApi();
  go("#/simple");
  const approve = await render();
  await until(approve, () => approve.text().includes("Write the welcome note"));
  await openCard(approve, "Write the welcome note");
  expect(approve.all("button").some((b) => b.textContent.trim() === "Approve")).toBe(false);
  await approve.click(byText(approve, "button", "Back"));
  await until(approve, () => approve.one("h1")?.textContent === "Simple");
  await openCard(approve, "Pick the sign-in");
  await approve.click(byText(approve, "button", "Approve"));
  await until(approve, () => world.actionCalls.length > 0);
  expect(world.commentCalls).toEqual([[pick.id, "Approved."]]);
  expect(world.actionCalls).toEqual([[pick.id, "done"]]);
  expect(world.answerCalls).toEqual([]);
  await approve.unmount();
});

test("a failed comment does not move the card, and a failed done says the approval was saved", async () => {
  world.commentError = new ApiError("synthetic", "Synthetic comment failure", 500);
  const page = await render();
  await until(page, () => page.text().includes("Pick the sign-in"));
  await openCard(page, "Pick the sign-in");
  await page.click(byText(page, "button", "Approve"));
  await until(page, () => page.text().includes("Synthetic comment failure"));
  expect(world.actionCalls).toEqual([]);
  await page.unmount();

  world = freshWorld();
  world.actionError = new ApiError("synthetic", "nope", 500);
  installApi();
  go("#/simple");
  const partial = await render();
  await until(partial, () => partial.text().includes("Pick the sign-in"));
  await openCard(partial, "Pick the sign-in");
  await partial.click(byText(partial, "button", "Approve"));
  await until(partial, () => partial.text().includes("The approval was saved, but the status did not change."));
  expect(world.commentCalls.length).toBe(1);
  expect(world.actionCalls.length).toBe(1);
  await partial.unmount();

  world = freshWorld();
  world.updateError = new ApiError("synthetic", "nope", 500);
  installApi();
  go("#/simple");
  const note = await render();
  await until(note, () => note.text().includes("Write the welcome note"));
  await openCard(note, "Write the welcome note");
  await note.click(byText(note, "button", "Needs changes"));
  await note.fill(note.one("textarea")!, "Check the spelling");
  await note.click(byText(note, "button", "Send"));
  await until(note, () => note.text().includes("The note was saved, but the status did not change."));
  expect(world.commentCalls.length).toBe(1);
  await note.unmount();
});

test("an ask is answered in place, and confidential or unknown work stays off the page", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Should we publish the welcome note?"));
  await page.click(page.all("button.simple-card").find((b) => b.textContent.includes("Should we publish the welcome note?"))!);
  await until(page, () => page.one("[role=dialog]") !== null);
  expect(page.text()).not.toContain("This sends your question as the answer.");
  await page.click(byText(page, "button", "Ask a question"));
  expect(page.text()).toContain("This sends your question as the answer.");
  await page.click(byText(page, "button", "Approve"));
  await until(page, () => world.answerCalls.length > 0 && page.one("h1")?.textContent === "Simple");
  expect(world.answerCalls).toEqual([{ ask: beaAsk.ask.id, text: "Approved" }]);
  expect(world.commentCalls).toEqual([]);
  expect(page.text()).not.toContain("Should we publish the welcome note?");
  await page.unmount();

  world = freshWorld();
  installApi();
  go("#/simple");
  const hidden = await render();
  await until(hidden, () => hidden.text().includes("Write the welcome note"));
  const calls = world.taskCalls.length;
  await act(async () => { go("#/simple?card=c-merger"); });
  await until(hidden, () => hidden.text().includes("This work is marked confidential and stays off this page."));
  expect(hidden.text()).not.toContain("Merger");
  expect(world.taskCalls.length).toBe(calls);
  await act(async () => { go("#/simple?card=missing"); });
  await until(hidden, () => hidden.text().includes("That work is not on this page."));
  expect(world.taskCalls.length).toBe(calls);
  await hidden.unmount();
});

test("partition keeps a review in my work when someone else reviews it, and drops confidential asks", () => {
  const hold = card({ id: "c-hold", title: "Hold the copy", column: "review", n: 8, assignee: "@alex", reviewer: "@bea" });
  const unassigned = card({ id: "c-rev", title: "Read the draft", column: "review", n: 11, assignee: "@alex", reviewer: null });
  const odd = card({ id: "c-odd", title: "Sort the pins", column: "nope", n: 12 });
  const parts = lib.partition([hold, unassigned, odd, merger], [website], "alex");
  // "nope" is not a column on the board, so the card is left off the lists and the counts.
  expect(lib.onSimplePage(odd, [website])).toBe(false);
  expect(parts.myWork.map((c) => c.id)).toEqual(["c-hold"]);
  expect(parts.decisions.map((c) => c.id)).toEqual(["c-rev"]);
  expect(parts.counts[0]!.counts["To do"]).toBe(0);
  expect(parts.hiddenIds.has("c-merger")).toBe(true);
  expect(lib.statusName("backlog")).toBe("To do");
  expect(lib.statusName("cancelled")).toBeNull();
  expect(lib.statusName(null)).toBe("To do");
  expect(lib.columnForStatus(columns, "To do")?.id).toBe("todo");
  expect(lib.columnForStatus(columns.filter((c) => c.role !== "todo"), "To do")?.id).toBe("backlog");
  expect(lib.columnForStatus(columns.filter((c) => c.role !== "active"), "Working on")).toBeUndefined();
  expect(lib.plainText("Please see WEB-4 and tell the agent")).toBe("Please see and tell the assistant");
  expect(lib.dueLabel("2026-10-10")).toBe("October 10, 2026");
  expect(lib.dueLabel(null)).toBe("No due date");
  const lines = lib.activityLines(welcomeTimeline, columns, "alex", boardState().team?.members);
  expect(lines).toEqual([
    "You added this.",
    "Bea's assistant wrote: Please see WEB-4 and tell the agent",
    "You moved this to Waiting for review.",
  ]);
  const mineAgent = ask("bbbbbbbbbbbbbbbb:6", "@alex/host/cc-9", "Did you read the welcome note?", { handle: "bea" }, later);
  expect(lib.askVisible(mineAgent, "alex", [], now, [], new Set())).toBe(true);
  expect(lib.askVisible(oliveAsk, "alex", [oliveAgent], now, parts.needles, new Set())).toBe(false);
  expect(lib.askVisible(leakAsk, "alex", [], now, parts.needles, new Set())).toBe(false);
  const lower = ask("bbbbbbbbbbbbbbbb:7", "@alex", "Can I share the merger plan with legal?", { handle: "maren" }, later);
  const shouting = ask("bbbbbbbbbbbbbbbb:8", "@alex", "Status of MERGER PLAN?", { handle: "maren" }, later);
  const planning = ask("bbbbbbbbbbbbbbbb:9", "@alex", "The merger planning meeting moved.", { handle: "maren" }, later);
  expect(lib.askVisible(lower, "alex", [], now, parts.needles, new Set())).toBe(false);
  expect(lib.askVisible(shouting, "alex", [], now, parts.needles, new Set())).toBe(false);
  expect(lib.askVisible(planning, "alex", [], now, parts.needles, new Set())).toBe(true);
  const spaced = card({ id: "c-spaced", title: "Board pay review", column: "todo", n: 16, labels: ["confidential "] });
  expect(lib.isConfidential(spaced)).toBe(true);
  expect(lib.partition([spaced], [website], "alex").myWork).toEqual([]);
  const short = card({ id: "c-ipo", title: "IPO", column: "todo", n: 17, labels: ["confidential"] });
  const ipo = lib.partition([short], [website], "alex");
  const ipoAsk = ask("bbbbbbbbbbbbbbbb:10", "@alex", "When is the IPO filed?", { handle: "maren" }, later);
  const ipos = ask("bbbbbbbbbbbbbbbb:11", "@alex", "How many IPOs ran?", { handle: "maren" }, later);
  expect(lib.askVisible(ipoAsk, "alex", [], now, ipo.needles, new Set())).toBe(false);
  expect(lib.askVisible(ipos, "alex", [], now, ipo.needles, new Set())).toBe(true);
  const needed = card({ id: "c-needed", title: "Pick a vendor", column: "todo", n: 18, labels: ["decision-needed "] });
  expect(lib.needsYourDecision(needed, [website], "alex")).toBe(true);
  const old = card({ id: "c-archived-board", title: "Old board card", column: "doing", n: 19, board: "board-old" });
  const oldParts = lib.partition([old], [website], "alex");
  expect(oldParts.myWork).toEqual([]);
  expect(oldParts.counts[0]!.counts["Working on"]).toBe(0);
  expect(lib.askVisible(expiredAsk, "alex", [], now, [], new Set())).toBe(false);
  expect(lib.askVisible(otherAsk, "alex", [], now, [], new Set())).toBe(false);
});

test("the latest 500 notice shows when the list is truncated", async () => {
  world.truncated = true;
  const page = await render();
  await until(page, () => page.text().includes("Showing the latest 500. Some older work is not listed."));
  expect(world.taskQueries.some((q) => q.assignee === "me" && q.limit === 500)).toBe(true);
  expect(world.taskQueries.some((q) => q.role === "review" && q.limit === 500)).toBe(true);
  expect(world.taskQueries.some((q) => q.state === "open" && q.limit === 500 && q.assignee === undefined && q.role === undefined)).toBe(true);
  await page.unmount();
});

test("my work and decisions load from their own queries, past the latest open list", async () => {
  world.extraMine = [buried];
  world.extraReview = [buriedReview];
  const page = await render();
  await until(page, () => page.text().includes("Buried welcome draft") && page.text().includes("Buried sign-off"));
  const my = page.one('[data-block="my-work"]')!.textContent;
  const decisions = page.one('[data-block="decisions"]')!.textContent;
  const team = page.one('[data-block="team"]')!.textContent;
  expect(my).toContain("Buried welcome draft");
  expect(decisions).toContain("Buried sign-off");
  expect(team).toContain("To do 2");
  expect(team).toContain("Waiting for review 1");
  await page.unmount();
});

test("an observer can read and is not offered Move, Approve, Needs changes, or Ask", async () => {
  const page = await render("observer");
  await until(page, () => page.text().includes("Write the welcome note"));
  expect(page.text()).toContain("You can read this. You can't change it.");
  expect(page.text()).not.toContain("Move to:");
  expect(page.all("button").some((b) => (b.getAttribute("aria-label") ?? "").startsWith("Move "))).toBe(false);
  await openCard(page, "Pick the sign-in");
  expect(page.text()).toContain("You can read this. You can't change it.");
  for (const label of ["Approve", "Needs changes", "Ask a question"]) {
    expect(page.all("button").some((b) => b.textContent.trim() === label)).toBe(false);
  }
  await page.unmount();
});

test("Move and Approve do not write when the card's column changed", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Write the welcome note"));
  world.cards = world.cards.map((c) => c.id === welcome.id ? { ...c, column: "doing" } : c);
  await page.click(labeled(page, "Move Write the welcome note to Working on"));
  await until(page, () => page.text().includes("This card changed. Refresh to see the latest."));
  expect(world.updateCalls).toEqual([]);
  await page.unmount();

  world = freshWorld();
  installApi();
  go("#/simple");
  const approve = await render();
  await until(approve, () => approve.text().includes("Pick the sign-in"));
  await openCard(approve, "Pick the sign-in");
  world.cards = world.cards.map((c) => c.id === pick.id ? { ...c, column: "doing" } : c);
  await approve.click(byText(approve, "button", "Approve"));
  await until(approve, () => approve.text().includes("This card changed. Refresh to see the latest."));
  expect(world.commentCalls).toEqual([]);
  expect(world.actionCalls).toEqual([]);
  await approve.unmount();
});

test("a decision-needed card stays listed when I am only the reviewer", () => {
  const rv = card({ id: "c-rv1", title: "Choose the logo", column: "todo", n: 50, pos: "g", assignee: "@bea", reviewer: "@alex", labels: ["decision-needed"] });
  const onlyTeam = lib.partition([rv], [website], "alex", { mine: [], review: [] });
  expect(onlyTeam.decisions.map((c) => c.id)).toEqual(["c-rv1"]);
  expect(onlyTeam.myWork).toEqual([]);
  const duplicated = lib.partition([rv], [website], "alex", { mine: [rv], review: [rv] });
  expect(duplicated.decisions).toHaveLength(1);
  expect(duplicated.decisions.map((c) => c.id)).toEqual(["c-rv1"]);
});

test("Needs your decision shows a decision-needed card assigned to someone else", async () => {
  const rv = card({ id: "c-rv1", title: "Choose the logo", column: "todo", n: 50, pos: "g", assignee: "@bea", reviewer: "@alex", labels: ["decision-needed"] });
  world.cards = [...world.cards, rv];
  const page = await render();
  await until(page, () => page.text().includes("Write the welcome note"));
  expect(page.one('[data-block="decisions"]')!.textContent).toContain("Choose the logo");
  expect(page.one('[data-block="my-work"]')!.textContent).not.toContain("Choose the logo");
  expect(page.text().split("Choose the logo").length - 1).toBe(1);
  await page.unmount();
});

test("a confidential title matches an ask across spaces, hyphens, exclamation marks, and line breaks", () => {
  const hidden: Array<[string, string]> = [
    ["Merger plan!", "Is the merger plan ready?"],
    ["Merger  plan", "Is the merger plan ready?"],
    ["Merger plan", "Is the merger-plan ready?"],
    ["Merger plan", "Is the merger\nplan ready?"],
    ["Merger\nplan", "See the merger plan today."],
    ["merger-plan", "See the merger plan today."],
    ["Merger plan", "The merger plan!"],
  ];
  for (const [title, text] of hidden) {
    const c = card({ id: "c-fold", title, column: "todo", n: 60, labels: ["confidential"], key: "ZZ-60", ref: "ZZ-60-abcd1234" });
    const parts = lib.partition([c], [website], "alex");
    const a = ask("bbbbbbbbbbbbbbbb:90", "@alex", text, { handle: "maren" }, later);
    const visible = lib.askVisible(a, "alex", [], now, parts.needles, new Set());
    if (visible) throw new Error(`expected the ask to be hidden for title ${JSON.stringify(title)} and text ${JSON.stringify(text)}`);
    expect(visible).toBe(false);
  }
  const planning = card({ id: "c-fold", title: "Merger plan", column: "todo", n: 60, labels: ["confidential"], key: "ZZ-60", ref: "ZZ-60-abcd1234" });
  const planningParts = lib.partition([planning], [website], "alex");
  const planningAsk = ask("bbbbbbbbbbbbbbbb:91", "@alex", "The merger planning meeting moved.", { handle: "maren" }, later);
  expect(lib.askVisible(planningAsk, "alex", [], now, planningParts.needles, new Set())).toBe(true);
  const keyed = card({ id: "c-key", title: "Ordinary title", column: "todo", n: 61, labels: ["confidential"], key: "ZZ-61", ref: "ZZ-61-abcd1234" });
  const keyParts = lib.partition([keyed], [website], "alex");
  const keyAsk = ask("bbbbbbbbbbbbbbbb:92", "@alex", "Please read ZZ-61 today.", { handle: "maren" }, later);
  const spacedKey = ask("bbbbbbbbbbbbbbbb:93", "@alex", "Please read ZZ 61 today.", { handle: "maren" }, later);
  expect(lib.askVisible(keyAsk, "alex", [], now, keyParts.needles, new Set())).toBe(false);
  expect(lib.askVisible(spacedKey, "alex", [], now, keyParts.needles, new Set())).toBe(true);
});

test("the card page labels the assignee and the reviewer with a colon", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Check the homepage"));
  await openCard(page, "Check the homepage");
  expect(page.text()).toContain("Who: Bea");
  expect(page.text()).toContain("Reviewer: You");
  expect(page.text()).not.toContain("Who Bea");
  expect(page.text()).not.toContain("Reviewer You");
  await page.unmount();
});

test("a card in a column the board does not have is left off the page", async () => {
  const odd = card({ id: "c-odd", title: "Sort the pins", column: "nope", n: 12 });
  world.cards = [...world.cards, odd];
  const page = await render();
  await until(page, () => page.text().includes("Write the welcome note"));
  expect(page.text()).not.toContain("Sort the pins");
  expect(page.one('[data-block="team"]')!.textContent).toContain("To do 2");
  await act(async () => { go("#/simple?card=c-odd"); });
  await until(page, () => page.text().includes("That work is not on this page."));
  expect(page.text()).not.toContain("Sort the pins");
  await page.unmount();
});

test("the latest 500 notice shows when my work or the review list is cut off", async () => {
  world.mineTruncated = true;
  const mine = await render();
  await until(mine, () => mine.text().includes("Write the welcome note"));
  expect(mine.text().split("Showing the latest 500").length - 1).toBe(1);
  await mine.unmount();

  world = freshWorld();
  world.reviewTruncated = true;
  installApi();
  go("#/simple");
  const review = await render();
  await until(review, () => review.text().includes("Write the welcome note"));
  expect(review.text().split("Showing the latest 500").length - 1).toBe(1);
  await review.unmount();
});

test("returning from a card that is no longer listed does not focus it when it comes back", async () => {
  const page = await render();
  await until(page, () => page.text().includes("Publish the notes"));
  await openCard(page, "Publish the notes");
  api.updateTask = async (ref, body) => {
    world.updateCalls.push([ref, body]);
    const found = world.cards.find((c) => c.id === ref) ?? welcome;
    return { task: { ...found, ...body, labels: ["confidential"] } };
  };
  await page.click(labeled(page, "Move Publish the notes to Working on"));
  await until(page, () => page.text().includes("This work is marked confidential and stays off this page."));
  await page.click(byText(page, "button", "Back"));
  await until(page, () => page.one("h1")?.textContent === "Simple");
  expect(page.text()).not.toContain("Publish the notes");
  lastFocused = null;
  await page.click(byText(page, "button", "Refresh"));
  await until(page, () => page.text().includes("Publish the notes"));
  expect(page.one('[data-card-id="c-publish"]')?.getAttribute("data-cursor") ?? null).toBeNull();
  expect(lastFocused?.getAttribute("data-card-id") ?? null).toBeNull();
  await page.unmount();
});

test("integration (WALK-75 review LOW-1/LOW-2): every punctuation mark is a word break, and any confidential copy hides a card", () => {
  // A title quoted with other punctuation around or inside it still matches.
  expect(lib.quotesConfidential("about the merger: plan, see notes", { exact: [], titles: ["Merger plan"] })).toBe(true);
  expect(lib.quotesConfidential("the merger planning call", { exact: [], titles: ["Merger plan"] })).toBe(false); // whole words only
  expect(lib.quotesConfidential("re: Merger. Plan?", { exact: [], titles: ["Merger plan"] })).toBe(true);
  expect(lib.quotesConfidential("the (Merger) / plan", { exact: [], titles: ["Merger plan"] })).toBe(true);
  // The team list holds an older copy without the label; the assignee=me copy is confidential: hidden everywhere.
  const older = { ...merger, labels: [], title: "Merger plan" };
  const parts = lib.partition([older, welcome], [website], "alex", { mine: [merger, welcome], review: [] });
  expect(parts.hiddenIds.has(merger.id)).toBe(true);
  expect(parts.myWork.map((c) => c.id)).not.toContain(merger.id);
  expect(parts.counts.find((c) => c.channel === website.channel)?.counts["To do"]).toBe(1);
  expect(parts.confidentialLeftOff).toBe(true);
});
