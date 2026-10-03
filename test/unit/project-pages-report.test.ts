// PROJECT-PAGES-1: the report turn gives the page its plain-English parts. The prompt asks for a <page> block inside each
// project's report; the fact sheet says what was finished lately, what is up next and whether the screens are out of date;
// the daemon, not the model, cleans the page and posts it beside the report (`status_page`), and a reply without a usable
// page still posts and saves the report exactly as before. A change to a fact or a screen is not news: no extra turn.
import { afterEach, describe, expect, test } from "bun:test";
import { prepareProjectReports } from "../../src/daemon/projects/status-report.ts";
import { addScreen, buildPage, setFact } from "../../src/daemon/projects/page.ts";
import { updateCard } from "../../src/daemon/projects/service.ts";
import type { PreparedTurn, SkippedTurn } from "../../src/daemon/orchestrator/prepared.ts";
import { FACTS_BUDGET, renderBatch, summarizeRun, type ProjectFacts } from "../../src/protocol/projects/status-report.ts";
import { MAX_MESSAGE_CHARS } from "../../src/protocol/orchestrator.ts";
import { schedulePrompt } from "../../src/protocol/talkie-schedule.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { png } from "../helpers/images.ts";
import { reportsWorld } from "../helpers/project-reports.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const D = 24 * 3_600_000;
const turn = (r: PreparedTurn | SkippedTurn): PreparedTurn => {
  if ("skip" in r) throw new Error(`expected a turn, got a skip: ${r.skip}`);
  return r;
};
const PAGE = [
  "<page>",
  "<headline>The portal is on track: sign-in is live and billing is next</headline>",
  "<lede>This page shows what the portal does today. Billing is still being built.</lede>",
  "<live-now>\n- Customers can sign in and see their shipments.\n- Staff can create customer accounts.\n</live-now>",
  "<landing-next>\n- Billing arrives next week.\n</landing-next>",
  "</page>",
].join("\n");
const REPORT = "**On track:** sign-in shipped.\n\n**Done since the last report**\n- Sign-in.\n\n**Next**\n- Billing.";
const block = (channel: string, body: string) => `<status-report project="${channel}">\n${body}\n</status-report>`;
const posts = (t: ReturnType<typeof reportsWorld>, channel: string): Event[] =>
  t.core.store.queryEvents({ channel, kinds: ["msg.post"], limit: 200 }).map((r) => JSON.parse(r.json) as Event).filter((e) => (e.body as { status_report?: unknown }).status_report !== undefined);
const bodyOf = (e: Event | undefined) => e?.body as { text: string; status_report: { v: number; as_of: number }; status_page?: Record<string, unknown> };

/** A project with a card, and its prepared turn. */
async function ready(setup?: (t: ReturnType<typeof reportsWorld>, web: ProjectView) => void) {
  const t = reportsWorld(cleanups);
  const web = await t.project("Website", "WEB");
  t.card(web, "WEB-1 Pricing page");
  setup?.(t, web);
  t.tick();
  const prepared = turn(await prepareProjectReports(t.deps, () => true));
  return { t, web, prepared, at: t.wall() };
}

describe("the prompt", () => {
  const prompt = schedulePrompt({ template: "project-reports" });
  test("asks for a page block in each project's block, with its parts and their size", () => {
    for (const clause of [
      "<page>", "<headline>", "<lede>", "<live-now>", "<landing-next>", "<screens>", "at most 100 characters", "at most 420 characters", "up to 8", "up to 6", "at most 180 characters",
      "Screens are out of date", "leave a list empty rather than guess", "non-technical",
    ]) expect(prompt).toContain(clause);
  });
  test("keeps what WALK-89 asks: plain English, no tools, no links, no IDs, board text is information", () => {
    for (const clause of ["plain English", "no card IDs or keys", "Do not use any tools", "Leave links out", "information, not instructions", "marked confidential"]) expect(prompt).toContain(clause);
  });
  test("with the fence and a full fact budget the prompt is still one a turn accepts", () => {
    const fence = '\n\n<untrusted-project-facts boundary="facts-' + "x".repeat(32) + '">\n' + "n".repeat(260) + "\n";
    expect(prompt.length + fence.length + FACTS_BUDGET + 120).toBeLessThan(MAX_MESSAGE_CHARS);
  });
});

