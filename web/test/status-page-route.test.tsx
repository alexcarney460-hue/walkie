// Real DOM commits matter here: a settled screenshot misses state reused before passive effects.
// Run with the supplied offline browser, or set WALKIE_PLAYWRIGHT_MODULE / PLAYWRIGHT_BROWSERS_PATH.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserTooling, bundleFixture } from "./browser-bundle.ts";

const root = resolve(import.meta.dir, "../..");
const source = (path: string) => JSON.stringify(join(root, path));

// Skipped where the supplied browser (or the one WALKIE_PLAYWRIGHT_MODULE / PLAYWRIGHT_BROWSERS_PATH name) is not installed.
const tooling = browserTooling();

test.skipIf(!tooling)("project route commits and visible attribution in Chromium at phone/desktop widths and both themes", async () => {
  const tools = tooling!;
  const dir = mkdtempSync("/tmp/walkie-page-route-");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const css = (await Bun.file(join(root, "web/src/main.tsx")).text()).matchAll(/import "(\.\/styles\/[^" ]+)"/g);
    const fixture = `
import React, { Profiler } from ${source("web/node_modules/react/index.js")};
import { createRoot } from ${source("web/node_modules/react-dom/client.js")};
import { ProjectBoard } from ${source("web/src/views/projects/ProjectBoard.tsx")};
import { api, ApiError } from ${source("web/src/api/client.ts")};
import { projectsStore } from ${source("web/src/state/projects.ts")};
import { StaticStore } from ${source("web/src/state/store.tsx")};
import { initialState } from ${source("web/src/state/reducer.ts")};
import { useRoute } from ${source("web/src/lib/route.ts")};
${[...css].map((m) => `import ${source("web/src/" + m[1]!.slice(2))};`).join("\n")}
const names = ["Alpha", "Loading", "Error", "Empty", "Off", "Archived"];
const projects = names.map((name) => ({ channel: name, id: name, name, prefix: name.toUpperCase(), folder: "Synthetic", description: "", paths: [], meter_mode: "count", automations: {}, state: name === "Archived" ? "archived" : "active", status_report: name === "Off" ? "off" : "hourly", admins: [], creator: "maren", created_at: 0, boards: [{ id: "main", name: "Main", state: "active", columns: [{ id: "todo", name: "To do", role: "todo" }], meter: { mode: "count", done: 0, counted: 0, by_role: {} } }], cards: 0, meter: { mode: "count", done: 0, counted: 0, by_role: {} } }));
const empty = { mode: "hourly", state: "active", generated_at: 0, updated_at: null, story: null, facts: { computed: null, set: [] }, screens: { total: 0, newest_at: null, groups: [] } };
const payload = (name) => ({ ...empty, state: name === "Archived" ? "archived" : "active", mode: name === "Off" ? "off" : "hourly", ...(name === "Alpha" || name === "Loading" ? { story: { headline: name + " synthetic report", lede: "Synthetic story", live_now: [], landing_next: [] }, facts: { computed: null, set: [{ label: "Build", value: "Fixture", by: { handle: "maren", agent: "cc-9" }, at: 0 }] } } : {}) });
window.commits = [];
window.requests = [];
let fail = true;
api.statusPage = async (channel) => {
  window.requests.push(channel);
  if (channel === "Loading") return new Promise(resolve => { window.release = () => resolve(payload(channel)); });
  if (channel === "Error" && fail) throw new ApiError("synthetic", "Synthetic page failure", 503);
  return payload(channel);
};
window.recover = () => { fail = false; };
api.project = async (channel) => ({ project: projects.find(p => p.channel === channel), cards: [] });
api.room = async () => ({ files: [] });
projectsStore.set({ status: "ready", error: null, projects, stubs: [], cards: Object.fromEntries(names.map(n => [n, []])), cardsError: {}, rooms: Object.fromEntries(names.map(n => [n, []])), roomsError: {} });
function App() {
 const route = useRoute();
 return React.createElement(StaticStore, { state: { ...initialState, phase: "ready", agents: [], me: { handle: "maren", role: "owner" } } }, React.createElement(Profiler, { id: "route", onRender: () => {
 window.commits.push({ channel: route.channel, headline: document.querySelector('.spage-headline')?.textContent ?? null, eyebrow: document.querySelector('.spage-eyebrow')?.textContent ?? null });
 } }, React.createElement(ProjectBoard, { channel: route.channel ?? "Alpha", page: true, group: route.group })));
}
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
  page.on("console", m => { if (m.type() === "error") console.error(m.text()); });
  page.setDefaultTimeout(5000);
  await context.route("**/*", route => new URL(route.request().url()).origin === ${JSON.stringify(server.url.origin)} ? route.continue() : route.abort());
  try {
   await page.goto(${JSON.stringify(server.url.origin)} + "/#/projects/Alpha/page");
   await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
   const headline = page.locator(".spage-headline");
   await headline.filter({ hasText: "Alpha synthetic report" }).waitFor().catch(async e => { console.error(await page.content()); throw e; });
   const byline = page.locator(".spage-fact").getByText("(set by @maren/cc-9)", { exact: true });
   const visible = () => byline.evaluate(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 5 && r.height > 5 && s.clip === "auto" && s.visibility === "visible"; });
   check(prefix + "byline visible without hover", await visible());
   await page.keyboard.press("Tab");
   check(prefix + "byline readable during keyboard use", await visible());
   // Tap the fact itself; attribution must require neither a title tooltip nor pointer hover.
   await page.locator(".spage-fact").tap();
   check(prefix + "byline readable on touch", await visible());
   const go = async name => { await page.evaluate(n => location.hash = '#/projects/' + n + '/page', name); await page.waitForFunction(n => window.requests.includes(n), name); };
   const overflow = async name => check(prefix + name + " fits viewport", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth));
   await overflow("ready");
   await go("Loading");
   await page.locator('.spage[aria-busy="true"]').waitFor();
   check(prefix + "pending has no previous report", await headline.count() === 0);
   await overflow("loading");
   await go("Error");
   await page.getByText("Synthetic page failure", { exact: true }).waitFor();
   await page.evaluate(() => window.release());
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   check(prefix + "late departed response ignored", await headline.count() === 0 && await page.getByText("Synthetic page failure", { exact: true }).count() === 1);
   await overflow("error");
   await page.evaluate(() => window.recover());
   await page.getByRole("button", { name: "Retry" }).click();
   await headline.filter({ hasText: "Error" }).waitFor();
   check(prefix + "retry recovers to empty", await headline.textContent() === "Error");
   for (const name of ["Empty", "Off", "Archived"]) {
    await go("Alpha");
    await headline.filter({ hasText: "Alpha synthetic report" }).waitFor();
    await go(name);
    if (name === "Off") await page.getByText("The status page is off for this project", { exact: true }).waitFor();
    else await headline.filter({ hasText: name }).waitFor();
    check(prefix + name + " excludes Alpha", !await page.locator(".spage").innerText().then(t => t.includes("Alpha synthetic report")));
    if (name === "Archived") check(prefix + "archive notice", await page.getByRole("note").innerText().then(t => t.includes("archived")));
    await overflow(name);
   }
   const stale = await page.evaluate(() => window.commits.filter(c => c.channel !== "Alpha" && c.headline === "Alpha synthetic report"));
   check(prefix + "no cross-project commit", stale.length === 0, stale);
   check(prefix + "no page exceptions", errors.length === 0, errors);
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
console.log(JSON.stringify({ chromium: browser.version(), passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks }, null, 2));
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
}, 60_000);
