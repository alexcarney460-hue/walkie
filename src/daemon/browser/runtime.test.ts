import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBrowserModule } from "./runtime.ts";

test("Playwright resolves only from the Walkie data directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-browser-"));
  const mod = join(home, "browser", "node_modules", "playwright");
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  writeFileSync(join(mod, "index.js"), "export const chromium = { launch: () => 'fake' };\n");
  expect(((await resolveBrowserModule(home)) as unknown as { chromium: { launch(): string } }).chromium.launch()).toBe("fake");
  expect(await resolveBrowserModule(join(home, "missing"))).toBeNull();
});