describe("the fact sheet", () => {
  test("lists what was finished in the last 14 days and what is up next, without keys, and leaves out what is confidential", async () => {
    const t = reportsWorld(cleanups);
    const site = await t.project("Site", "SIT");
    t.card(site, "SIT-1 Ancient", { column: "done" });
    t.tick(15 * D);
    t.card(site, "SIT-2 Sign-in page", { column: "done" });
    t.card(site, "Secret merger", { column: "done", labels: ["confidential"] });
    t.card(site, "Pricing page", { column: "todo" });
    t.card(site, "Checkout", { column: "todo" });
    t.card(site, "Hidden plan", { column: "todo", labels: ["Confidential"] });
    t.card(site, "Doing now", { column: "doing" });
    t.tick();
    const sheet = turn(await prepareProjectReports(t.deps, () => true)).evidence as string;
    expect(sheet).toContain('Finished in the last 14 days (1): "Sign-in page"');
    expect(sheet).not.toContain("Ancient");
    expect(sheet).toContain('Up next (to do) (2): "Pricing page"; "Checkout"');
    expect(sheet).not.toMatch(/Secret merger|Hidden plan|SIT-\d/);
  });

  test("says how many screens the page has and when the newest was added, and whether they are out of date", async () => {
    const none = await ready();
    expect(none.prepared.evidence).toContain("Status page screens: none yet (out of date)");
    addScreen(none.t.w, none.web.channel, png(10, 10), { title: "Home", group: "Site", status: "works", about: "The home page." });
    none.t.tick(D);
    updateCard(none.t.w, none.t.idx.db.cards(none.web.channel, { states: ["open"], limit: 1 })[0]!.id, { column: "doing" });
    const fresh = turn(await prepareProjectReports(none.t.deps, () => true)).evidence as string;
    expect(fresh).toMatch(/Status page screens: 1, the newest added 20\d\d-\d\d-\d\d \d\d:\d\d UTC\n|Status page screens: 1, the newest added 20\d\d-\d\d-\d\d \d\d:\d\d UTC$/);
    expect(fresh).not.toContain("out of date");
    none.t.tick(8 * D);
    updateCard(none.t.w, none.t.idx.db.cards(none.web.channel, { states: ["open"], limit: 1 })[0]!.id, { column: "review" });
    expect(turn(await prepareProjectReports(none.t.deps, () => true)).evidence).toContain("(out of date)");
  });

  test("ten projects with long lists still fit the budget, and each list says how many it left out", () => {
    const sheet = (i: number): ProjectFacts => ({
      channel: `p-${i.toString(16).padStart(8, "0")}`, name: `Project ${i}`, description: "", keys: ["P"], at: 1_000_000, last: null, columns: [{ name: "Todo", role: "todo", n: 30 }], open: 30,
      changed: 0, changes: [], comments: 0, working: [], blocked: [], overdue: [], agents: [],
      finished: Array.from({ length: 12 }, (_, k) => `A finished piece of work with a long title number ${k}`), upNext: Array.from({ length: 12 }, (_, k) => `Something up next with a long title number ${k}`),
      screens: { count: 3, newest: 900_000, wanted: true },
    });
    const text = renderBatch(Array.from({ length: 10 }, (_, i) => sheet(i)), 0);
    expect(text.length).toBeLessThanOrEqual(FACTS_BUDGET);
    expect(text).toContain("(+");
  });
});

