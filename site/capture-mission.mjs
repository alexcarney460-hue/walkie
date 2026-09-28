// Recaptures the landing page's Mission Control images from the web mock (the fictional team "Kestrel"):
// mission-{light,dark}.webp (1440x900), mission-m-{light,dark}.webp (390x660, the hero's phone crop) and og.jpg
// (the 1440x756 desktop layout at 1200x630, dark). Run against a fresh mock with the dashboard built:
//   bun run web:build && WALKIE_MOCK_PORT=7495 WALKIE_MOCK_PLAN=team bun web/mock/server.ts &
//   BASE=http://127.0.0.1:7495 node site/capture-mission.mjs <png dir>
// then encode: cwebp -q 82 <png> -o site/assets/img/<name>.webp; og: sips -s format jpeg -s formatOptions 70.
// Needs Playwright (PLAYWRIGHT_MODULE=/path/to/node_modules/playwright if it isn't installed here).
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:7495";
const out = process.argv[2] ?? ".";

const SHOTS = [
  { name: "mission-light", width: 1440, height: 900, scheme: "light" },
  { name: "mission-dark", width: 1440, height: 900, scheme: "dark" },
  { name: "mission-m-light", width: 390, height: 660, scheme: "light" },
  { name: "mission-m-dark", width: 390, height: 660, scheme: "dark" },
  // og: the desktop layout (1440x756) rendered at 1200x630
  { name: "og", width: 1440, height: 756, scheme: "dark", scale: 1200 / 1440 },
];

const browser = await chromium.launch();
for (const s of SHOTS) {
  const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, colorScheme: s.scheme, deviceScaleFactor: s.scale ?? 1 });
  await page.goto(BASE + "/auth");
  await page.locator(".conn-live").first().waitFor({ state: "attached" });
  await page.getByText(/Needs you/).first().waitFor();
  await page.waitForTimeout(2500); // let the live activity fill in
  await page.mouse.move(s.width - 5, s.height - 5);
  await page.screenshot({ path: join(out, `${s.name}.png`) });
  await page.close();
  console.log(`captured ${s.name} ${s.width}x${s.height} ${s.scheme}`);
}
await browser.close();
