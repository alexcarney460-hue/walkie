// Render the social card from committed local assets and brand.json.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const site = new URL("./", import.meta.url);
const brand = JSON.parse(await readFile(new URL("brand.json", site), "utf8"));
const font = await readFile(new URL("assets/fonts/archivo-var-latin.woff2", site));
const body = await readFile(new URL("assets/fonts/geist-sans-latin-500-normal.woff2", site));
const radio = await readFile(new URL("assets/img/hf-hero-radio-1920.webp", site));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>
@font-face{font-family:Archivo;src:url(data:font/woff2;base64,${font.toString("base64")})}
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${body.toString("base64")})}
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;overflow:hidden;background:#211f1d;color:#f2eee7;font-family:Geist,sans-serif}
.card{position:relative;width:100%;height:100%;padding:62px 72px;background:radial-gradient(circle at 78% 48%,#49331d 0%,#211f1d 50%)}
.radio{position:absolute;right:-20px;top:-20px;width:1200px;height:670px;object-fit:cover;mask-image:linear-gradient(90deg,transparent,#111 50%,#111 96%,transparent)}
.copy{position:relative;z-index:1}.brand{display:flex;align-items:center;gap:13px;font:700 27px Archivo,sans-serif}.mark{display:grid;place-items:center;width:36px;height:36px;border:1px solid #8d784c;border-radius:10px;background:#292a28;color:#f4b857;font-size:22px;line-height:1}
.eyebrow{margin-top:85px;color:#f4b857;font:500 17px Geist,sans-serif;letter-spacing:.15em;text-transform:uppercase}
h1{margin:18px 0 0;max-width:680px;font:800 87px/.94 Archivo,sans-serif;letter-spacing:-.04em}h1 span{color:#f4b857}
.sub{margin-top:32px;max-width:530px;color:#c5bfb4;font-size:22px;line-height:1.4}
.rule{position:absolute;left:72px;right:72px;bottom:49px;height:1px;background:#76634a;opacity:.55}
</style><div class="card"><img class="radio" src="data:image/webp;base64,${radio.toString("base64")}" alt=""><div class="copy"><div class="brand"><span class="mark">≋</span>${brand.name}</div><div class="eyebrow">One live view for your team</div><h1>Every agent.<br><span>One channel.</span></h1><div class="sub">${brand.tagline}.</div></div><div class="rule"></div></div></html>`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: process.argv[2] ?? join(process.cwd(), "og.png") });
} finally { await browser.close(); }
