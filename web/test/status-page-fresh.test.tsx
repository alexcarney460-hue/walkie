// How the status page tells a reader how old what it shows is, in real Chromium at phone and desktop width in both themes: the story's
// own time (the page's "updated" time moves with any fact or screen, the story's does not), a plain notice when the story has not
// caught up with the board, the message of a page that has waited too long for its first story, a refresh that failed after a good
// load, whole words for times, and a time cue in the page's own size. Run with the supplied offline browser, or set
// WALKIE_PLAYWRIGHT_MODULE / PLAYWRIGHT_BROWSERS_PATH.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserTooling, bundleFixture } from "./browser-bundle.ts";

const root = resolve(import.meta.dir, "../..");
const source = (path: string) => JSON.stringify(join(root, path));

// Skipped where the supplied browser (or the one WALKIE_PLAYWRIGHT_MODULE / PLAYWRIGHT_BROWSERS_PATH name) is not installed.
const tooling = browserTooling();

test.skipIf(!tooling)("the story's age, a story behind the board, a first story overdue and a failed refresh, in Chromium at phone/desktop widths and both themes", async () => {
  const tools = tooling!;
  const dir = mkdtempSync("/tmp/walkie-page-fresh-");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const css = (await Bun.file(join(root, "web/src/main.tsx")).text()).matchAll(/import "(\.\/styles\/[^" ]+)"/g);
    const fixture = `
import React from ${source("web/node_modules/react/index.js")};
import { createRoot } from ${source("web/node_modules/react-dom/client.js")};
import { ProjectBoard } from ${source("web/src/views/projects/ProjectBoard.tsx")};
import { api, ApiError } from ${source("web/src/api/client.ts")};
import { projectsStore } from ${source("web/src/state/projects.ts")};
import { StaticStore } from ${source("web/src/state/store.tsx")};
import { initialState } from ${source("web/src/state/reducer.ts")};
import { useRoute } from ${source("web/src/lib/route.ts")};
${[...css].map((m) => `import ${source("web/src/" + m[1]!.slice(2))};`).join("\n")}
const DAY = 86400000, HOUR = 3600000;
// The page's own clock is read when its modules load, a moment before this line: stay off a unit boundary so "3 weeks" is 3 weeks.
const now = Date.now() - 5000;
const names = ["Stale", "Quiet", "Fresh", "Late", "First", "Flaky"];
const projects = names.map((name) => ({ channel: name, id: name, name, prefix: name.toUpperCase(), folder: "Ops", description: "", paths: [], meter_mode: "count", automations: {}, state: "active", status_report: "hourly", admins: [], creator: "maren", created_at: 0, boards: [{ id: "main", name: "Main", state: "active", columns: [{ id: "todo", name: "To do", role: "todo" }], meter: { mode: "count", done: 0, counted: 0, by_role: {} } }], cards: 0, meter: { mode: "count", done: 0, counted: 0, by_role: {} } }));
// What the summary was written against, and the board today (four blocked): the report's post carries the counts, the page compares.
const THEN = { blocked: 0, in_progress: 0, in_review: 0 };
const NOW_COUNTS = { blocked: 4, in_progress: 0, in_review: 0 };
const story = (at, counts) => ({ headline: "Billing is on track for the Friday launch", lede: "The new invoices page works for every customer. Nothing is blocked and the team expects to finish this week.", live_now: ["Customers can pay by card."], landing_next: ["Friday launch."], as_of: at, at, by: { handle: "maren", agent: "orchestrator" }, ...(counts ? { counts } : {}) });
const computed = (counts) => ({ done_day: 0, done_week: 0, in_progress: counts.in_progress, in_review: counts.in_review, blocked: counts.blocked, agents_working: 0, agent_machines: 0, last_change: now - 2 * DAY });
const payload = (name) => {
  const base = { mode: "hourly", state: "active", generated_at: Date.now(), updated_at: now - 60000, reports_since: now - 30 * DAY, screens: { total: 0, newest_at: null, groups: [] },
    facts: { computed: computed(NOW_COUNTS), set: [{ label: "Next release", value: "Friday", by: { handle: "maren", agent: "cc-1" }, at: now - 60000 }] } };
  if (name === "Stale") return { ...base, story: story(now - 21 * DAY, THEN) };
  if (name === "Quiet") return { ...base, story: story(now - 21 * DAY, NOW_COUNTS) };
  if (name === "Fresh") return { ...base, story: story(now - 10 * 60000, THEN) };
  if (name === "Flaky") return { ...base, story: story(now - 10 * 60000, NOW_COUNTS) };
  if (name === "First") return { ...base, story: null, reports_since: now - 30 * 60000 };
  return { ...base, story: null, reports_since: now - 5 * HOUR };
};
let calls = 0;
window.flakyFail = false;
api.statusPage = async (channel) => { calls++; if (channel === "Flaky" && window.flakyFail) throw new ApiError("unreachable", "The daemon is not answering", 503); return payload(channel); };
api.project = async (channel) => ({ project: projects.find((p) => p.channel === channel), cards: [] });
api.room = async () => ({ files: [] });
projectsStore.set({ status: "ready", error: null, projects, stubs: [], cards: Object.fromEntries(names.map((n) => [n, []])), cardsError: {}, rooms: Object.fromEntries(names.map((n) => [n, []])), roomsError: {} });
window.poke = (channel) => projectsStore.delta({ channel, project: projects.find((p) => p.channel === channel), page: true });
window.calls = () => calls;
function App() { const route = useRoute(); return React.createElement(StaticStore, { state: { ...initialState, phase: "ready", agents: [], me: { handle: "maren", role: "owner" } } }, React.createElement(ProjectBoard, { channel: route.channel ?? "Stale", page: true })); }
createRoot(document.getElementById("root")).render(React.createElement(App));
`;
    // The build runs in a process of its own (browser-bundle.ts): a second Bun.build in one `bun test` process fails.
    await bundleFixture(fixture, dir, root);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
      if (path === "/fixture.js" || path === "/fixture.css") return new Response(Bun.file(join(dir, "built", path.slice(1))));
      return new Response("Not found", { status: 404 });
    } });
    const runner = `
import { chromium } from ${JSON.stringify(tools.playwright)};
const browser = await chromium.launch({ headless: true });
const checks = [];
const check = (name, ok, detail = null) => checks.push({ name, ok, detail });
try {
 for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: true });
  const page = await context.newPage();
  const prefix = width + "-" + theme + ": ";
  const errors = [];
  page.on("pageerror", e => { errors.push(String(e)); console.error(String(e)); });
  page.setDefaultTimeout(5000);
  await context.route("**/*", route => new URL(route.request().url()).origin === ${JSON.stringify(server.url.origin)} ? route.continue() : route.abort());
  try {
   await page.goto(${JSON.stringify(server.url.origin)} + "/#/projects/Stale/page");
   await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
   const open = async name => { await page.evaluate(n => location.hash = "#/projects/" + n + "/page", name); await page.locator(".spage-headline").waitFor(); await page.waitForFunction(n => document.querySelector(".spage-eyebrow")?.textContent?.includes(n), name); };
   const text = sel => page.locator(sel).first().innerText();
   const overflow = async name => check(prefix + name + " fits viewport", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth));
   const notice = () => page.locator(".spage-notice[role=note]").allInnerTexts().then(t => t.join(" | "));

   // A story three weeks old, written when nothing was blocked, beside a board with four blocked.
   await open("Stale");
   const when = await text(".spage-when");
   check(prefix + "story time is shown beside the headline", /Summary written by WalkieTalkie 3 weeks ago/.test(when), when);
   check(prefix + "page time is in whole words", /Page updated 1 minute ago/.test(when), when);
   check(prefix + "no abbreviated times", !/\\b\\d+(m|h|d|w) ago\\b/.test(await page.locator(".spage").innerText()));
   check(prefix + "eyebrow carries no time", !/ago|updated/i.test(await text(".spage-eyebrow")), await text(".spage-eyebrow"));
   const style = await page.locator(".spage-when").evaluate(el => { const s = getComputedStyle(el); return { size: parseFloat(s.fontSize), upper: s.textTransform }; });
   check(prefix + "time cue is at least 14px and not capitals", style.size >= 14 && style.upper === "none", style);
   const stale = await notice();
   check(prefix + "numbers that moved since the summary say so", /written 3 weeks ago\\. The numbers on this page \\(blocked, in progress, in review\\) have changed since then, so parts of the summary may be out of date\\. The facts and numbers here are current\\./.test(stale), stale);
   check(prefix + "the notice promises no new summary", !/new summary|writes a new/i.test(stale), stale);
   await overflow("stale story");

   // The same age beside the numbers it was written against: dated, not flagged.
   await open("Quiet");
   check(prefix + "an old story beside the same numbers is dated", /3 weeks ago/.test(await text(".spage-when")));
   check(prefix + "an old story beside the same numbers is not flagged", await page.locator(".spage-notice[role=note]").count() === 0);

   // Numbers that moved, but the story is ten minutes old: the next report is still due.
   await open("Fresh");
   check(prefix + "a story still within its grace is not flagged", await page.locator(".spage-notice[role=note]").count() === 0);
   check(prefix + "its time reads in minutes", /written by WalkieTalkie 10 minutes ago/.test(await text(".spage-when")), await text(".spage-when"));

   // No story, reports on for five hours.
   await open("Late");
   const lede = await text(".spage-lede");
   check(prefix + "an overdue first story says none has arrived and what to do, in plain words", /No summary has arrived yet/.test(lede) && /main machine \\(the one that keeps the member list\\)/.test(lede) && !/roster authority|first ones appear within the hour/.test(lede), lede);
   await overflow("overdue story");

   // No story, reports switched on half an hour ago: the first normal hour does not warn.
   await open("First");
   check(prefix + "the first normal hour does not warn", !/No summary has arrived yet/.test(await text(".spage-lede")) && /first ones appear within the hour/.test(await text(".spage-lede")), await text(".spage-lede"));

   // A refresh that fails after a good load keeps what it had and says so; the next good look clears it.
   await open("Flaky");
   check(prefix + "no refresh notice while all is well", await page.locator(".spage-notice[role=status]").count() === 0);
   const before = await page.evaluate(() => window.calls());
   await page.evaluate(() => { window.flakyFail = true; window.poke("Flaky"); });
   await page.waitForFunction(b => window.calls() > b, before);
   const failedNotice = page.locator(".spage-notice[role=status]");
   await failedNotice.waitFor();
   check(prefix + "a failed refresh keeps the headline", await page.locator(".spage-headline").innerText() === "Billing is on track for the Friday launch");
   const said = await failedNotice.innerText();
   check(prefix + "a failed refresh says so, in words, with the time of what is shown", /couldn't refresh this page just now, so it shows what it said (just now|\\d+ minutes? ago)/.test(said), said);
   await overflow("failed refresh");
   await page.evaluate(() => { window.flakyFail = false; });
   await failedNotice.getByRole("button", { name: "Try again" }).click();
   await page.waitForFunction(() => document.querySelectorAll(".spage-notice[role=status]").length === 0);
   check(prefix + "a good look clears the notice", await page.locator(".spage-notice[role=status]").count() === 0);
   check(prefix + "no page exceptions", errors.length === 0, errors);
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
console.log(JSON.stringify({ chromium: browser.version(), passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks: checks.filter(c => !c.ok) }, null, 2));
process.exitCode = checks.some(c => !c.ok) ? 1 : 0;
`;
    await Bun.write(join(dir, "runner.mjs"), runner);
    child = Bun.spawn([tools.node, join(dir, "runner.mjs")], {
      env: { ...process.env, HOME: dir, WALKIE_HOME: join(dir, "walkie"), CODEX_HOME: join(dir, "codex"), TMPDIR: dir, PLAYWRIGHT_BROWSERS_PATH: tools.browsers },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    console.log(stdout);
    if (stderr) console.error(stderr);
    expect(exit).toBe(0);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
