// Opt-in browser regression: set WALKIE_PLAYWRIGHT_MODULE to an installed playwright-core entry
// and PLAYWRIGHT_BROWSERS_PATH to existing browsers. No downloads or daemon are needed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleFixture } from "./browser-bundle.ts";

const modulePath = process.env.WALKIE_PLAYWRIGHT_MODULE;
const root = resolve(import.meta.dir, "../..");
const source = (path: string) => JSON.stringify(join(root, path));
let browser: any;
let server: ReturnType<typeof Bun.serve> | undefined;
let dir: string | undefined;

beforeAll(async () => {
  if (!modulePath) return;
  const fixture = `
    import { createElement } from ${source("web/node_modules/react/index.js")};
    import { createRoot } from ${source("web/node_modules/react-dom/client.js")};
    import { ScreensSection } from ${source("web/src/views/projects/StatusPageScreens.tsx")};
    import ${source("web/src/styles/tokens.css")};
    import ${source("web/src/styles/base.css")};
    import ${source("web/src/styles/projects.css")};
    import ${source("web/src/styles/status-page.css")};
    const screens = { total: 4, newest_at: null, groups: [{ id: "test", name: "Synthetic screens", screens:
      ["aborted", "missing", "invalid", "offline"].map(id => ({
        id, title: id, group: "Synthetic screens", status: "works", about: "Synthetic recovery fixture.",
        version: 1, size: 500, mime: "image/png", at: 0, by: { handle: "fixture" },
        available: id !== "offline", w: 1280, h: 720
      })) }] };
    const root = createRoot(document.getElementById("root"));
    window.tick = () => root.render(createElement("main", { className: "spage" },
      createElement(ScreensSection, { channel: "synthetic", prefix: "TEST", screens: structuredClone(screens) })));
    window.tick();
  `;
  // The build runs in a process of its own (browser-bundle.ts): a second Bun.build in one `bun test` process fails.
  dir = mkdtempSync("/tmp/walkie-page-retry-");
  const built = await bundleFixture(fixture, dir, root);
  const js = Bun.file(built.js);
  const css = Bun.file(built.css);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/fixture.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/fixture.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
    if (path !== "/") return new Response("not found", { status: 404 });
    return new Response('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
  } });
  const { chromium } = await import(modulePath);
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); if (dir) rmSync(dir, { recursive: true, force: true }); });

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test.skipIf(!modulePath)(`explicit image recovery, dialog and overflow: ${width}x900 ${theme}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      const counts: Record<string, number> = {};
      let restored = false;
      let png: Buffer;
      await context.route("**/*", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.origin !== server!.url.origin) throw new Error(`Non-loopback fixture request: ${url.origin}`);
        const file = /\/room\/([^/]+)\/content/.exec(url.pathname)?.[1];
        if (!file) return route.continue();
        counts[file] = (counts[file] ?? 0) + 1;
        if (restored) return route.fulfill({ contentType: "image/png", body: png });
        if (file === "aborted") return route.abort("aborted");
        if (file === "missing") return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"not_found"}}' });
        return route.fulfill({ contentType: "image/png", body: "not an image" });
      });
      await page.goto(server!.url.href);
      await page.evaluate((theme: string) => { document.documentElement.dataset.theme = theme; }, theme);
      png = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
        canvas.getContext("2d")!.fillRect(0, 0, 1280, 720);
        return canvas.toDataURL("image/png").split(",")[1];
      }), "base64");
      const figure = (id: string) => page.locator("figure").filter({ has: page.locator("figcaption b", { hasText: new RegExp(`^${id}$`) }) });
      for (const id of ["aborted", "missing", "invalid", "offline"]) {
        await figure(id).scrollIntoViewIfNeeded();
        await figure(id).locator(".spage-ph[aria-busy=false]").waitFor();
      }
      expect(counts).toEqual({ aborted: 1, missing: 1, invalid: 1 });
      expect(await figure("offline").getByRole("button").count()).toBe(0);
      const overflow = async () => expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth)).toBe(true);
      await overflow();
      // The endpoint returning online and unchanged props must not themselves retry.
      restored = true;
      await page.evaluate(() => (window as any).tick());
      await page.waitForTimeout(250);
      expect(counts).toEqual({ aborted: 1, missing: 1, invalid: 1 });
      for (const id of ["aborted", "missing", "invalid"]) {
        expect(await figure(id).getByRole("button", { name: "Try again" }).count()).toBe(1);
        await figure(id).getByRole("button", { name: "Try again" }).click();
        await figure(id).getByRole("button", { name: `Enlarge ${id}` }).waitFor();
        expect(counts[id]).toBe(2);
        // The thumbnail is a lazy, async-decoded <img>: wait for it to decode rather than reading it the moment its button appears.
        expect(await figure(id).locator("img").evaluate((img: HTMLImageElement) => img.decode().then(() => img.complete && img.naturalWidth === 1280, () => false))).toBe(true);
      }
      await overflow();
      const zoom = figure("aborted").getByRole("button", { name: "Enlarge aborted" });
      await zoom.focus(); await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "aborted" });
      await dialog.waitFor();
      expect(await dialog.getByRole("button", { name: "Close" }).evaluate((el: Element) => el === document.activeElement)).toBe(true);
      for (const key of ["Tab", "Shift+Tab"]) for (let i = 0; i < 4; i++) {
        await page.keyboard.press(key);
        expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("dialog"))).toBe(true);
      }
      await overflow();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await zoom.evaluate((el: Element) => el === document.activeElement)).toBe(true);
      await page.evaluate(() => (window as any).tick());
      await page.waitForTimeout(250);
      expect(counts).toEqual({ aborted: 2, missing: 2, invalid: 2 });
      expect(errors).toEqual([]);
      console.log(JSON.stringify({ width, height: 900, theme, counts, overflowChecks: 3, keyboardChecks: 10, pageErrors: errors.length }));
    } finally { await context.close(); }
  }, 20_000);
}
