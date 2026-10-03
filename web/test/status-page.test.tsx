// PROJECT-PAGES-1 dashboard: the status page a project's non-technical teammates read. The route, the plain words for what the
// daemon sends, the whole page and each of its empty states, what a screen's image goes through before it is shown, the link
// from the Projects list and the tab on the project, and an audit of the stylesheet (theme tokens only; the phone's rules).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView, ScreenView, StatusPagePayload } from "../src/api/types.ts";
import type { State } from "../src/state/reducer.ts";
import { png } from "../../test/helpers/images.ts";
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

type Lib = typeof import("../src/lib/status-page.ts");
type Img = typeof import("../src/lib/screen-image.ts");
type Page = typeof import("../src/views/projects/StatusPage.tsx");
type Screens = typeof import("../src/views/projects/StatusPageScreens.tsx");
let lib: Lib, img: Img, page: Page, screens: Screens;
let route: typeof import("../src/lib/route.ts");
let time: typeof import("../src/lib/time.ts");
let st: typeof import("../src/state/projects.ts");
let client: typeof import("../src/api/client.ts");
let ProjectList: typeof import("../src/views/projects/ProjectList.tsx").ProjectList;
let ProjectBoard: typeof import("../src/views/projects/ProjectBoard.tsx").ProjectBoard;
let StaticStore: (p: { state: State; children: ReactNode }) => ReactNode;
let initialState: State;
beforeAll(async () => {
  lib = await import("../src/lib/status-page.ts");
  img = await import("../src/lib/screen-image.ts");
  page = await import("../src/views/projects/StatusPage.tsx");
  screens = await import("../src/views/projects/StatusPageScreens.tsx");
  route = await import("../src/lib/route.ts");
  time = await import("../src/lib/time.ts");
  st = await import("../src/state/projects.ts");
  client = await import("../src/api/client.ts");
  ProjectList = (await import("../src/views/projects/ProjectList.tsx")).ProjectList;
  ProjectBoard = (await import("../src/views/projects/ProjectBoard.tsx")).ProjectBoard;
  const s = await import("../src/state/store.tsx");
  StaticStore = s.StaticStore;
  initialState = (await import("../src/state/reducer.ts")).initialState;
});

const AT = Date.UTC(2026, 9, 1, 14, 0);
const CH = "p-00000001";
const meter = { mode: "count" as const, done: 1, counted: 4, by_role: { backlog: 0, todo: 2, active: 1, review: 0, done: 1, cancelled: 0 } };
const project = (extra: Partial<ProjectView> = {}): ProjectView => ({
  channel: CH, id: "a000000000000001:1", name: "Customer portal", folder: "Acme", description: "", prefix: "POR", paths: [], meter_mode: "count",
  automations: { pr_opened: true, pr_merged: false, agents_can_close: true }, state: "active", steward: "on", steward_node: "", status_report: "hourly",
  private: false, admins: ["maren"], creator: "maren", created_at: 0, boards: [], meter, cards: 4, last_activity: AT, ...extra,
});
const shot = (n: number, over: Partial<ScreenView> = {}): ScreenView => ({
  title: `Screen ${n}`, group: "Carrier", status: "works", about: `What screen ${n} shows.`, id: `a000000000000001:${100 + n}`, version: 1, size: 5_000, mime: "image/png",
  at: AT - n * 60_000, by: { handle: "maren" }, available: true, w: 1280, h: 720, ...over,
});
const PAYLOAD: StatusPagePayload = {
  mode: "hourly", state: "active", generated_at: AT + 3_600_000, updated_at: AT,
  story: {
    headline: "The portal is on track: sign-in is live and billing is next", lede: "This page shows what the customer portal does today. Billing is still being built.",
    live_now: ["Customers can sign in and see their shipments.", "Staff can create customer accounts."], landing_next: ["Billing arrives next week."],
    as_of: AT, at: AT + 60_000, by: { handle: "kira", agent: "orchestrator" },
  },
  facts: {
    computed: { done_day: 3, done_week: 9, in_progress: 4, in_review: 1, blocked: 2, agents_working: 5, agent_machines: 2, last_change: AT - 600_000 },
    set: [{ label: "Live build", value: "ddee2f0bca", by: { handle: "maren", agent: "cc-9" }, at: AT }, { label: "Next release", value: "Friday", by: { handle: "maren" }, at: AT }],
  },
  screens: {
    total: 7, newest_at: AT,
    groups: [
      { id: "sign-in", name: "Sign-in", screens: [shot(1, { group: "Sign-in", title: "Sign in", route: "/login", note: "Seen signed out." }), shot(2, { group: "Sign-in", title: "Product page", status: "partial" })] },
      { id: "carrier", name: "Carrier", screens: [shot(3, { title: "Dispatch board", route: "/dispatch" }), shot(4, { title: "Approvals", status: "empty" }), shot(5, { title: "Marketplace", status: "not-built", available: false })] },
      { id: "driver-app", name: "Driver app", screens: [shot(6, { group: "Driver app", title: "Today", w: 390, h: 844, status: "empty" }), shot(7, { group: "Driver app", title: "Pay", w: 390, h: 844 })] },
    ],
  },
};
const ready = (data: StatusPagePayload) => ({ status: "ready" as const, data });
const view = (data: StatusPagePayload, over: { project?: ProjectView; group?: string } = {}) =>
  renderToStaticMarkup(<page.StatusPageView project={over.project ?? project()} state={ready(data)} group={over.group} onRetry={() => {}} />);

// ---- the address ----------------------------------------------------------------------------------------------------

