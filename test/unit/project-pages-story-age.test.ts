// PROJECT-PAGES-1: how a status page knows its story has been overtaken. The report carries the counts the summary was written
// against (blocked, in progress, in review); the page flags the story only when today's counts differ and the story is past its
// two-hour grace. Nothing in the comparison reads a machine's clock: a lead whose clock runs ahead gets its story dated by when this
// daemon received it, and a change that moves no count (an archive of a to-do card, a reorder) never flags. Also here: the time
// reporting was switched on. Each row of the reviewer's table (a real report through prepareProjectReports and finish, one change, three hours with
// no new report) is a test.
import { afterEach, describe, expect, test } from "bun:test";
import type { PreparedTurn, SkippedTurn } from "../../src/daemon/orchestrator/prepared.ts";
import { buildPage } from "../../src/daemon/projects/page.ts";
import { updateBoard, updateCard, updateProject } from "../../src/daemon/projects/service.ts";
import { prepareProjectReports } from "../../src/daemon/projects/status-report.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import type { BodyOf } from "../../src/protocol/schemas.ts";
import { storyOutOfDate } from "../../web/src/lib/status-page.ts";
import { reportsWorld } from "../helpers/project-reports.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const H = 3_600_000;
const turn = (r: PreparedTurn | SkippedTurn): PreparedTurn => { if ("skip" in r) throw new Error(`skip: ${r.skip}`); return r; };
const PAGE = ["<page>", "<headline>The website relaunch is blocked on one thing today</headline>", "<lede>One card is blocked and two are waiting to start. Nothing else is moving yet.</lede>",
  "<live-now>\n</live-now>", "<landing-next>\n- The second card.\n</landing-next>", "</page>"].join("\n");
const REPORT = "**Blocked:** one card.\n\n**Done since the last report**\n- Nothing.\n\n**Next**\n- Second card.";
const block = (channel: string, body: string) => `<status-report project="${channel}">\n${body}\n</status-report>`;

type World = Awaited<ReturnType<typeof delivered>>;

/** A project with one blocked card and two waiting, and one real report (written by the duty's own turn, delivered by its finish). */
async function delivered() {
  const t = reportsWorld(cleanups);
  const web = await t.project("Website", "WEB");
  const blocked = t.card(web, "Blocked thing", { labels: ["blocker"] });
  const second = t.card(web, "Second card");
  const third = t.card(web, "Third card");
  t.tick();
  const prepared = turn(await prepareProjectReports(t.deps, () => true));
  await prepared.finish?.({ text: block(web.channel, `${REPORT}\n\n${PAGE}`), ok: true }, t.wall());
  t.idx.flushAll();
  const page = () => { t.idx.flushAll(); return buildPage(t.deps, t.idx.project(web.channel) as ProjectView); };
  /** What the page says three hours on, with no new report. */
  const later = (ms = 3 * H) => { t.tick(ms); const p = page(); return { page: p, flagged: p.story ? storyOutOfDate(p.story, p.facts.computed, p.generated_at) : null }; };
  return { t, web, blocked, second, third, page, later };
}

describe("the story carries the counts it was written against", () => {
  test("the report's post holds blocked, in progress and in review, and the page hands them on", async () => {
    const w = await delivered();
    const p = w.page();
    expect(p.story?.counts).toEqual({ blocked: 1, in_progress: 0, in_review: 0 });
    expect(p.facts.computed).toMatchObject({ blocked: 1, in_progress: 0, in_review: 0 });
  });

  test("nothing changed: a story three hours old is not flagged", async () => {
    const w = await delivered();
    expect(w.later().flagged).toBe(false);
  });
});