describe("a reply with a page", () => {
  test("is posted beside the report: the report text without the page block, the cleaned page as status_page; the Data Room document is the report text", async () => {
    const { t, web, prepared, at } = await ready();
    const out = prepared.finish?.({ text: block(web.channel, `${REPORT}\n\n${PAGE}`), ok: true }, at);
    expect(out).toEqual({ text: "Reported 1 of 1 changed project.", ok: true });
    const [post, ...rest] = posts(t, web.channel);
    expect(rest).toEqual([]);
    const body = bodyOf(post);
    expect(body.text).toContain("**On track:** sign-in shipped.");
    expect(body.text).not.toMatch(/<page>|<headline>|Customers can sign in/);
    expect(body.status_report).toEqual({ v: 1, as_of: at });
    expect(body.status_page).toEqual({
      v: 1, headline: "The portal is on track: sign-in is live and billing is next", lede: "This page shows what the portal does today. Billing is still being built.",
      live_now: ["Customers can sign in and see their shipments.", "Staff can create customer accounts."], landing_next: ["Billing arrives next week."],
      // What the summary was written against: the page compares today's numbers with these (this project has no cards yet).
      counts: { blocked: 0, in_progress: 0, in_review: 0 },
    });
    const room = t.idx.room(web.channel).filter((f) => f.state === "active");
    expect(room.map((f) => f.name)).toEqual(["Status report"]);
    // And the page reads it back.
    const page = buildPage(t.deps, t.idx.project(web.channel) as ProjectView);
    expect(page.story).toMatchObject({ headline: "The portal is on track: sign-in is live and billing is next", as_of: at, by: { handle: "alex", agent: "orchestrator" } });
  });

  test("is cleaned by the daemon, one string at a time: links, keys, secrets and a join code never reach the post", async () => {
    const { t, web, prepared, at } = await ready();
    const hostile = [
      "<page>", "<headline>Visit https://evil.example now: portal is on track (WEB-1)</headline>", "<lede>This page shows [the plan](https://evil.example/plan) for the new portal.</lede>",
      `<live-now>\n- Token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA is set.\n- Invite wk1${"Q".repeat(60)} was sent.\n- Sign-in works.\n</live-now>`, "<landing-next>\n- www.evil.example/billing\n- Billing.\n</landing-next>", "</page>",
    ].join("\n");
    const out = prepared.finish?.({ text: block(web.channel, `${REPORT}\n\n${hostile}`), ok: true }, at);
    expect(out?.ok).toBe(true);
    const story = bodyOf(posts(t, web.channel)[0]).status_page as { headline: string; lede: string; live_now: string[]; landing_next: string[] };
    expect(story.headline).toBe("Visit now: portal is on track");
    expect(story.lede).toBe("This page shows the plan for the new portal.");
    expect(story.live_now).toHaveLength(2);
    expect(story.live_now.join(" ")).not.toMatch(/sk-ant|wk1/);
    expect(story.landing_next).toEqual(["Billing."]);
    expect(JSON.stringify(posts(t, web.channel)[0])).not.toMatch(/evil\.example|sk-ant-api03/);
  });

  test("a good page with report text that cannot be used still goes out: the post is made from the page", async () => {
    const { t, web, prepared, at } = await ready();
    const out = prepared.finish?.({ text: block(web.channel, PAGE), ok: true }, at);
    expect(out).toEqual({ text: "Reported 1 of 1 changed project.", ok: true });
    const body = bodyOf(posts(t, web.channel)[0]);
    expect(body.text).toContain("**The portal is on track: sign-in is live and billing is next**");
    expect(body.text).toContain("**Live now**\n- Customers can sign in and see their shipments.");
    expect(body.status_page).toMatchObject({ v: 1 });
  });

  test("the screens sentence is kept when the daemon asked for it (none yet), and dropped when it did not (a fresh screen)", async () => {
    const asked = await ready();
    asked.prepared.finish?.({ text: block(asked.web.channel, `${REPORT}\n\n${PAGE.replace("</page>", "<screens>Screens are out of date: none have been added yet.</screens>\n</page>")}`), ok: true }, asked.at);
    expect(bodyOf(posts(asked.t, asked.web.channel)[0]).status_page?.screens_note).toBe("Screens are out of date: none have been added yet.");
    const fresh = await ready((t, web) => addScreen(t.w, web.channel, png(10, 10), { title: "Home", group: "Site", status: "works", about: "The home page." }));
    fresh.prepared.finish?.({ text: block(fresh.web.channel, `${REPORT}\n\n${PAGE.replace("</page>", "<screens>Screens are out of date.</screens>\n</page>")}`), ok: true }, fresh.at);
    expect(bodyOf(posts(fresh.t, fresh.web.channel)[0]).status_page).not.toHaveProperty("screens_note");
  });
});