test("the page has its own address, with the group of screens it scrolls to; nothing else about the routes changes", () => {
  expect(route.parseHash(`#/projects/${CH}/page`)).toMatchObject({ view: "projects", channel: CH, page: true });
  expect(route.parseHash(`#/projects/${CH}/page`).board).toBeUndefined();
  expect(route.parseHash(`#/projects/${CH}/page?group=carrier`)).toMatchObject({ page: true, group: "carrier" });
  expect(route.parseHash(`#/projects/${CH}/room?group=carrier`).group).toBeUndefined(); // only the page has groups
  expect(route.hrefFor({ view: "projects", channel: CH, page: true })).toBe(`#/projects/${CH}/page`);
  expect(route.hrefFor({ view: "projects", channel: CH, page: true, group: "driver-app" })).toBe(`#/projects/${CH}/page?group=driver-app`);
  expect(route.hrefFor({ view: "projects", channel: CH, board: "a:2", group: "x" })).toBe(`#/projects/${CH}/a%3A2`);
  expect(route.parseHash(route.hrefFor({ view: "projects", channel: CH, page: true, group: "driver-app" }))).toMatchObject({ page: true, group: "driver-app" });
  expect(route.parseHash(`#/projects/${CH}/room`)).toMatchObject({ room: true });
  expect(route.parseHash(`#/projects/${CH}/a%3A2?card=a%3A9`)).toMatchObject({ board: "a:2", card: "a:9" });
});

// ---- the plain words ------------------------------------------------------------------------------------------------

test("the facts strip: what the team set first, in the order it was set, then what Walkie counts", () => {
  const tiles = lib.factTiles(PAYLOAD.facts);
  expect(tiles.map((t) => t.label)).toEqual(["Live build", "Next release", "Done in 24 hours", "Done in 7 days", "In progress", "In review", "Blocked or waiting", "Agents working", "Last change"]);
  expect(tiles.find((t) => t.label === "Agents working")?.value).toBe("5 on 2 machines");
  expect(tiles[0]).toMatchObject({ value: "ddee2f0bca", by: "@maren/cc-9" });
  expect(tiles.at(-1)).toMatchObject({ time: AT - 600_000 });
  expect(lib.factTiles({ computed: null, set: [] })).toEqual([]);
  expect(lib.factTiles({ computed: { ...PAYLOAD.facts.computed!, last_change: null, agents_working: 0, agent_machines: 0 }, set: [] }).map((t) => [t.label, t.value]).slice(-2)).toEqual([["Blocked or waiting", "2"], ["Agents working", "None right now"]]);
  expect(lib.agentsText({ agents_working: 1, agent_machines: 1 })).toBe("1 on 1 machine");
});

test("a screen's status reads in words, one this build does not know reads plainly; a person or an agent is named", () => {
  expect(["works", "partial", "empty", "not-built"].map((s) => lib.chipOf(s).label)).toEqual(["Works", "Partial", "Empty state", "Not built yet"]);
  expect(lib.chipOf("works").tone).toBe("ok");
  expect(lib.chipOf("from-the-future")).toEqual({ label: "Not rated", tone: "idle" });
  expect(lib.whoLabel({ handle: "maren" })).toBe("@maren");
  expect(lib.whoLabel({ handle: "maren", agent: "cc-2" })).toBe("@maren/cc-2");
  expect(lib.aspectOf({ w: 1280, h: 720 })).toBe("1280 / 720");
  expect(lib.aspectOf({ w: 1280 })).toBeUndefined();
  expect([lib.isTall({ w: 390, h: 844 }), lib.isTall({ w: 1280, h: 720 }), lib.isTall({})]).toEqual([true, false, false]);
});

test("a group scrolls to just below the sticky index, however many rows the index wraps to", () => {
  // Desktop: the index sticks at the very top and is one row (40px) tall.
  expect(lib.groupScrollTop({ groupTop: 900, scrollY: 300, stickyTop: 0, indexHeight: 40 })).toBe(1148);
  // A phone: it sticks below the 48px bar and wraps to two rows (94px), so the group starts lower on the page.
  expect(lib.groupScrollTop({ groupTop: 900, scrollY: 300, stickyTop: 48, indexHeight: 94 })).toBe(1046);
  // Twelve groups on a phone wrap to more rows: the group still clears the whole index.
  expect(lib.groupScrollTop({ groupTop: 900, scrollY: 300, stickyTop: 48, indexHeight: 180 })).toBe(960);
  // Never above the top of the page.
  expect(lib.groupScrollTop({ groupTop: 20, scrollY: 0, stickyTop: 48, indexHeight: 94 })).toBe(0);
  expect(lib.groupScrollTop({ groupTop: 900, scrollY: 300, stickyTop: 0, indexHeight: 40, gap: 0 })).toBe(1160);
});

test("only the newest request's answer is shown: a late answer for what was asked before, or for another project, is dropped", async () => {
  const gate = lib.latestOnly();
  const shown: string[] = [];
  const failed: string[] = [];
  const later = <T,>(ms: number, v: T, fail = false) => new Promise<T>((ok, no) => setTimeout(() => (fail ? no(new Error(String(v))) : ok(v)), ms));
  // Asked twice in a row: the first answer comes last and is not shown over the second.
  gate.run(() => later(30, "first"), (v) => shown.push(v), (e) => failed.push(String(e)));
  gate.run(() => later(5, "second"), (v) => shown.push(v), (e) => failed.push(String(e)));
  await later(60, null);
  expect(shown).toEqual(["second"]);
  // A failure of the older request is not shown either; a failure of the newest is.
  gate.run(() => later(20, "old failure", true), (v) => shown.push(v), (e) => failed.push(String(e)));
  gate.run(() => later(5, "new failure", true), (v) => shown.push(v), (e) => failed.push(String(e)));
  await later(50, null);
  expect(failed).toEqual(["Error: new failure"]);
  // Cancelled (the page moved to another project, or went away): nothing in flight is shown.
  gate.run(() => later(10, "too late"), (v) => shown.push(v), (e) => failed.push(String(e)));
  gate.cancel();
  await later(40, null);
  expect(shown).toEqual(["second"]);
  expect(failed).toEqual(["Error: new failure"]);
});

