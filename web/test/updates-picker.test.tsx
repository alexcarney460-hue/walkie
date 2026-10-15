// WALK-121: the picker on the Updates page, driven the way a person drives it: the real page, the real projects store and
// the real switch, with the daemon's answers stubbed. A project switched on there must get its update card without a
// reload; the list a person is ticking through must stay open and keep their filter; a refusal must change nothing.
import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { ApiError } from "../src/api/client.ts";
import type { ProjectView, StatusReportPayload } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { installDom, type DomEnv, type MiniElement, type Mounted } from "./mini-dom.ts";
import { go } from "./window-stub.ts";
import { resetProjectsStore } from "./projects-store-fixture.ts";

let env: DomEnv;
let Updates: typeof import("../src/views/updates/Updates.tsx").Updates;
let api: typeof import("../src/api/client.ts").api;
let projectsStore: typeof import("../src/state/projects.ts").projectsStore;
let StaticStore: typeof import("../src/state/store.tsx").StaticStore;
let initialState: State;

const meter = { mode: "count" as const, done: 1, counted: 4, by_role: { backlog: 0, todo: 2, active: 1, review: 0, done: 1, cancelled: 0 } };
const project = (extra: Partial<ProjectView> = {}): ProjectView => ({
  channel: "p-00000001", id: "a000000000000001:1", name: "Website", folder: "Acme", description: "", prefix: "WEB", paths: [], meter_mode: "count",
  automations: { pr_opened: true, pr_merged: false, agents_can_close: true }, state: "active", steward: "on", steward_node: "", status_report: "off",
  private: false, admins: ["maren"], creator: "maren", created_at: 0, boards: [], meter, cards: 4, last_activity: Date.now(), ...extra,
});

const AT = Date.UTC(2026, 9, 1, 14, 0);
const payload = (name: string): StatusReportPayload => ({
  mode: "hourly",
  report: { markdown: `**On track:** ${name} shipped its pricing page.`, header: null, as_of: AT, at: AT, by: { handle: "kira", agent: "orchestrator" } },
});

interface World {
  projects: ProjectView[];
  reads: string[];
  writes: Array<[string, Record<string, unknown>]>;
  refuse: ApiError | null;
}
let world: World;
const fresh = (projects: ProjectView[]): World => ({ projects, reads: [], writes: [], refuse: null });

const web = project({ name: "Website" });
const hiring = project({ channel: "p-00000002", name: "Hiring", prefix: "HR", folder: "" });
const legal = project({ channel: "p-00000003", name: "Legal", prefix: "LEG" });

type ApiKey = "projects" | "statusReport" | "updateProject";
const saved = {} as Record<ApiKey, unknown>;

function installApi(): void {
  api.projects = async () => ({ projects: world.projects, stubs: [] });
  api.statusReport = async (channel: string) => {
    world.reads.push(channel);
    const p = world.projects.find((x) => x.channel === channel);
    return payload(p?.name ?? channel);
  };
  api.updateProject = async (channel: string, body: Record<string, unknown>) => {
    world.writes.push([channel, body]);
    if (world.refuse) throw world.refuse;
    const next = world.projects.map((p) => (p.channel === channel ? { ...p, status_report: body.status_report as "hourly" | "off" } : p));
    world.projects = next;
    return { project: next.find((p) => p.channel === channel) as ProjectView };
  };
}

beforeAll(async () => {
  env = await installDom();
  go("#/updates");
  const [view, client, projects, store, reducer] = await Promise.all([
    import("../src/views/updates/Updates.tsx"),
    import("../src/api/client.ts"),
    import("../src/state/projects.ts"),
    import("../src/state/store.tsx"),
    import("../src/state/reducer.ts"),
  ]);
  Updates = view.Updates;
  api = client.api;
  projectsStore = projects.projectsStore;
  StaticStore = store.StaticStore;
  initialState = reducer.initialState;
  for (const k of ["projects", "statusReport", "updateProject"] as const) saved[k] = api[k];
});

afterAll(async () => {
  for (const k of ["projects", "statusReport", "updateProject"] as const) (api as unknown as Record<string, unknown>)[k] = saved[k];
  resetProjectsStore();
  await env.restore();
  go("#/mission");
});