describe("each row of the reviewer's table, three hours on with no new report", () => {
  const rows: Array<[string, (w: World) => void, boolean]> = [
    ["archive a to-do card: no count moved, so no notice (and the scheduler sees no news)", (w) => { updateCard(w.t.w, w.third.id, { state: "archived" }); }, false],
    ["reorder a card: no notice", (w) => { updateCard(w.t.w, w.third.id, { before: w.second.id }); }, false],
    ["delete the blocked card: the summary now contradicts the counts", (w) => { updateCard(w.t.w, w.blocked.id, { state: "deleted" }); }, true],
    ["label the blocked card confidential", (w) => { updateCard(w.t.w, w.blocked.id, { labels: ["blocker", "confidential"] }); }, true],
    ["change a column's role to active", (w) => {
      const board = (w.t.idx.project(w.web.channel) as ProjectView).boards[0]!;
      updateBoard(w.t.w, w.web.channel, board.id, { columns: board.columns.map((c) => (c.role === "todo" ? { ...c, role: "active" as const } : c)) });
    }, true],
    ["archive the board", (w) => {
      const board = (w.t.idx.project(w.web.channel) as ProjectView).boards[0]!;
      updateBoard(w.t.w, w.web.channel, board.id, { state: "archived" });
    }, true],
  ];
  for (const [name, act, flagged] of rows) {
    test(`${name} -> ${flagged ? "notice" : "no notice"}`, async () => {
      const w = await delivered();
      w.t.tick(60_000);
      act(w);
      w.t.idx.flushAll();
      expect(w.later().flagged).toBe(flagged);
    });
  }

  test("a change that moves a count is still inside the grace when it is under two hours old: no notice yet", async () => {
    const w = await delivered();
    w.t.tick(60_000);
    updateCard(w.t.w, w.blocked.id, { state: "deleted" });
    expect(w.later(30 * 60_000).flagged).toBe(false);
    expect(w.later(2 * H).flagged).toBe(true);
  });

  test("a report post from before the counts were carried (no counts) is never flagged, whatever moved", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    t.card(web, "One");
    t.core.emit("msg.post", { text: "**Status report · Website · as of x**\n\nBody.", status_report: { v: 1, as_of: t.wall() },
      status_page: { v: 1, headline: "Website relaunch is on track", lede: "Nothing is blocked and the work is moving along as planned today.", live_now: [], landing_next: [] } } as BodyOf<"msg.post">,
    { channel: web.channel, agent: "orchestrator" });
    t.tick(60_000);
    t.card(web, "Two, blocked", { labels: ["blocker"] });
    t.tick(5 * H);
    t.idx.flushAll();
    const p = buildPage(t.deps, t.idx.project(web.channel) as ProjectView);
    expect(p.story?.counts).toBeUndefined();
    expect(storyOutOfDate(p.story!, p.facts.computed, p.generated_at)).toBe(false);
  });
});

describe("no machine's clock decides", () => {
  test("a lead whose clock runs five hours ahead: its story is dated by when this daemon received it, and a later change flags after the grace", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    t.card(web, "One");
    const ahead = t.wall() + 5 * H;
    const lead = t.teammate("lead", "owner");
    lead.post(web.channel, { text: "**Status report · Website · as of x**\n\nBody.", status_report: { v: 1, as_of: ahead },
      status_page: { v: 1, headline: "Website relaunch is on track for Friday", lede: "Nothing is blocked and the work is moving along as planned today.", live_now: [], landing_next: [],
        counts: { blocked: 0, in_progress: 0, in_review: 0 } } }, ahead, "orchestrator");
    const received = t.wall();
    t.tick(60_000);
    t.card(web, "Two, blocked", { labels: ["blocker"] });
    t.tick(4 * H);
    t.idx.flushAll();
    const p = buildPage(t.deps, t.idx.project(web.channel) as ProjectView);
    expect(p.story).not.toBeNull();
    expect(p.story!.at).toBe(received); // not five hours in the future, and not clamped to "just now" either
    expect(p.generated_at - p.story!.at).toBeGreaterThanOrEqual(4 * H);
    expect(storyOutOfDate(p.story!, p.facts.computed, p.generated_at)).toBe(true);
  });

  test("a lead whose clock runs behind: the story is as old as its own stamp says, and an unchanged board never flags", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    t.card(web, "One");
    const behind = t.wall() - 3 * H;
    t.teammate("lead", "owner").post(web.channel, { text: "**Status report · Website · as of x**\n\nBody.", status_report: { v: 1, as_of: behind },
      status_page: { v: 1, headline: "Website relaunch is on track for Friday", lede: "Nothing is blocked and the work is moving along as planned today.", live_now: [], landing_next: [],
        counts: { blocked: 0, in_progress: 0, in_review: 0 } } }, behind, "orchestrator");
    t.tick(60_000);
    t.idx.flushAll();
    const p = buildPage(t.deps, t.idx.project(web.channel) as ProjectView);
    expect(storyOutOfDate(p.story!, p.facts.computed, p.generated_at)).toBe(false);
  });
});

describe("when reporting was switched on", () => {
  test("the page says when the project's hourly report was switched on, and null when it is off", async () => {
    const t = reportsWorld(cleanups);
    const onAt = t.wall();
    const web = await t.project("Website", "WEB");
    const page = () => { t.idx.flushAll(); return buildPage(t.deps, t.idx.project(web.channel) as ProjectView); };
    expect(page().reports_since).toBe(onAt);
    t.tick(H);
    await updateProject(t.w, web.channel, { status_report: "off" });
    expect(page().reports_since).toBeNull();
    t.tick(H);
    const again = t.wall();
    await updateProject(t.w, web.channel, { status_report: "hourly" });
    expect(page().reports_since).toBe(again);
  });
});
