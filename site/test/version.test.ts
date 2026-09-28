// SITE-2: the version the landing page names is the one its installer installs. Both come from one line,
// DEFAULT_VERSION in scripts/install.sh; build.py copies the installer and renders the footer from it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..");
const installer = readFileSync(join(SITE, "..", "scripts", "install.sh"), "utf8");

describe("installer version and the page", () => {
  test("the served installer is the source installer", () => {
    expect(readFileSync(join(SITE, "install.sh"), "utf8")).toBe(installer);
  });

  test("the footer names the installer's default release", () => {
    const tag = /^DEFAULT_VERSION="(v[^"]+)"$/m.exec(installer)?.[1];
    expect(tag).toMatch(/^v\d+\.\d+\.\d+/);
    const page = readFileSync(join(SITE, "index.html"), "utf8");
    const label = tag!.slice(1) + (tag!.includes("-") ? " (pre-release)" : "");
    expect(page).toContain(`Version ${label}.`);
    expect(page).toContain(`Installs version ${label}.`);
    expect(readFileSync(join(SITE, "src", "index.html"), "utf8")).toContain("Version {{release}}.");
  });
});
