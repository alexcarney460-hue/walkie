// Drives headless Chromium over the DevTools protocol against the dashboard that scripts/project-pages-demo.ts serves: signs in
// with the demo's one-time link, opens the status page (and its neighbours) at desktop and phone width in the dark and the
// light theme, waits until every screenshot on the page has loaded, and saves PNGs plus audit.json (what the page really
// measured: horizontal overflow, how many images loaded, how many chips and links). No Playwright: a few lines of CDP.
//
//   bun scripts/project-pages-shots.ts <demo dir> <out dir> [chrome binary]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [demoArg, outArg, chromeArg] = process.argv.slice(2);
if (!demoArg || !outArg) throw new Error("usage: bun scripts/project-pages-shots.ts <demo dir> <out dir> [chrome binary]");
const demoDir: string = demoArg;
const outDir: string = outArg;
const ready = JSON.parse(readFileSync(join(demoDir, "ready.json"), "utf8")) as { url: string; port: number; dash: string; billing: string; archive: string; extremes?: string | null; poke?: number };
const chrome = chromeArg ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell`;
if (!existsSync(chrome)) throw new Error(`no browser at ${chrome}`);
mkdirSync(outDir, { recursive: true });
const base = `http://127.0.0.1:${ready.port}`;

// ---- a small DevTools client ----------------------------------------------------------------------------------------------
type Msg = { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
class Cdp {
  private n = 0;
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.fail(new Error(m.error.message)); else p.ok(m.result);
    };
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error("DevTools socket failed")); });
    return new Cdp(ws);
  }
  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.n;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const profile = mkdtempSync("/tmp/walkie-shots-");
const proc = spawn(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise<string>((ok, fail) => {
  let buf = "";
  proc.stderr.on("data", (d: Buffer) => { buf += d.toString(); const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) ok(m[1] as string); });
  proc.on("exit", () => fail(new Error(`the browser exited: ${buf.slice(-300)}`)));
  setTimeout(() => fail(new Error("the browser did not start")), 20_000);
});
const cdp = await Cdp.connect(wsUrl);
const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
const page = <T = Record<string, unknown>>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
await page("Page.enable");
await page("Runtime.enable");

