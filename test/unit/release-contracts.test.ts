import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const local = readFileSync(new URL("../../scripts/release.sh", import.meta.url), "utf8");
const ci = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const installer = readFileSync(new URL("../../site/install.sh", import.meta.url), "utf8");

// Execute only the source AWK program, never either release entrypoint.
function notes(source: string, tag: string, input: string) {
  const match = source.match(/awk -v t="## \$(?:tag|GITHUB_REF_NAME)" '([\s\S]*?)' CHANGELOG\.md/);
  if (!match) throw new Error("release notes AWK contract missing");
  const result = Bun.spawnSync(["awk", "-v", `t=## ${tag}`, match[1]!], {
    stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  return { status: result.exitCode, text: new TextDecoder().decode(result.stdout) };
}
const versions = ["v0.2.0-pre.11", "v0.2.0-pre.10", "v0.2.0-pre.1", "v0.2.0"];
const section = (v: string) => `## ${v}\nnotes for ${v}\n### Details\nbody\n`;
for (const [name, source] of [["local", local], ["CI", ci]] as const) {
  describe(`${name} exact release notes`, () => {
    for (const tag of versions) test(tag, () => {
      expect(notes(source, tag, "## Unreleased\nfuture\n" + versions.map(section).join("")))
        .toEqual({ status: 0, text: section(tag) });
    });
    test("missing tag cannot match a longer version", () => {
      expect(notes(source, "v0.2.0-pre.1", section("v0.2.0-pre.11")).status).not.toBe(0);
    });
    test("version punctuation is literal", () => {
      expect(notes(source, "v0.2.0", section("v0x2x0")).status).not.toBe(0);
    });
    test("explicit unreleased suffix is accepted", () => {
      const input = section("v0.2.0-pre.11 (unreleased)");
      expect(notes(source, "v0.2.0-pre.11", input)).toEqual({ status: 0, text: input });
    });
    test("other suffixes are rejected", () => {
      for (const suffix of [" extra", " (released)", "-pre.1", "0", " (unreleased) extra"]) {
        expect(notes(source, "v0.2.0", section(`v0.2.0${suffix}`)).status).not.toBe(0);
      }
    });
    test("duplicate sections fail without returning ambiguous notes", () => {
      for (const second of ["v0.2.0", "v0.2.0 (unreleased)"]) {
        expect(notes(source, "v0.2.0", section("v0.2.0") + section(second)))
          .toEqual({ status: 1, text: "" });
      }
    });
    test("notes validation precedes installs/build; saved notes are published", () => {
      expect(source.indexOf("notes=$(awk")).toBeGreaterThan(-1);
      expect(source.indexOf("notes=$(awk")).toBeLessThan(source.indexOf("bun install"));
      if (name === "local") expect(source).toContain('printf \'%s\\n\' "$notes" > dist/NOTES.md');
      else {
        expect(source).toContain('printf \'%s\\n\' "$notes" > "$RUNNER_TEMP/walkie-release-notes.md"');
        expect(source).toContain('cp "$RUNNER_TEMP/walkie-release-notes.md" dist/NOTES.md');
      }
    });
  });
}

// Only these two command lines enter the fixture; their executables are synthetic stubs.
function gateLines(source: string) {
  return source.split("\n").map(line => line.trim()).filter(line =>
    line.startsWith("scripts/smoke-binary.sh ") || line === "bun scripts/discovery-package-check.ts");
}
for (const [name, source] of [["local", local], ["CI", ci]] as const) {
  test(`${name} mandatory packaging gates occur after build and before signing`, () => {
    expect(gateLines(source)).toEqual([
      'scripts/smoke-binary.sh dist/walkie-darwin-arm64 "$ver"',
      "bun scripts/discovery-package-check.ts",
    ]);
    expect(source.indexOf("scripts/smoke-binary.sh")).toBeGreaterThan(source.indexOf("bun scripts/build.ts"));
    expect(source.indexOf("bun scripts/discovery-package-check.ts")).toBeLessThan(source.indexOf("bun scripts/sign-release.ts"));
  });
  test(`${name} gate failures stop the release sequence (stubs only)`, () => {
    expect(gateLines(source)).toHaveLength(2);
    const dir = mkdtempSync(join(tmpdir(), "release-contract-"));
    try {
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts/smoke-binary.sh"), '#!/bin/sh\n[ "$1" = dist/walkie-darwin-arm64 ] && [ "$2" = 0.2.0 ] || exit 90\nexit "$SMOKE_STATUS"\n', { mode: 0o700 });
      writeFileSync(join(dir, "bun"), '#!/bin/sh\n[ "$1" = scripts/discovery-package-check.ts ] || exit 91\nexit "$DISCOVERY_STATUS"\n', { mode: 0o700 });
      for (const [smoke, discovery, expected] of [[0, 0, 0], [7, 0, 7], [0, 8, 8]]) {
        const result = Bun.spawnSync(["/bin/sh", "-ec", `ver=0.2.0\n${gateLines(source).join("\n")}\nprintf reached`], {
          cwd: dir, env: { ...process.env, PATH: dir, SMOKE_STATUS: String(smoke), DISCOVERY_STATUS: String(discovery) }, stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode).toBe(expected!);
        expect(new TextDecoder().decode(result.stdout)).toBe(expected === 0 ? "reached" : "");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test("CI explicitly publishes to the configured public release repository", () => {
  const repo = installer.match(/REPO="\$\{WALKIE_REPO:-([^}]+)\}"/)![1]!;
  expect(local).toContain(`WALKIE_RELEASE_REPO:-${repo}`);
  expect(ci).toContain(`repository: ${repo}`);
  expect(ci).toContain("token: ${{ secrets.WALKIE_RELEASE_TOKEN }}");
});
test("local and CI both install site's dependencies before the tests: site/test is part of the suite", () => {
  for (const source of [local, ci]) expect(source).toContain("(cd site && bun install --frozen-lockfile");
  expect(local.indexOf("(cd site && bun install")).toBeLessThan(local.indexOf("bun test"));
  expect(ci.indexOf("(cd site && bun install")).toBeLessThan(ci.indexOf("bun test"));
});
