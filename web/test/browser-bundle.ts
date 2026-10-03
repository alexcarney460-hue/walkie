// Bundles a browser test's fixture (a `.tsx` source whose imports are absolute paths into this repo) for the Playwright tests.
// The build runs in a process of its own (browser-bundle-worker.ts): several tests in one `bun test` process each need a build, and
// Bun.build in the test process itself fails for every build after the first (`EISDIR reading file …/react/index.js`).
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Writes `source` to `<dir>/fixture.tsx`, bundles it to `<dir>/built/fixture.js` and `fixture.css`, and returns where they are. */
export async function bundleFixture(source: string, dir: string, root: string): Promise<{ js: string; css: string }> {
  const entry = join(dir, "fixture.tsx");
  await Bun.write(entry, source);
  const config = join(dir, "bundle.json");
  await Bun.write(config, JSON.stringify({ entry, outdir: join(dir, "built"), root, tsconfig: join(root, "web/tsconfig.json") }));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "browser-bundle-worker.ts"), config], {
    cwd: root, env: { ...process.env }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`bundling the fixture failed (exit ${exit}):\n${stdout}${stderr}`);
  return { js: join(dir, "built", "fixture.js"), css: join(dir, "built", "fixture.css") };
}

/**
 * The offline browser the Playwright tests drive (supplied on the Sparks under /usr/local), or null when any part of it is
 * missing here: such a test then skips instead of failing to start node. WALKIE_PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH
 * point at another playwright-core entry and browsers. A machine that must run these tests sets WALKIE_TEST_BROWSER_REQUIRED=1:
 * a missing part is then an error naming it, so a moved or upgraded browser cannot quietly turn the tests into skips.
 */
export function browserTooling(): { node: string; playwright: string; browsers: string } | null {
  const tools = {
    node: "/usr/local/bin/node",
    playwright: process.env.WALKIE_PLAYWRIGHT_MODULE ?? "/usr/local/libexec/walkie/tooling/playwright-core-1.61.0/index.mjs",
    browsers: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/usr/local/libexec/walkie/browsers",
  };
  const missing = Object.values(tools).filter((path) => !existsSync(path));
  if (missing.length === 0) return tools;
  if (process.env.WALKIE_TEST_BROWSER_REQUIRED === "1") {
    throw new Error(`WALKIE_TEST_BROWSER_REQUIRED=1 but the offline browser tooling is missing: ${missing.join(", ")}`);
  }
  return null;
}