async function evaluate<T>(expression: string): Promise<T> {
  const r = await page<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text}`);
  return r.result.value;
}
async function until(expression: string, what: string, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evaluate<boolean>(expression).catch(() => false)) return; await Bun.sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}
/**
 * The width the browser was asked for. A phone-shaped browser grows its layout width to fit content that is too wide, so
 * `innerWidth` alone can never show an overflow: every audit compares with this.
 */
let want = 1280;
/** The elements of the page whose right edge is past the width asked for (the first few, by tag, class and size). */
const offenders = () => `[...document.querySelectorAll('.spage *')].filter((el) => el.getBoundingClientRect().right > ${want} + 0.5).slice(0, 8).map((el) => { const r = el.getBoundingClientRect(); return el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '') + ' right=' + Math.round(r.right) + ' width=' + Math.round(r.width); })`;
const sideways = () => `document.documentElement.scrollWidth > ${want} || innerWidth > ${want}`;
async function open(width: number, height: number, scheme: "dark" | "light", hash: string): Promise<void> {
  want = width;
  await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await page("Page.navigate", { url: "about:blank" });
  await page("Page.navigate", { url: `${base}/${hash}` });
  await until("document.readyState === 'complete' && !!document.querySelector('#root > *')", "the app");
}
const audit: Record<string, unknown>[] = [];
async function save(name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  const { data } = await page<{ data: string }>("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
  // Every picture is checked for sideways overflow and for the active tab being in view (the tabs scroll on a phone).
  audit.push(await evaluate<Record<string, unknown>>(`(() => { const t = document.querySelector('.pboard-tabs'), on = t && t.querySelector('.tab-link.is-on'); const r = t && t.getBoundingClientRect(), o = on && on.getBoundingClientRect();
    return { shot: ${JSON.stringify(name)}, wantedWidth: ${want}, innerWidth, scrollWidth: document.documentElement.scrollWidth, overflowsSideways: ${sideways()}, offenders: ${offenders()},
      activeTab: on ? on.textContent.trim() : null, activeTabInView: on ? o.left >= r.left - 1 && o.right <= r.right + 1 : null }; })()`));
  process.stdout.write(`saved ${name}\n`);
}
/** Opens the project's page, grows the window to the whole page so every screenshot comes into reach, waits for them, and saves it. */
async function fullPage(name: string, width: number, scheme: "dark" | "light", hash: string, wait = true): Promise<void> {
  await open(width, 900, scheme, hash);
  await until("!!document.querySelector('.spage')", "the page");
  await page("Emulation.setDeviceMetricsOverride", { width, height: Math.max(900, await evaluate<number>("document.documentElement.scrollHeight")), deviceScaleFactor: 1, mobile: width < 600 });
  if (wait) await until("document.querySelectorAll('.spage-ph .skeleton').length === 0", "the screenshots to load", 40_000);
  await Bun.sleep(400);
  const h = await evaluate<number>("Math.ceil(document.documentElement.scrollHeight)");
  await page("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: width < 600 });
  await Bun.sleep(300);
  audit.push(await evaluate<Record<string, unknown>>(`(() => ({
    name: ${JSON.stringify(name)}, wantedWidth: ${want}, innerWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflowsSideways: ${sideways()}, offenders: ${offenders()},
    figures: document.querySelectorAll('.spage-shot').length, imagesLoaded: [...document.querySelectorAll('.spage-zoom img')].filter((i) => i.complete && i.naturalWidth > 0).length,
    placeholdersLeft: document.querySelectorAll('.spage-ph').length, chips: [...document.querySelectorAll('.spage-chip')].map((c) => c.textContent),
    indexLinks: [...document.querySelectorAll('.spage-index a')].map((a) => a.textContent), factTiles: document.querySelectorAll('.spage-fact').length,
    headings: [...document.querySelectorAll('.spage h2, .spage h3, .spage h4')].map((h) => h.tagName + ' ' + h.textContent.slice(0, 40)),
    theme: getComputedStyle(document.body).backgroundColor, pageHeight: document.documentElement.scrollHeight,
  }))()`));
  await save(name);
}

// ---- sign in, then the scenes ----------------------------------------------------------------------------------------------
await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await page("Page.navigate", { url: ready.url });
await until("document.readyState === 'complete'", "the login");
await Bun.sleep(800);
const dash = `#/projects/${ready.dash}/page`;

await fullPage("01-desktop-dark-full.png", 1280, "dark", dash);
await fullPage("02-desktop-light-full.png", 1280, "light", dash);
await fullPage("03-phone-390-dark-full.png", 390, "dark", dash);
await fullPage("04-phone-390-light-full.png", 390, "light", dash);

// The top of the page on a phone, as a person first sees it.
await open(390, 844, "dark", dash);
await until("!!document.querySelector('.spage-headline')", "the page");
await Bun.sleep(500);
await save("05-phone-390-dark-top.png");

// Scrolled into the screens on a phone: the index sticks below the phone's own 48px top bar and is not hidden by it.
await open(390, 844, "dark", dash);
await until("document.querySelectorAll('.spage-index a').length > 1", "the index");
await evaluate("document.querySelectorAll('.spage-index a')[1].click()"); // the index's own link: the page measures the index and scrolls the group just below it
await until("document.querySelectorAll('.spage-zoom img').length > 0", "a screenshot");
for (let last = -1, i = 0; i < 40; i++) { const y = await evaluate<number>("Math.round(scrollY)"); if (y === last) break; last = y; await Bun.sleep(150); } // let the smooth scroll settle
await Bun.sleep(300);
audit.push(await evaluate<Record<string, unknown>>(`(() => { const bar = document.querySelector('.mobilebar').getBoundingClientRect(), idx = document.querySelector('.spage-index').getBoundingClientRect(), g = document.querySelector('#spage-g-mission-control h3').getBoundingClientRect();
  return { name: 'phone scrolled to Mission Control', mobileBarBottom: bar.bottom, indexTop: idx.top, indexBottom: idx.bottom, groupHeadingTop: g.top, indexBelowTheBar: idx.top >= bar.bottom - 1, groupHeadingBelowTheIndex: g.top >= idx.bottom - 1, groupHeadingInView: g.bottom < innerHeight }; })()`));
await save("05b-phone-390-dark-scrolled.png");

