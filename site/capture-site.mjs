// Real dark product captures from the fictional Kestrel mock, with no live customer data.
// Start the mock with WALKIE_MOCK_CAPTURE=1 so release strings and available seats match this site's proof.
// Routes are the v0.2.0-pre.19 dashboard's: Home, Settings > Team and billing, Settings > Local models.
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.env.BASE ?? "http://127.0.0.1:7495";
const out = process.argv[2] ?? ".";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const shots = [
  // A narrower window so the whole Machines table (machine, owner, status, open) fits the 768-wide crop.
  { name: "team-dark", width: 768, height: 366, viewport: 1068, hash: "#/team", ready: "#machines-h" },
  // From "Live stats" down, so the header row with the mock's version string stays out of the picture.
  { name: "machine-dark", width: 1142, height: 570, viewport: 1440, hash: "#/home", ready: "#mg-h" },
  { name: "pool-dark", width: 768, height: 560, viewport: 1440, hash: "#/settings?tab=models", ready: ".lm-card", center: true },
  { name: "phone-dark", width: 390, height: 844, viewport: 390, hash: "#/home", ready: "#home-needs-title" },
];
try {
  for (const shot of shots) {
    const phone = shot.name === "phone-dark";
    const page = await browser.newPage({ viewport: { width: shot.viewport, height: phone ? 844 : 900 }, colorScheme: "dark", deviceScaleFactor: 1 });
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
    if (phone) {
      await page.mouse.move(5, 5);
      await page.screenshot({ path: join(out, "phone-dark.png") });
      console.log("captured phone-dark: 390x844");
      await page.close();
      continue;
    }
    await page.locator(shot.ready).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await page.mouse.move(shot.viewport - 5, 895);
    const box = await page.locator(shot.ready).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; });
    const left = shot.center ? box.left + (box.width - shot.width) / 2 : box.left - 12;
    const x = Math.max(0, Math.min(shot.viewport - shot.width, Math.round(left)));
    const y = Math.max(0, Math.min(900 - shot.height, Math.round(box.top - 24)));
    await page.screenshot({ path: join(out, `${shot.name}.png`), clip: { x, y, width: shot.width, height: shot.height } });
    console.log(`captured ${shot.name}: ${shot.width}x${shot.height} at ${x},${y}; target top ${Math.round(box.top)}`);
    await page.close();
  }
} finally { await browser.close(); }
