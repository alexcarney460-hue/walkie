// Real dark product captures from the fictional Kestrel mock, with no live customer data.
// Start the mock with WALKIE_MOCK_CAPTURE=1 so release strings and available seats match this site's proof.
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.env.BASE ?? "http://127.0.0.1:7495";
const out = process.argv[2] ?? ".";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const shots = [
  { name: "team-dark", width: 768, height: 366, hash: "#/team", ready: "#machines-h" },
  { name: "machine-dark", width: 1142, height: 570, hash: "#/mission", ready: ".mh" },
  { name: "pool-dark", width: 768, height: 560, hash: "#/team?tab=models", ready: "#models-h" },
  { name: "phone-dark", width: 390, height: 844, hash: "#/mission", ready: ".agent-card" },
];
try {
  for (const shot of shots) {
    const phone = shot.name === "phone-dark";
    const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 900 }, colorScheme: "dark", deviceScaleFactor: 1 });
    await page.goto(base + "/auth", { waitUntil: "domcontentloaded" });
    await page.locator(".conn-live").first().waitFor({ state: "attached" });
    const gotIt = page.getByRole("button", { name: "Got it" });
    if (await gotIt.isVisible()) await gotIt.click();
    await page.evaluate((hash) => { location.hash = hash; }, shot.hash);
    if (shot.name === "machine-dark") {
      const link = page.locator('a[aria-label^="atlas, "]').first();
      await link.waitFor();
      await link.click();
    }
    await page.locator(shot.ready).first().waitFor({ state: "attached" });
    await page.waitForTimeout(1700);
    await page.locator(shot.ready).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    if (phone) {
      await page.evaluate(() => scrollBy(0, -100));
      await page.screenshot({ path: join(out, "phone-dark.png") });
      console.log("captured phone-dark: 390x844");
      await page.close();
      continue;
    }
    const top = await page.locator(shot.ready).first().evaluate((el) => el.getBoundingClientRect().top);
    const x = 266;
    const y = Math.max(0, Math.min(900 - shot.height, Math.round(top - 24)));
    await page.screenshot({ path: join(out, `${shot.name}.png`), clip: { x, y, width: shot.width, height: shot.height } });
    console.log(`captured ${shot.name}: ${shot.width}x${shot.height}; target top ${Math.round(top)}`);
    await page.close();
  }
} finally { await browser.close(); }