// One screen enlarged, from the keyboard-reachable thumbnail.
await open(1280, 800, "dark", dash);
await until("document.querySelectorAll('.spage-zoom img').length > 0", "a screenshot");
await evaluate("document.querySelector('.spage-group:nth-of-type(2) .spage-zoom, .spage-zoom').scrollIntoView({block: 'center'})");
await Bun.sleep(500);
await evaluate("document.querySelector('.spage-zoom').click()");
await until("!!document.querySelector('dialog.spage-dialog[open] img')", "the enlarged screen");
await Bun.sleep(500);
await save("06-desktop-dark-enlarged.png");
audit.push(await evaluate<Record<string, unknown>>(`(() => { const d = document.querySelector('dialog.spage-dialog'); return { name: 'enlarged', open: d.open, labelledby: d.getAttribute('aria-labelledby'), title: document.getElementById(d.getAttribute('aria-labelledby')).textContent, alt: d.querySelector('img').alt, activeIsInsideDialog: d.contains(document.activeElement) }; })()`));
await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await Bun.sleep(300);
audit.push(await evaluate<Record<string, unknown>>(`({ name: 'after Escape', dialogOpen: document.querySelector('dialog.spage-dialog').open, focusReturnedToAThumbnail: document.activeElement.classList.contains('spage-zoom') })`));

// Keyboard: Tab to the index and show where focus is.
await open(1280, 800, "dark", dash);
await until("document.querySelectorAll('.spage-index a').length > 0", "the index");
await evaluate("document.querySelector('.spage-index').scrollIntoView({block: 'start'})");
for (let i = 0; i < 2; i++) {
  await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
}
await evaluate("document.querySelector('.spage-index a').focus()");
await Bun.sleep(300);
await save("07-desktop-dark-keyboard-focus.png");

// A project whose report is on but nothing has been written or added yet, and one whose report is off.
await fullPage("08-desktop-dark-new-project.png", 1280, "dark", `#/projects/${ready.billing}/page`, false);
await fullPage("09-phone-390-dark-new-project.png", 390, "dark", `#/projects/${ready.billing}/page`, false);
await open(1280, 700, "dark", `#/projects/${ready.archive}/page`);
await until("!!document.querySelector('.spage .empty')", "the off notice");
await Bun.sleep(300);
await save("10-desktop-dark-page-off.png");

// The Projects list, with its link, and the project's tabs.
await open(1280, 700, "dark", "#/projects");
await until("document.querySelectorAll('.project-page-link').length > 0", "the list");
await Bun.sleep(400);
audit.push(await evaluate<Record<string, unknown>>(`({ name: 'projects list', statusPageLinks: [...document.querySelectorAll('.project-page-link')].map((a) => a.closest('.project-item').querySelector('.project-name').textContent), rowsWithoutLink: [...document.querySelectorAll('.project-item')].filter((i) => !i.querySelector('.project-page-link')).map((i) => i.querySelector('.project-name').textContent) })`));
await save("11-desktop-dark-projects-list.png");

// A page left open changes by itself: a fact and a screen written from another machine's terminal show up with no reload and no wait for
// the page's own two-minute look (the stream says the page changed).
if (ready.poke) {
  await open(1280, 900, "dark", dash);
  await until("document.querySelectorAll('.spage-fact').length > 0 && document.querySelectorAll('.spage-shot').length > 0", "the page");
  const stamp = `v${Date.now() % 100000}`;
  const before = await evaluate<{ facts: number; shots: number }>("({ facts: document.querySelectorAll('.spage-fact').length, shots: document.querySelectorAll('.spage-shot').length })");
  await evaluate(`window.__pageMarker = ${JSON.stringify(stamp)}`); // a reload of the page would lose it
  const t0 = Date.now();
  const wrote = await fetch(`http://127.0.0.1:${ready.poke}/fact?label=${encodeURIComponent("Live check")}&value=${stamp}`);
  await until(`document.body.innerText.includes(${JSON.stringify(stamp)})`, "the new fact to appear by itself", 20_000);
  const factAfter = Date.now() - t0;
  const t1 = Date.now();
  const wroteScreen = await fetch(`http://127.0.0.1:${ready.poke}/screen?title=${encodeURIComponent(`Live screen ${stamp}`)}`);
  await until(`document.querySelectorAll('.spage-shot').length === ${before.shots + 1}`, "the new screen to appear by itself", 20_000);
  await until(`[...document.querySelectorAll('.spage-shot')].some((f) => f.textContent.includes(${JSON.stringify(`Live screen ${stamp}`)}))`, "the new screen's caption", 20_000);
  audit.push({ name: "an open page changes by itself", factWritten: wrote.status, screenWritten: wroteScreen.status, factsBefore: before.facts, factsAfter: await evaluate<number>("document.querySelectorAll('.spage-fact').length"), factShownAfterMs: factAfter, shotsBefore: before.shots, shotsAfter: await evaluate<number>("document.querySelectorAll('.spage-shot').length"), screenShownAfterMs: Date.now() - t1, pageNeverReloaded: (await evaluate<string>("window.__pageMarker")) === stamp });
  await save("16-desktop-dark-live-update.png");
}