beforeEach(() => {
  resetProjectsStore();
  world = fresh([web, hiring, legal]);
  installApi();
  projectsStore.set({ status: "ready", error: null, projects: world.projects, stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
});

const asMe = (me: { handle: string; role: string }): State =>
  ({ ...initialState, phase: "ready", me: { ...me, node: { hostname: "kira-mac" } } as unknown as State["me"], agents: [] });

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function until(page: Mounted, cond: () => boolean, ms = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (env.uncaught.length) throw env.uncaught[0];
    if (Date.now() - start > ms) throw new Error(`timed out. page text: ${page.text().slice(0, 600)}`);
    await settle();
  }
}

// A page left mounted keeps listening to the projects store: the next test's setup would update it outside act.
let pages: Mounted[] = [];
afterEach(async () => {
  const left = pages;
  pages = [];
  for (const page of left) await page.unmount();
  resetProjectsStore();
});

async function render(me = { handle: "kira", role: "owner" }): Promise<Mounted> {
  const page = await env.mount(<StaticStore state={asMe(me)}><Updates /></StaticStore>);
  pages.push(page);
  await settle();
  return page;
}

const switchFor = (page: Mounted, name: string): MiniElement => {
  const el = page.all('input[role="switch"]').find((e) => e.getAttribute("aria-label") === `Hourly status report for ${name}`);
  if (!el) throw new Error(`no switch for ${name}\n${page.text().slice(0, 400)}`);
  return el;
};
/** A person's click on a switch. A browser flips a checkbox before it dispatches the click; the mini DOM does not, so do it first. */
async function toggle(page: Mounted, el: MiniElement): Promise<void> {
  const box = el as MiniElement & { checked?: boolean };
  box.checked = !box.checked;
  await page.click(el);
  await settle();
}
const cards = (page: Mounted) => page.all("article.update").length;
const picker = (page: Mounted) => page.one("details.updates-pick-details");

test("ticking a project in the empty state brings its update card in without a reload, and the list stays open for the next one", async () => {
  const page = await render();
  expect(cards(page)).toBe(0);
  expect(page.text()).toContain("No project updates yet");
  expect(page.all('input[role="switch"]')).toHaveLength(3);
  expect(world.reads).toEqual([]);

  await toggle(page, switchFor(page, "Hiring"));
  await until(page, () => cards(page) === 1 && page.text().includes("Hiring shipped its pricing page."));
  expect(world.writes).toEqual([["p-00000002", { status_report: "hourly" }]]);
  expect(world.reads).toEqual(["p-00000002"]);
  expect(page.text()).toContain("Plain-English status reports · 1 project reported hourly");

  // The page changed shape (cards, then the picker in a disclosure) but the person's list stays open, with the project on top.
  const details = picker(page);
  expect(details).not.toBeNull();
  expect(details?.hasAttribute("open")).toBe(true);
  expect(page.text()).toContain("Hourly updates: 1 of 3 projects");
  const names = (details as MiniElement).all("li.updates-pick-row").map((li) => li.one("span.updates-pick-name")?.textContent.trim());
  expect(names).toEqual(["Hiring", "Acme · Legal", "Acme · Website"]);
  expect(switchFor(page, "Hiring").getAttribute("aria-checked")).toBe("true");

  // A second project: its card appears too, and the first one's report is not lost.
  await toggle(page, switchFor(page, "Website"));
  await until(page, () => cards(page) === 2);
  expect(world.reads).toContain("p-00000001");
  expect(page.text()).toContain("Hourly updates: 2 of 3 projects");
  expect(picker(page)?.hasAttribute("open")).toBe(true);
});

const labels = (els: MiniElement[]) => els.map((e) => e.getAttribute("aria-label"));
const rowNames = (page: Mounted) => page.all("li.updates-pick-row").map((li) => li.one("span.updates-pick-name")?.textContent.trim());

test("ticking a row moves no row: the same rows in the same order, and every checkbox is the very same element, even as the page changes shape", async () => {
  const page = await render();
  const rows = rowNames(page);
  const boxes = page.all('input[role="switch"]');
  expect(rows).toEqual(["Hiring", "Acme · Legal", "Acme · Website"]);
  const sameAfter = (after: MiniElement[]) => {
    expect(labels(after)).toEqual(labels(boxes));
    expect(rowNames(page)).toEqual(rows);
    // The element itself, not an equal one: a remounted checkbox is a new element, and a person's keyboard focus would be gone with the old one.
    after.forEach((el, i) => expect(el === boxes[i]).toBe(true));
  };

  // The first tick: the explanation and the picker become the cards and the picker in a disclosure.
  await toggle(page, switchFor(page, "Website"));
  await until(page, () => cards(page) === 1);
  expect(switchFor(page, "Website").getAttribute("aria-checked")).toBe("true");
  sameAfter(page.all('input[role="switch"]'));

  // A tick with a card already showing, and then one switched off again.
  await toggle(page, switchFor(page, "Hiring"));
  await until(page, () => cards(page) === 2);
  sameAfter(page.all('input[role="switch"]'));
  await toggle(page, switchFor(page, "Website"));
  await until(page, () => cards(page) === 1);
  sameAfter(page.all('input[role="switch"]'));
  expect(switchFor(page, "Website").getAttribute("aria-checked")).toBe("false");
});

test("a project switched off loses its card, and with none left the page is the empty state with the picker again", async () => {
  world = fresh([{ ...web, status_report: "hourly" }, hiring, legal]);
  projectsStore.set({ status: "ready", error: null, projects: world.projects, stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const page = await render();
  await until(page, () => cards(page) === 1);
  // Reported from the start: the picker is a closed disclosure under the card.
  expect(picker(page)?.hasAttribute("open")).toBe(false);
  expect(page.text()).toContain("Hourly updates: 1 of 3 projects");

  await toggle(page, switchFor(page, "Website"));
  await until(page, () => cards(page) === 0);
  expect(world.writes).toEqual([["p-00000001", { status_report: "off" }]]);
  expect(page.text()).toContain("No project updates yet");
  // The picker is still the one disclosure, and it is open again: with nothing on it is the way forward.
  expect(picker(page)?.hasAttribute("open")).toBe(true);
  expect(picker(page)?.one("summary")?.textContent).toBe("Choose projects for hourly updates");
  expect(page.all('input[role="switch"]')).toHaveLength(3);
});

test("a refusal leaves the project off, shows the daemon's reason beside it and brings in no card", async () => {
  world.refuse = new ApiError("forbidden", "only the project's creator or an owner can turn its status report on or off", 403);
  const page = await render({ handle: "bea", role: "owner" });
  await toggle(page, switchFor(page, "Legal"));
  await until(page, () => page.all('p[role="alert"]').length === 1);
  expect(page.all('p[role="alert"]')[0]?.textContent).toContain("creator or an owner");
  expect(cards(page)).toBe(0);
  expect(world.reads).toEqual([]);
  expect(switchFor(page, "Legal").getAttribute("aria-checked")).toBe("false");
});

test("a person who may not change projects gets no control, and ticking is impossible", async () => {
  const page = await render({ handle: "bob", role: "member" });
  expect(page.all('input[role="switch"]')).toHaveLength(0);
  expect(page.text()).toContain("creator or an owner");
  expect(page.text()).toContain("Off");
  expect(world.writes).toEqual([]);
});

test("above twelve projects the filter narrows the rows as the person types and keeps their text while they tick", async () => {
  const many = Array.from({ length: 14 }, (_, i) => project({ channel: `p-${(200 + i).toString(16).padStart(8, "0")}`, name: `Team ${String.fromCharCode(65 + i)}`, prefix: `T${String.fromCharCode(65 + i)}`, folder: i < 7 ? "North" : "South" }));
  world = fresh(many);
  projectsStore.set({ status: "ready", error: null, projects: many, stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const page = await render();
  expect(page.all('input[role="switch"]')).toHaveLength(14);
  const find = page.one('input[type="search"]') as MiniElement;
  expect(find).not.toBeNull();
  expect(page.all("label").some((l) => l.textContent === "Find a project")).toBe(true);

  await page.fill(find, "  south ");
  expect(page.all('input[role="switch"]')).toHaveLength(7);
  await page.fill(find, "team c");
  expect(page.all('input[role="switch"]')).toHaveLength(1);
  await page.fill(find, "nothing like it");
  expect(page.all('input[role="switch"]')).toHaveLength(0);
  expect(page.text()).toContain("No project matches");

  await page.fill(find, "team c");
  await toggle(page, switchFor(page, "Team C"));
  await until(page, () => cards(page) === 1);
  expect((page.one('input[type="search"]') as MiniElement).value).toBe("team c");
  expect(page.all('input[role="switch"]')).toHaveLength(1);
  expect(picker(page)?.hasAttribute("open")).toBe(true);
});

test("a tick made while the page's own projects read is still on its way is not undone when that older answer lands", async () => {
  // The read the page starts on mount, slow: it will answer with the list as it was before any tick.
  let answer: (projects: ProjectView[]) => void = () => {};
  api.projects = () => new Promise((resolve) => { answer = (projects) => resolve({ projects, stubs: [] }); });
  const before = world.projects;
  const page = await render();
  await toggle(page, switchFor(page, "Hiring"));
  await until(page, () => cards(page) === 1);
  expect(switchFor(page, "Hiring").getAttribute("aria-checked")).toBe("true");

  await act(async () => { answer(before); await new Promise((r) => setTimeout(r, 0)); });
  expect(world.writes).toEqual([["p-00000002", { status_report: "hourly" }]]);
  expect(cards(page)).toBe(1);
  expect(switchFor(page, "Hiring").getAttribute("aria-checked")).toBe("true");
  expect(page.text()).toContain("Hourly updates: 1 of 3 projects");
  expect(page.text()).toContain("Hiring shipped its pricing page.");
});