// ---- the page -------------------------------------------------------------------------------------------------------

test("the whole page: eyebrow, headline, lede, facts, what is live and what lands next, the index, the groups, the footer", () => {
  const html = view(PAYLOAD);
  expect(html).toContain("Acme · Customer portal");
  expect(html).toContain("updated");
  expect(html).toContain('<h2 id="spage-headline" class="spage-headline">The portal is on track: sign-in is live and billing is next</h2>');
  expect(html).toContain("This page shows what the customer portal does today.");
  expect(html).toContain('<dl class="spage-facts">');
  expect(html.indexOf("Live build")).toBeLessThan(html.indexOf("Done in 24 hours"));
  expect(html).toContain("ddee2f0bca");
  expect(html).toContain("(set by @maren/cc-9)");
  expect(html).toContain("5 on 2 machines");
  expect(html).toContain(">Live now</h3>");
  expect(html).toContain("Customers can sign in and see their shipments.");
  expect(html).toContain(">Landing next</h3>");
  expect(html).toContain("Billing arrives next week.");
  expect(html).toContain('<nav class="spage-index" aria-label="Screens by group">');
  for (const [name, n] of [["Sign-in", 2], ["Carrier", 3], ["Driver app", 2]] as const) expect(html).toMatch(new RegExp(`${name}<span class="spage-count">${n}<span class="sr-only"> screens</span></span>`));
  expect(html).toContain('href="#/projects/p-00000001/page?group=carrier"');
  expect(html).toContain('id="spage-g-driver-app"');
  expect(html).toContain("Dispatch board");
  expect(html).toContain('<code class="spage-route">/dispatch</code>');
  expect(html).toContain("What screen 3 shows.");
  expect(html).toContain("Seen signed out.");
  expect(html).toContain("@maren");
  expect(html).toContain('<footer class="spage-foot">');
  expect(html).toContain("Updated <time");
  expect(html).toContain("written by WalkieTalkie");
  expect(html).toContain("cards marked confidential are never counted");
});