// The longest text every field takes, in words that cannot wrap (PAGES_DEMO_EXTREMES=1): nothing may widen the page, on a phone or
// on a desktop, and the sticky index of twelve groups must leave room to read on a phone held sideways.
if (ready.extremes) {
  const extremes = `#/projects/${ready.extremes}/page`;
  await fullPage("12-phone-390-dark-extremes.png", 390, "dark", extremes);
  await fullPage("13-desktop-dark-extremes.png", 1280, "dark", extremes);
  await open(844, 390, "dark", extremes);
  await until("document.querySelectorAll('.spage-index a').length > 1", "the index");
  await Bun.sleep(400);
  audit.push(await evaluate<Record<string, unknown>>(`(() => { const i = document.querySelector('.spage-index').getBoundingClientRect(); return { name: 'phone held sideways, twelve groups', viewportHeight: innerHeight, indexTop: i.top, indexHeight: Math.round(i.height), indexShareOfViewport: Math.round(i.height / innerHeight * 100) / 100, overflowsSideways: ${sideways()}, offenders: ${offenders()} }; })()`));
  await save("14-phone-844x390-dark-extremes.png");
  // One screen enlarged on a phone, with the longest title and sentence: the dialog fits the window, its close button is in reach, nothing is wider than it.
  await open(390, 844, "dark", extremes);
  await until("!!document.querySelector('.spage-group')", "the screens");
  await evaluate("document.querySelector('.spage-group').scrollIntoView({block: 'start'})"); // the pictures load as they come near the window
  await until("document.querySelectorAll('.spage-zoom img').length > 0", "a screenshot");
  await evaluate("document.querySelector('.spage-zoom').scrollIntoView({block: 'center'})");
  await Bun.sleep(400);
  await evaluate("document.querySelector('.spage-zoom').click()");
  await until("!!document.querySelector('dialog.spage-dialog[open] img')", "the enlarged screen");
  await Bun.sleep(400);
  await save("15-phone-390-dark-extremes-enlarged.png");
  audit.push(await evaluate<Record<string, unknown>>(`(() => { const d = document.querySelector('dialog.spage-dialog'), r = d.getBoundingClientRect(), c = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close').getBoundingClientRect(), body = d.querySelector('.spage-dialog-body');
    return { name: 'phone enlarged, longest text', dialog: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }, viewport: { width: innerWidth, height: innerHeight },
      dialogInsideWindow: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, closeButtonInWindow: c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight,
      bodyWiderThanDialog: body.scrollWidth > body.clientWidth, bodyScrolls: body.scrollHeight > body.clientHeight }; })()`));
  // What a group named with forty letters and no space does inside its pill: wraps (several line boxes) or is cut off (one line wider than the pill).
  audit.push(await evaluate<Record<string, unknown>>(`(() => { const a = document.querySelector('.spage-index a'), r = document.createRange(); r.selectNodeContents(a.firstChild); const lines = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    const box = a.getBoundingClientRect(); return { name: 'first index pill, a long group name', pillWidth: Math.round(box.width), pillHeight: Math.round(box.height), textLines: lines, textWiderThanPill: a.scrollWidth > a.clientWidth, display: getComputedStyle(a).display, overflowWrap: getComputedStyle(a).overflowWrap }; })()`));
}

writeFileSync(join(outDir, "audit.json"), JSON.stringify(audit, null, 2));
await page("Browser.close").catch(() => undefined);
proc.kill();
rmSync(profile, { recursive: true, force: true });
process.stdout.write("done\n");
process.exit(0);
