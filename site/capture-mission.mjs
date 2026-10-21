// Capture the fictional Kestrel team's Home (v0.2.0-pre.19's first page; it replaced Mission Control) from the built dashboard.
// Run with BASE=http://127.0.0.1:7495 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node site/capture-mission.mjs <png dir>
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.env.BASE ?? "http://127.0.0.1:7495";
const out = process.argv[2] ?? ".";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const shot of [
    { name: "mission-dark", width: 1440, height: 900 },
    { name: "mission-m-dark", width: 390, height: 660 },
  ]) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, colorScheme: "dark" });
    await page.goto(base + "/auth", { waitUntil: "domcontentloaded" });
    await page.locator(".conn-live").first().waitFor({ state: "attached" });
    const gotIt = page.getByRole("button", { name: "Got it" });
    if (await gotIt.isVisible()) await gotIt.click();
    await page.getByText(/Needs you/).first().waitFor();
    await page.waitForTimeout(2200);
    await page.mouse.move(Math.round(shot.width / 2), 20); // empty space above the page title: no hover highlight
    await page.screenshot({ path: join(out, `${shot.name}.png`) });
    console.log(`captured ${shot.name}: ${shot.width}x${shot.height}`);
    await page.close();
  }
} finally { await browser.close(); }