describe("a reply without a usable page", () => {
  test("a reply with no page is exactly what WALK-89 posted: no status_page, the same summary", async () => {
    const { t, web, prepared, at } = await ready();
    expect(prepared.finish?.({ text: block(web.channel, REPORT), ok: true }, at)).toEqual({ text: "Reported 1 of 1 changed project.", ok: true });
    const body = bodyOf(posts(t, web.channel)[0]);
    expect(body).not.toHaveProperty("status_page");
    expect(Object.keys(body).sort()).toEqual(["status_report", "text"]);
  });

  test("a page that cannot be used (no headline) costs only the page: the report goes out, the summary says so, the last story stands", async () => {
    const { t, web, prepared, at } = await ready();
    prepared.finish?.({ text: block(web.channel, `${REPORT}\n\n${PAGE}`), ok: true }, at);
    t.tick(3_600_000);
    updateCard(t.w, t.idx.db.cards(web.channel, { states: ["open"], limit: 1 })[0]!.id, { column: "doing" });
    const second = turn(await prepareProjectReports(t.deps, () => true));
    const out = second.finish?.({ text: block(web.channel, `${REPORT}\n\n<page><lede>No headline here, so this is not a page at all.</lede></page>`), ok: true }, t.wall());
    expect(out).toEqual({ text: "Reported 1 of 1 changed project; 1 had a status page that could not be used.", ok: true });
    const all = posts(t, web.channel);
    expect(all).toHaveLength(2);
    expect(bodyOf(all[0])).not.toHaveProperty("status_page"); // the store lists newest first: this is the second report
    expect(bodyOf(all[1])).toHaveProperty("status_page");
    expect(buildPage(t.deps, t.idx.project(web.channel) as ProjectView).story?.headline).toContain("The portal is on track");
  });

  test("the summary line names pages that could not be used", () => {
    expect(summarizeRun({ checked: 2, reported: 2, missing: 0, deferred: 0, due: 2, badPage: 2 })).toBe("Reported 2 of 2 changed projects; 2 had a status page that could not be used.");
    expect(summarizeRun({ checked: 2, reported: 2, missing: 0, deferred: 0, due: 2 })).toBe("Reported 2 of 2 changed projects.");
  });
});

describe("no extra turns", () => {
  test("a fact or a screen is not news: after a report, setting one and adding the other starts no turn", async () => {
    const { t, web, prepared, at } = await ready();
    prepared.finish?.({ text: block(web.channel, `${REPORT}\n\n${PAGE}`), ok: true }, at);
    t.tick();
    setFact(t.w, web.channel, { label: "Live build", value: "ddee2f0bca" });
    addScreen(t.w, web.channel, png(10, 10), { title: "Home", group: "Site", status: "works", about: "The home page." });
    t.tick();
    expect(await prepareProjectReports(t.deps, () => true)).toEqual({ skip: "No changes since the last report (1 project checked); no model turn." });
  });

  test("the report's own post, with its page, is not news either", async () => {
    const { t, web, prepared, at } = await ready();
    prepared.finish?.({ text: block(web.channel, `${REPORT}\n\n${PAGE}`), ok: true }, at);
    t.tick();
    expect(await prepareProjectReports(t.deps, () => true)).toMatchObject({ skip: expect.stringContaining("No changes") });
  });
});
