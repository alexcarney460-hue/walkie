// WALK-75: Simple mode in a real browser. 390 and 1440, light and dark. The fixture is bundled in a
// subprocess (browser-bundle.ts) because a second Bun.build in one bun test process fails.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserTooling, bundleFixture } from "./browser-bundle.ts";

const root = resolve(import.meta.dir, "../..");
const source = (path: string) => JSON.stringify(join(root, path));
const tooling = browserTooling();

test.skipIf(!tooling)("simple mode is readable at phone and desktop widths in both themes", async () => {
  const tools = tooling!;
  const dir = mkdtempSync("/tmp/walkie-simple-route-");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const fixture = `
import React from ${source("web/node_modules/react/index.js")};
import { createRoot } from ${source("web/node_modules/react-dom/client.js")};
import { SimpleBoard } from ${source("web/src/views/simple/SimpleBoard.tsx")};
import { Sidebar, MobileBar } from ${source("web/src/components/Shell.tsx")};
import { api } from ${source("web/src/api/client.ts")};
import { StaticStore } from ${source("web/src/state/store.tsx")};
import { initialState } from ${source("web/src/state/reducer.ts")};
import ${source("web/src/styles/tokens.css")};
import ${source("web/src/styles/base.css")};
import ${source("web/src/styles/shell.css")};
import ${source("web/src/styles/simple.css")};
const author = { handle: "alex", node: "aaaaaaaaaaaaaaaa" };
const columns = [
  { id: "backlog", name: "Backlog", role: "backlog" },
  { id: "todo", name: "To do", role: "todo" },
  { id: "doing", name: "In progress", role: "active" },
  { id: "review", name: "In review", role: "review" },
  { id: "done", name: "Done", role: "done" },
  { id: "cancelled", name: "Cancelled", role: "cancelled" },
];
const meter = { mode: "count", done: 0, counted: 0, by_role: { backlog: 0, todo: 0, active: 0, review: 0, done: 0, cancelled: 0 } };
const project = { channel: "p-0000000a", id: "aaaaaaaaaaaaaaaa:1", name: "Website", folder: "", description: "", prefix: "WEB", paths: [], meter_mode: "count", automations: { pr_opened: false, pr_merged: false, agents_can_close: true }, state: "active", steward: "on", steward_node: "", status_report: "off", private: false, admins: [], creator: "alex", created_at: 0, boards: [{ id: "board-main", name: "Main", columns, state: "active", created_at: 0, created_by: author, meter, live_cards: 1 }], meter, cards: 1, last_activity: 0 };
const card = { id: "c-welcome", channel: "p-0000000a", board: "board-main", key: "WEB-1", n: 1, short: "abcd1234", ref: "WEB-1-abcd1234", title: "Write the welcome note", body: "", column: "todo", pos: "a", assignee: "@alex", reviewer: "@bea", labels: ["launch"], estimate: 13, due: "2026-10-10", blocked: false, blocked_reason: null, state: "open", created_at: 1, created_by: author, updated_at: 1, updated_by: author, comments: 0, rev: 1 };
const agent = { id: "alex/host/cc-9", handle: "alex", node: "aaaaaaaaaaaaaaaa", hostname: "host", agent: "cc-9", status: { agent: "cc-9", state: "working", runtime: "other", task: "WEB-1" }, updated_at: 1, machine_online: true, effective_state: "working", archived: false };
const me = { version: "0", protocol: 1, handle: "alex", role: "owner", team: { id: "0123456789abcdef", name: "Northwind" }, node: { id: "aaaaaaaaaaaaaaaa", hostname: "host", ip: "127.0.0.1", port: 1 }, tailscale: { ok: false, login: null }, plan: null };
const team = { id: "0123456789abcdef", name: "Northwind", members: [{ login: "alex@example.com", handle: "alex", role: "owner", display_name: "Alex" }], nodes: [], channels: [], authority: null, plan: null };
window.moves = [];
api.projects = async () => ({ projects: [project], stubs: [] });
api.tasks = async () => ({ tasks: [card], total: 1, truncated: false, projects: [] });
api.asks = async () => ({ asks: [] });
api.task = async () => ({ card, project, timeline: [{ id: "t1", ts: 1, author, kind: "create" }], agents: [] });
api.updateTask = async (ref, body) => { window.moves.push({ ref, body }); return { task: { ...card, ...body } }; };
api.commentTask = async () => ({ event: null, task: card });
api.taskDone = async () => ({ task: { ...card, column: "done" } });
api.answer = async () => ({ event: null });
const state = { ...initialState, phase: "ready", me, team, agents: [agent] };
function App() {
  return React.createElement("div", { className: "app" },
    React.createElement(StaticStore, { state },
      React.createElement(Sidebar, { onSearch: () => {} }),
      React.createElement(MobileBar, { onSearch: () => {} }),
      React.createElement(SimpleBoard)));
}
createRoot(document.getElementById("root")).render(React.createElement(App));
`;
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
const oklchToRgb = (L, C, H) => {
  const a = C * Math.cos(H * Math.PI / 180);
  const b = C * Math.sin(H * Math.PI / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const enc = (x) => { const c = Math.min(1, Math.max(0, x)); return (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255; };
  return [enc(lin[0]), enc(lin[1]), enc(lin[2]), 1];
};
const parse = (c) => {
  if (!c) return null;
  const rgb = c.match(/rgba?\\((\\d+\\.?\\d*)[,\\s]+(\\d+\\.?\\d*)[,\\s]+(\\d+\\.?\\d*)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] !== undefined ? +rgb[4] : 1];
  const srgb = c.match(/color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/);
  if (srgb) return [+srgb[1] * 255, +srgb[2] * 255, +srgb[3] * 255, 1];
  const oklch = c.match(/oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/);
  if (oklch) return oklchToRgb(+oklch[1], +oklch[2], +oklch[3]);
  return null;
};
const lum = (r, g, b) => {
  const f = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrastOf = (fg, bg) => {
  const a = lum(fg[0], fg[1], fg[2]), b = lum(bg[0], bg[1], bg[2]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.setDefaultTimeout(8000);
  await page.route("**/*", (route) => new URL(route.request().url()).origin === ${JSON.stringify(server.url.origin)} ? route.continue() : route.abort());
  await page.goto(${JSON.stringify(server.url.origin)} + "/#/simple");
  await page.locator(".simple").waitFor();
  await page.getByRole("heading", { name: "Simple" }).waitFor();
  const colors = {};
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    const prefix = width + "-" + theme + ": ";
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.style.zoom = ""; }, theme);
    await page.locator(".simple-card").first().waitFor();
    const metrics = await page.evaluate(() => {
      const root = document.querySelector(".simple");
      const title = root.querySelector("h1");
      const button = document.querySelector('[aria-label="Move Write the welcome note to Working on"]');
      const styleOf = (el) => getComputedStyle(el);
      const bgOf = (el) => {
        let n = el;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && c !== "transparent" && !c.endsWith(", 0)") && !c.endsWith(" 0)")) return c;
          n = n.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const box = button.getBoundingClientRect();
      const link = document.querySelector(".mobile-simple");
      const linkBox = link.getBoundingClientRect();
      const linkStyle = getComputedStyle(link);
      const rail = [...document.querySelectorAll(".rail-link")].find((a) => a.textContent.includes("Simple"));
      const railBox = rail ? rail.getBoundingClientRect() : null;
      return {
        font: parseFloat(styleOf(root).fontSize),
        buttonFont: parseFloat(styleOf(button).fontSize),
        box: { width: box.width, height: box.height },
        color: styleOf(title).color,
        background: bgOf(title),
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1,
        draggable: document.querySelectorAll("[draggable=true]").length,
        text: root.innerText,
        mobile: { display: linkStyle.display, width: linkBox.width, height: linkBox.height },
        rail: railBox ? { width: railBox.width, height: railBox.height, display: getComputedStyle(rail).display } : null,
      };
    });
    check(prefix + "base font", metrics.font >= 18, metrics.font);
    check(prefix + "control font", metrics.buttonFont >= 18, metrics.buttonFont);
    check(prefix + "move target", metrics.box.width >= 44 && metrics.box.height >= 44, metrics.box);
    const fg = parse(metrics.color), bg = parse(metrics.background);
    const ratio = fg && bg ? contrastOf(fg, bg) : 0;
    check(prefix + "title contrast", ratio >= 4.5, { ratio, color: metrics.color, background: metrics.background });
    check(prefix + "no overflow", metrics.overflow);
    check(prefix + "no drag", metrics.draggable === 0, metrics.draggable);
    check(prefix + "no agent word", !/\\bagents?\\b/i.test(metrics.text), metrics.text.slice(0, 200));
    check(prefix + "says assistant", /\\bassistant\\b/i.test(metrics.text));
    colors[theme] = metrics.color + "|" + metrics.background;
    if (width === 390) check(prefix + "phone link", metrics.mobile.display !== "none" && metrics.mobile.width >= 44 && metrics.mobile.height >= 44, metrics.mobile);
    if (width === 1440) check(prefix + "sidebar link", !!metrics.rail && metrics.rail.display !== "none" && metrics.rail.height >= 44, metrics.rail);
    await page.locator(".simple-card").first().focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    check(prefix + "enter opens", await page.locator("h1").innerText() === "Write the welcome note");
    const detailText = await page.locator(".simple").innerText();
    check(prefix + "who label", detailText.includes("Who: You") && detailText.includes("Reviewer:"));
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Simple" }).waitFor();
    check(prefix + "escape closes", await page.locator("h1").innerText() === "Simple");
  }
  check("themes differ", colors.light !== colors.dark, colors);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const zoomed = await page.evaluate(() => {
    const el = document.querySelector(".simple");
    return !!el && el.scrollWidth <= el.clientWidth + 1;
  });
  check("200% zoom fits", zoomed);
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  const before = await page.evaluate(() => window.moves.length);
  await page.locator('[aria-label="Move Write the welcome note to Working on"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => window.moves.length > n, before);
  const moved = await page.evaluate(() => window.moves.at(-1));
  check("keyboard move", moved && moved.body && moved.body.column === "doing" && Object.keys(moved.body).join() === "column", moved);
  check("no page exceptions", errors.length === 0, errors);
  await page.close();
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