test("each screen's chip says its status in words; a phone-shaped one is marked; the room for an image is kept before it arrives", () => {
  const html = view(PAYLOAD);
  expect(html.match(/spage-chip is-ok">Works</g)?.length).toBe(3);
  expect(html.match(/spage-chip is-warn">Partial</g)).toHaveLength(1);
  expect(html.match(/spage-chip is-warn">Empty state</g)).toHaveLength(2);
  expect(html.match(/spage-chip is-idle">Not built yet</g)).toHaveLength(1);
  expect(html.match(/class="spage-shot is-tall"/g)).toHaveLength(2);
  expect(html).toContain('style="aspect-ratio:1280 / 720"');
  expect(html).toContain('style="aspect-ratio:390 / 844"');
  expect(html).toContain("Not on any online machine right now"); // the one that is not available
});

test("headings go in order and every id is unique and every label points at something", () => {
  const html = view(PAYLOAD);
  const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
  expect(levels[0]).toBe(2);
  for (let i = 1; i < levels.length; i++) expect((levels[i] as number) - (levels[i - 1] as number)).toBeLessThanOrEqual(1);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1] as string);
  expect(new Set(ids).size).toBe(ids.length);
  for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) expect(ids).toContain(m[1] as string);
  // The index is a list of real links; a group's section is named by its own heading.
  expect(html.match(/<a [^>]*href="#\/projects\/p-00000001\/page\?group=/g)).toHaveLength(3);
});

test("the group the address names is the one marked as current in the index", () => {
  expect(view(PAYLOAD, { group: "carrier" })).toMatch(/<a href="#\/projects\/p-00000001\/page\?group=carrier" aria-current="location">Carrier/);
  expect(view(PAYLOAD)).not.toContain('aria-current="location"');
});

// ---- empty states and the page's other faces ------------------------------------------------------------------------

test("with no screens it is friendly and gives the one command that adds one, with this project's prefix; no index", () => {
  const html = view({ ...PAYLOAD, screens: { total: 0, newest_at: null, groups: [] } });
  expect(html).toContain("No screens yet");
  expect(html).toContain('walkie projects screen POR ./screenshot.png --title &quot;Home&quot; --group &quot;Site&quot; --status works --about &quot;The home page.&quot;');
  expect(html).not.toContain("spage-index");
  expect(html).toContain("The team&#x27;s agents add them from a terminal");
});

test("with no report yet it still shows the counts and the facts, and says when the headline will come", () => {
  const html = view({ ...PAYLOAD, story: null });
  expect(html).toContain('<h2 id="spage-headline" class="spage-headline">Customer portal</h2>');
  expect(html).toContain("so the first ones appear within the hour");
  expect(html).not.toContain("Live now");
  expect(html).toContain("Done in 24 hours");
  expect(html).toContain("Dispatch board");
});

test("a list with nothing in it says so; an empty page says nothing has been added", () => {
  const empty = { ...PAYLOAD, updated_at: null, story: { ...PAYLOAD.story!, live_now: [], landing_next: [] }, facts: { computed: null, set: [] }, screens: { total: 0, newest_at: null, groups: [] } };
  const html = view(empty);
  expect(html.match(/Nothing listed yet\./g)).toHaveLength(2);
  expect(html).toContain("Nothing added yet");
  expect(html).toContain("Nothing has been added to this page yet.");
  expect(html).not.toContain("spage-facts");
});

// ---- how old what is shown is ----------------------------------------------------------------------------------------

const DAY = 24 * 3_600_000;
const HOUR = 3_600_000;
const text = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'");
/** The counts PAYLOAD's board shows, and the same with one more card blocked. */
const SAME = { blocked: 2, in_progress: 4, in_review: 1 };
/**
 * A page read now: its story written `storyAge` ago against `counts` (undefined: a report posted before the counts were carried),
 * reports switched on `since` ago. Ages stay off a unit boundary: the page's clock is read a moment before this one.
 */
const aged = (storyAge: number, counts: { blocked: number; in_progress: number; in_review: number } | undefined, over: Partial<StatusPagePayload> = {}): StatusPagePayload => {
  const now = Date.now();
  return {
    ...PAYLOAD, generated_at: now, updated_at: now - 90_000, reports_since: now - 30 * DAY,
    story: { ...PAYLOAD.story!, as_of: now - storyAge, at: now - storyAge, ...(counts ? { counts } : {}) },
    ...over,
  };
};

test("times are in whole words, counting up through minutes, hours, days, weeks, months and years", () => {
  const now = Date.UTC(2026, 9, 2, 12, 0);
  const ago = (ms: number) => time.agoPlain(now - ms, now);
  expect([0, 30_000, 59_000].map(ago)).toEqual(["just now", "just now", "just now"]);
  expect([60_000, 61_000, 59 * 60_000].map(ago)).toEqual(["1 minute ago", "1 minute ago", "59 minutes ago"]);
  expect([HOUR, 2 * HOUR, 23 * HOUR].map(ago)).toEqual(["1 hour ago", "2 hours ago", "23 hours ago"]);
  expect([DAY, 2 * DAY, 13 * DAY].map(ago)).toEqual(["1 day ago", "2 days ago", "13 days ago"]);
  expect([14 * DAY, 21 * DAY, 59 * DAY].map(ago)).toEqual(["2 weeks ago", "3 weeks ago", "8 weeks ago"]);
  expect([60 * DAY, 90 * DAY, 364 * DAY].map(ago)).toEqual(["2 months ago", "3 months ago", "12 months ago"]);
  expect([365 * DAY, 800 * DAY].map(ago)).toEqual(["1 year ago", "2 years ago"]);
  expect(time.agoPlain(now + HOUR, now)).toBe("just now"); // a time from a clock that runs ahead is never "in the future"
});

test("a story is out of date only when the numbers beside it differ from the ones it was written against and it is past two report periods", () => {
  const now = 100 * HOUR;
  const story = (age: number, counts: typeof SAME | undefined) => ({ at: now - age, ...(counts ? { counts } : {}) });
  expect(lib.storyOutOfDate(story(3 * HOUR, SAME), SAME, now)).toBe(false); // the same numbers, however old
  expect(lib.storyOutOfDate(story(21 * DAY, SAME), SAME, now)).toBe(false);
  expect(lib.storyOutOfDate(story(3 * HOUR, SAME), { ...SAME, blocked: 3 }, now)).toBe(true); // each of the three counts
  expect(lib.storyOutOfDate(story(3 * HOUR, SAME), { ...SAME, in_progress: 5 }, now)).toBe(true);
  expect(lib.storyOutOfDate(story(3 * HOUR, SAME), { ...SAME, in_review: 0 }, now)).toBe(true);
  expect(lib.storyOutOfDate(story(2 * HOUR - 60_000, SAME), { ...SAME, blocked: 3 }, now)).toBe(false); // not yet two periods
  expect(lib.storyOutOfDate(story(2 * HOUR + 60_000, SAME), { ...SAME, blocked: 3 }, now)).toBe(true);
  expect(lib.storyOutOfDate(story(21 * DAY, undefined), { ...SAME, blocked: 9 }, now)).toBe(false); // a report posted before the counts were carried
  expect(lib.storyOutOfDate(story(3 * HOUR, SAME), null, now)).toBe(false); // nothing to compare with
  expect(lib.storyOutOfDate({ at: undefined as unknown as number, counts: SAME }, { ...SAME, blocked: 3 }, now)).toBe(false); // an older daemon's story
});

test("a page with no story is overdue only when reports were switched on over two periods ago and the project has cards", () => {
  const now = 100 * HOUR;
  const cards = { last_change: now - 5 * DAY };
  expect(lib.storyOverdue(cards, now - 5 * HOUR, now)).toBe(true);
  expect(lib.storyOverdue(cards, now - 30 * 60_000, now)).toBe(false); // the first normal hour does not warn
  expect(lib.storyOverdue(cards, now - 2 * HOUR + 60_000, now)).toBe(false);
  expect(lib.storyOverdue({ last_change: null }, now - 5 * HOUR, now)).toBe(false); // nothing on the board to write about
  expect(lib.storyOverdue(null, now - 5 * HOUR, now)).toBe(false);
  expect(lib.storyOverdue(cards, null, now)).toBe(false); // off, or not known
  expect(lib.storyOverdue(cards, undefined, now)).toBe(false); // an older daemon sent no switch-on time
});

test("the story's own time is beside the headline, apart from the page's own 'updated' time", () => {
  const html = view(aged(21 * DAY + HOUR, SAME));
  const when = /<p class="spage-when">(.*?)<\/p>/.exec(html)?.[1] ?? "";
  expect(text(when)).toBe("Page updated 1 minute ago · Summary written by WalkieTalkie 3 weeks ago");
  expect(html.indexOf("spage-headline")).toBeLessThan(html.indexOf("spage-when"));
  expect(html.indexOf("spage-when")).toBeLessThan(html.indexOf("spage-lede"));
  const eyebrow = /<p class="spage-eyebrow">(.*?)<\/p>/.exec(html)?.[1] ?? "";
  expect(text(eyebrow)).toBe("Acme · Customer portal"); // the small capitals carry the name, not a time
  expect(text(html)).not.toMatch(/\b\d+(m|h|d|w) ago\b/); // nothing abbreviated anywhere on the page
});

test("a summary beside numbers that have moved says so, without promising a new one; one beside the same numbers is only dated", () => {
  const behind = view(aged(21 * DAY + HOUR, { ...SAME, blocked: 3 }));
  expect(behind).toContain('<p class="spage-notice" role="note">');
  expect(text(behind)).toContain("This summary was written 3 weeks ago. The numbers on this page (blocked, in progress, in review) have changed since then, so parts of the summary may be out of date. The facts and numbers here are current.");
  expect(text(behind)).not.toContain("writes a new summary"); // the scheduler may see no news, so no promise
  expect(behind.indexOf("spage-notice")).toBeLessThan(behind.indexOf("spage-lede")); // before the sentences it warns about
  expect(view(aged(21 * DAY + HOUR, SAME))).not.toContain("may be out of date");
  expect(view(aged(21 * DAY + HOUR, undefined))).not.toContain("may be out of date");
  expect(view(aged(10 * 60_000, { ...SAME, blocked: 3 }))).not.toContain("may be out of date"); // still inside the grace
  expect(text(view(aged(21 * DAY + HOUR, SAME)))).toContain("Summary written by WalkieTalkie 3 weeks ago");
});

test("a page still waiting for its first story says it has waited, and what to do, once reports have been on for over two periods", () => {
  const now = Date.now();
  const waiting = view(aged(0, undefined, { story: null, reports_since: now - 30 * 60_000 }));
  expect(waiting).toContain("so the first ones appear within the hour");
  expect(waiting).not.toContain("No summary has arrived yet");
  const late = view(aged(0, undefined, { story: null, reports_since: now - 5 * HOUR }));
  expect(late).toContain("No summary has arrived yet.");
  expect(late).toContain("the team&#x27;s main machine (the one that keeps the member list)");
  expect(late).toContain("running the latest Walkie");
  expect(late).not.toContain("roster authority"); // plain words
  expect(late).not.toContain("so the first ones appear within the hour");
  expect(late).not.toContain("Summary written by WalkieTalkie"); // there is no story to date
  expect(view(aged(0, undefined, { story: null, reports_since: undefined }))).toContain("so the first ones appear within the hour"); // an older daemon: no warning
});

test("a refresh that failed after a good load keeps the page and says so, with the time of what it shows and a way to try again", () => {
  const data = aged(10 * 60_000, SAME);
  const html = renderToStaticMarkup(<page.StatusPageView project={project()} state={{ status: "ready", data, refreshFailed: true }} onRetry={() => {}} />);
  expect(html).toContain('<p class="spage-notice" role="status">');
  expect(text(html)).toContain("We couldn't refresh this page just now, so it shows what it said just now.");
  expect(html).toContain(">Try again</button>");
  expect(html).toContain("The portal is on track"); // the page is still there
  expect(view(data)).not.toContain("couldn't refresh");
  // The same notice sits on a page whose report is off (what it shows is the setting).
  const off = renderToStaticMarkup(<page.StatusPageView project={project()} state={{ status: "ready", data: { ...data, mode: "off" }, refreshFailed: true }} onRetry={() => {}} />);
  expect(off).toContain("couldn&#x27;t refresh this page just now");
});

test("with the report off it explains and gives the command, and shows none of the project's data", () => {
  const html = view({ ...PAYLOAD, mode: "off" });
  expect(html).toContain("The status page is off for this project");
  expect(html).toContain("walkie projects report POR on");
  expect(html).toContain("the Hourly status report switch");
  for (const leak of ["Dispatch board", "Live build", "ddee2f0bca", "Customers can sign in", "Done in 24 hours"]) expect(html).not.toContain(leak);
});

test("an archived or deleted project says its page is no longer updated; the sentence about old screens appears as a note", () => {
  expect(view({ ...PAYLOAD, state: "archived" })).toContain("This project is archived, so its status page is no longer updated.");
  expect(view(PAYLOAD)).not.toContain("no longer updated");
  const html = view({ ...PAYLOAD, story: { ...PAYLOAD.story!, screens_note: "Screens are out of date; the newest was added 12 days ago." } });
  expect(html).toContain('<p class="spage-notice" role="note">Screens are out of date; the newest was added 12 days ago.</p>');
  const none = view({ ...PAYLOAD, story: { ...PAYLOAD.story!, screens_note: "Screens are out of date; none have been added yet." }, screens: { total: 0, newest_at: null, groups: [] } });
  expect(none).toContain('role="note">Screens are out of date; none have been added yet.');
  expect(none).toContain("No screens yet");
});

test("while loading it is a busy skeleton; a failure says why, with a retry", () => {
  const loading = renderToStaticMarkup(<page.StatusPageView project={project()} state={{ status: "loading" }} onRetry={() => {}} />);
  expect(loading).toContain('aria-busy="true"');
  const failed = renderToStaticMarkup(<page.StatusPageView project={project()} state={{ status: "error", message: "the daemon is not reachable" }} onRetry={() => {}} />);
  expect(failed).toContain("the daemon is not reachable");
  expect(failed).toContain("Retry");
  expect(failed).toContain('role="alert"');
});

// ---- what teammates wrote is text ------------------------------------------------------------------------------------

test("text written by people and agents is shown as text: no HTML, no Markdown, no link of its own", () => {
  const hostile = "<img src=x onerror=alert(1)> **bold** [click](javascript:alert(1)) <script>alert(2)</script>";
  const html = view({
    ...PAYLOAD,
    story: { ...PAYLOAD.story!, headline: hostile, lede: hostile, live_now: [hostile], landing_next: [hostile] },
    facts: { computed: PAYLOAD.facts.computed, set: [{ label: hostile.slice(0, 24), value: hostile, by: { handle: "evil", agent: "<b>x</b>" }, at: AT }] },
    screens: { total: 1, newest_at: AT, groups: [{ id: "g", name: hostile, screens: [shot(1, { group: hostile, title: hostile, about: hostile, note: hostile, route: "/x<y>" })] }] },
  });
  expect(html).not.toMatch(/<img[^>]*onerror|<script|<b>x<\/b>|<strong>/);
  expect(html).not.toMatch(/(?:href|src|action|formaction)="\s*(?:javascript|data|vbscript):/i); // the words stay visible as text; nothing acts on them
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain("**bold**");
  // The only addresses on the page are the index's own links (and the Data Room-free page has no other anchor).
  for (const m of html.matchAll(/<a [^>]*href="([^"]*)"/g)) expect(m[1]).toMatch(/^#\/projects\/p-00000001\/page\?group=/);
});

test("no component of the page puts HTML or Markdown into the document", () => {
  const dir = join(import.meta.dir, "../src/views/projects");
  for (const f of readdirSync(dir).filter((x) => /^StatusPage/.test(x))) {
    const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|RichMarkdown|markdown/i);
  }
});

// ---- a screen's image ------------------------------------------------------------------------------------------------

class FakeReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: unknown = null;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => { this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`; this.onload?.(); });
  }
}

async function withImages<T>(bytesFor: (file: string) => Uint8Array | Error, run: (calls: string[]) => Promise<T>): Promise<T> {
  const orig = client.api.roomBytes;
  const calls: string[] = [];
  const hadReader = "FileReader" in globalThis;
  const origReader = (globalThis as { FileReader?: unknown }).FileReader;
  (globalThis as { FileReader?: unknown }).FileReader = FakeReader;
  (client.api as { roomBytes: typeof orig }).roomBytes = async (_c, file) => {
    calls.push(file);
    const got = bytesFor(file);
    if (got instanceof Error) throw got;
    return got;
  };
  try { return await run(calls); }
  finally {
    (client.api as { roomBytes: typeof orig }).roomBytes = orig;
    if (hadReader) (globalThis as { FileReader?: unknown }).FileReader = origReader; else delete (globalThis as { FileReader?: unknown }).FileReader;
  }
}

test("an image is judged from its own bytes before it is shown, and shown as a data URL of the type the bytes say", async () => {
  await withImages(() => png(640, 480, 1), async () => {
    const got = await img.loadImage(CH, "img:1", 1);
    expect(got).toMatchObject({ status: "ready", width: 640, height: 480 });
    expect((got as { url: string }).url.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.peekImage(img.imageKey(CH, "img:1", 1))).toBe(got);
  });
});

test("what is not an image the page shows is broken, whatever it is called; a file no machine has is missing; neither is kept", async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  await withImages((f) => (f === "svg" ? svg : f === "huge" ? png(30_000, 30_000) : new (client.ApiError)("not_found", "no machine has it", 404)), async (calls) => {
    expect(await img.loadImage(CH, "svg", 1)).toEqual({ status: "broken" });
    expect(await img.loadImage(CH, "huge", 1)).toEqual({ status: "broken" });
    expect(await img.loadImage(CH, "gone", 1)).toEqual({ status: "missing" });
    expect(img.peekImage(img.imageKey(CH, "gone", 1))).toBeUndefined();
    await img.loadImage(CH, "gone", 1); // asked again: a machine may be back
    expect(calls.filter((c) => c === "gone")).toHaveLength(2);
  });
  await withImages(() => new Error("network"), async () => expect(await img.loadImage(CH, "net", 1)).toEqual({ status: "broken" }));
});

test("one fetch for one image however many ask, none for one already loaded; a new version is another image", async () => {
  await withImages(() => png(100, 100, 2), async (calls) => {
    await Promise.all([img.loadImage(CH, "once", 1), img.loadImage(CH, "once", 1), img.loadImage(CH, "once", 1)]);
    await img.loadImage(CH, "once", 1);
    expect(calls).toEqual(["once"]);
    await img.loadImage(CH, "once", 2);
    expect(calls).toEqual(["once", "once"]);
  });
});

test("at most 64 images are kept, the longest unused going first", async () => {
  await withImages(() => png(10, 10, 3), async () => {
    for (let i = 0; i < 70; i++) await img.loadImage(CH, `many-${i}`, 1);
    expect(img.peekImage(img.imageKey(CH, "many-0", 1))).toBeUndefined();
    expect(img.peekImage(img.imageKey(CH, "many-69", 1))).toBeDefined();
    expect(img.peekImage(img.imageKey(CH, "many-6", 1))).toBeDefined();
  });
});

test("a loaded screen is a button that enlarges it, named for its title; the image itself is described by the caption", async () => {
  const data = PAYLOAD;
  await withImages(() => png(1280, 720, 4), async () => {
    for (const g of data.screens.groups) for (const s of g.screens) await img.loadImage(CH, s.id, s.version);
    const html = view(data);
    expect(html.match(/<button type="button" class="spage-zoom" aria-label="Enlarge /g)?.length).toBe(7);
    expect(html).toContain('aria-label="Enlarge Dispatch board"');
    expect(html).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="" width="1280" height="720" loading="lazy" decoding="async"\/>/);
    expect(html).not.toContain("Not on any online machine"); // a loaded image wins over what the daemon said about availability
  });
});

test("the enlarged view is a native dialog named by the screen, with the image described in full and a way to close it", async () => {
  await withImages(() => png(1280, 720, 5), async () => {
    const s = shot(9, { title: "Dispatch board", group: "Carrier" });
    await img.loadImage(CH, s.id, s.version);
    const open = renderToStaticMarkup(<screens.Enlarged channel={CH} screen={s} onClose={() => {}} />);
    expect(open).toContain('<dialog class="spage-dialog" aria-labelledby="spage-dialog-title">');
    expect(renderToStaticMarkup(<screens.Enlarged channel={CH} screen={null} onClose={() => {}} />)).toContain('<dialog class="spage-dialog"></dialog>'); // nothing to point at while closed
    expect(open).toContain('<h4 id="spage-dialog-title">Dispatch board</h4>');
    expect(open).toContain('alt="Dispatch board (Carrier): What screen 9 shows."');
    expect(open).toContain(">Close</button>");
    const closed = renderToStaticMarkup(<screens.Enlarged channel={CH} screen={null} onClose={() => {}} />);
    expect(closed).not.toContain("<img");
    expect(closed).not.toContain("<h4");
  });
});

test("the enlarged view shows the picture its thumbnail showed, even after the bounded cache has let it go", async () => {
  await withImages(() => png(1280, 720, 6), async () => {
    const s = shot(10, { title: "Dispatch board", group: "Carrier" });
    const held = await img.loadImage(CH, s.id, s.version);
    expect(held.status).toBe("ready");
    for (let i = 0; i < 70; i++) await img.loadImage(CH, `later-${i}`, 1); // the cache keeps 64: the first one is gone
    expect(img.peekImage(img.imageKey(CH, s.id, s.version))).toBeUndefined();
    const shown = held as Extract<typeof held, { status: "ready" }>;
    const open = renderToStaticMarkup(<screens.Enlarged channel={CH} screen={s} image={shown} onClose={() => {}} />);
    expect(open).toContain(`src="${shown.url}"`);
    expect(open).not.toContain("The image is not loaded.");
    // Asked with no picture in hand and none in the cache, it says so rather than showing a broken image.
    expect(renderToStaticMarkup(<screens.Enlarged channel={CH} screen={s} onClose={() => {}} />)).toContain("The image is not loaded.");
  });
});

// ---- the list, the tab, the stream ----------------------------------------------------------------------------------

function listHtml(projects: ProjectView[]): string {
  st.projectsStore.set({ status: "ready", error: null, projects, stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const state = { ...initialState, phase: "ready" as const, me: { handle: "maren", role: "owner" } as State["me"], agents: [] };
  return renderToStaticMarkup(<StaticStore state={state}><ProjectList /></StaticStore>);
}

test("the Projects list links to the page for a project whose report is on, beside its row and never inside it; reports off or archived: nothing new", () => {
  const html = listHtml([project(), project({ channel: "p-00000002", name: "Hiring", prefix: "HR", status_report: "off" }), project({ channel: "p-00000003", name: "Old", prefix: "OLD", state: "archived" })]);
  expect(html.match(/class="project-page-link"/g)).toHaveLength(1);
  expect(html).toContain(`<a class="project-page-link" href="#/projects/${CH}/page">Status page</a>`);
  const rows = [...html.matchAll(/<a class="project-row"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1] ?? "");
  expect(rows).toHaveLength(3);
  for (const inner of rows) expect(inner).not.toContain("project-page-link");
});

function boardHtml(p: ProjectView, opts: { page?: boolean } = {}): string {
  st.projectsStore.set({ status: "ready", error: null, projects: [{ ...p, boards: [{ id: "a000000000000001:2", name: "Main", columns: [{ id: "todo", name: "To do", role: "todo" }], state: "active", created_at: 0, created_by: { handle: "maren", node: "a000000000000001" }, meter, live_cards: 0 }] }], stubs: [], cards: { [p.channel]: [] }, cardsError: {}, rooms: { [p.channel]: [] }, roomsError: {} });
  const state = { ...initialState, phase: "ready" as const, me: { handle: "maren", role: "owner" } as State["me"], agents: [] };
  return renderToStaticMarkup(<StaticStore state={state}><ProjectBoard channel={p.channel} page={opts.page === true} /></StaticStore>);
}

test("the project has a Status page tab beside its boards and its Data Room, only while the report is on, and the board is not shown on it", () => {
  const board = boardHtml(project());
  expect(board).toContain(`class="tab-link pboard-page-tab" href="#/projects/${CH}/page"`);
  expect(board).toContain("Status page");
  expect(boardHtml(project({ status_report: "off" }))).not.toContain("pboard-page-tab");
  const onPage = boardHtml(project(), { page: true });
  expect(onPage).toContain('class="tab-link is-on pboard-page-tab"');
  expect(onPage).toContain('aria-current="page"');
  expect(onPage).not.toContain("pboard-filters");
  expect(board).toContain("pboard-filters");
  // The boards' own tabs are not current while the page is.
  expect(onPage).not.toMatch(/class="tab-link is-on"[^>]*>Main/);
});

test("the stream says when a page or its screens changed, and an open page looks again; another project's change is not its business", () => {
  st.projectsStore.set({ status: "ready", error: null, projects: [project()], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });
  const before = st.projectsStore.get().pageTicks?.[CH] ?? 0;
  st.projectsStore.delta({ channel: CH, page: true });
  st.projectsStore.delta({ channel: CH, room: true });
  st.projectsStore.delta({ channel: "p-00000009", page: true });
  st.projectsStore.delta({ channel: CH, cards: [] });
  const ticks = st.projectsStore.get().pageTicks ?? {};
  expect([ticks[CH], ticks["p-00000009"]]).toEqual([before + 2, 1]);
});

// ---- the stylesheet --------------------------------------------------------------------------------------------------

const CSS = readFileSync(join(import.meta.dir, "../src/styles/status-page.css"), "utf8");
const TOKENS = readFileSync(join(import.meta.dir, "../src/styles/tokens.css"), "utf8");

test("dark and light: the page names only the dashboard's theme tokens for colour, never a colour of its own", () => {
  const body = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  expect(body).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(/i);
  expect(body).not.toMatch(/\b(?:white|black|red|green|blue|gray|grey|orange|yellow)\b\s*[;}]/i);
  // Every colour token it uses is defined for the dark default and for the light theme.
  const dark = /:root \{([\s\S]*?)\n\}/.exec(TOKENS)?.[1] ?? "";
  const light = /:root\[data-theme="light"\] \{([\s\S]*?)\n\}/.exec(TOKENS)?.[1] ?? "";
  const used = [...new Set([...body.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string))];
  const colour = used.filter((t) => !/^--(?:fs|r|s|font|dur|ease|rail|topbar|tabbar|focus-ring)\b/.test(t));
  expect(colour.length).toBeGreaterThan(10);
  for (const t of colour) {
    expect(dark).toContain(`${t}:`);
    expect(light).toContain(`${t}:`);
  }
});

test("phone width: one column in a 16px gutter, the index below the phone's own bar, images that never overflow, no fixed widths", () => {
  expect(CSS).toMatch(/@media \(max-width: 860px\)/);
  expect(CSS).toMatch(/\.spage-index \{ top: 48px; \}/);
  expect(CSS).toContain("repeat(auto-fill, minmax(min(100%, 320px), 1fr))");
  expect(CSS).toMatch(/\.spage-zoom img \{[^}]*width: 100%;[^}]*height: auto;/);
  expect(CSS).toMatch(/\.spage-dialog img \{[^}]*max-width: 100%/);
  const projects = readFileSync(join(import.meta.dir, "../src/styles/projects.css"), "utf8");
  expect(projects).toMatch(/\.spage \{ margin-right: 16px; \}|\.status-report, \.spage \{ margin-right: 16px; \}/);
  expect(CSS.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/(?<![-\w])width: \d{3,}px/); // nothing is a fixed 300px+ wide
});

test("nothing inside the page can push it sideways: one track as wide as the page, and a long command wraps in its box", () => {
  expect(CSS).toMatch(/\.spage \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  expect(CSS).toMatch(/\.spage \.cmd-code \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/);
  expect(CSS).toMatch(/\.spage \.cmd \{[^}]*height: auto/);
  expect(CSS).toMatch(/\.spage \.cmd-code \{[^}]*text-align: left/);
  expect(CSS).toMatch(/\.spage-cap-head b \{[^}]*overflow-wrap: anywhere/);
  expect(CSS).toMatch(/\.spage-route \{[^}]*overflow-wrap: anywhere/);
});

test("the longest text every field takes, with no place to break it, wraps where it is: every text a person or an agent writes can wrap", () => {
  // A real browser showed each of these widening the page (a fact label, a group name in the index) or stretching a screen's card
  // to 2200px so its picture was cut to a sliver (an unbroken `about`, `route` or `note`). Each box that holds one wraps it, and
  // the places that lay text out in a grid have a track that is no wider than the box.
  const escaped = (sel: string) => sel.replace(/[.\\^$*+?()[\]{}|]/g, "\\$&");
  for (const sel of [".spage-eyebrow", ".spage-headline", ".spage-lede", ".spage-notice", ".spage-fact dt", ".spage-fact dd", ".spage-cols li", ".spage-index a", ".spage-group h3",
    ".spage-cap-head b", ".spage-route", ".spage-about", ".spage-note-line", ".spage-by", ".spage-ph p", ".spage-dialog-head h4", ".spage-foot p", ".spage-when"]) {
    expect(CSS, sel).toMatch(new RegExp(`${escaped(sel)} \\{[^}]*overflow-wrap: anywhere`));
  }
  for (const sel of [".spage-top", ".spage-shot"]) expect(CSS, sel).toMatch(new RegExp(`${escaped(sel)} \\{[^}]*grid-template-columns: minmax\\(0, 1fr\\)`));
  expect(CSS).toMatch(/\.spage-index a \{[^}]*max-width: 100%/);
});

test("the sticky index never takes over the screen: it is capped at a third of the window and scrolls inside itself", () => {
  expect(CSS).toMatch(/\.spage-index \{[^}]*max-height: min\(34vh, 260px\);[^}]*overflow-y: auto/);
});

test("a keyboard reaches everything: the links, the thumbnails and the dialog's close button all show where focus is", () => {
  expect(CSS).toMatch(/\.spage-index a:focus-visible \{[^}]*outline/);
  expect(CSS).toMatch(/\.spage-zoom:focus-visible \{[^}]*outline/);
  expect(CSS).toMatch(/\.spage-zoom \{[^}]*cursor: zoom-in/);
});
