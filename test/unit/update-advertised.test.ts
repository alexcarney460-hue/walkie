// WALK-58 (UPDATE-PRE-1): a pre-release `walkie update` follows the release the site's installer advertises, the one
// `DEFAULT_VERSION="vX.Y.Z[-pre]"` line of scripts/install.sh (site/build.py reads the same line for the landing page).
// These are the pure pieces: what counts as a pre-release, and how that one line is read out of the installer's text.
// The whole command against a stand-in site and GitHub is in update-channel.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VERSION_LINE, isPreRelease, parseAdvertisedTag } from "../../src/cli/commands/update.ts";
import { RELEASE_TAG_RE } from "../../src/protocol/add-machine.ts";

const repo = (...p: string[]) => join(import.meta.dir, "..", "..", ...p);
const installer = (...lines: string[]) => ["#!/bin/sh", "set -eu", 'REPO="${WALKIE_REPO:-owner/walkie-releases}"', ...lines, 'VERSION="${WALKIE_VERSION:-$DEFAULT_VERSION}"', ""].join("\n");

describe("isPreRelease", () => {
  test("a version with a pre-release part is one; a release, or one with build metadata only, is not", () => {
    expect(isPreRelease("0.2.0-pre.11")).toBe(true);
    expect(isPreRelease("v0.2.0-pre.9.1")).toBe(true);
    expect(isPreRelease("0.2.0-rc.1")).toBe(true);
    expect(isPreRelease("0.2.0")).toBe(false);
    expect(isPreRelease("v0.1.3")).toBe(false);
    expect(isPreRelease("0.2.0+build-7")).toBe(false); // a "-" inside build metadata is not a pre-release part
    expect(isPreRelease("0.2.0-pre.1+build.7")).toBe(true);
  });
});

describe("parseAdvertisedTag", () => {
  test("reads the one DEFAULT_VERSION line, whatever surrounds it", () => {
    expect(parseAdvertisedTag(installer('DEFAULT_VERSION="v0.2.0-pre.11"'))).toEqual({ ok: true, tag: "v0.2.0-pre.11" });
    expect(parseAdvertisedTag(installer("# the release a plain install gets", 'DEFAULT_VERSION="v0.3.0"'))).toEqual({ ok: true, tag: "v0.3.0" });
    expect(parseAdvertisedTag('DEFAULT_VERSION="v10.20.30-rc.1.2"')).toEqual({ ok: true, tag: "v10.20.30-rc.1.2" }); // no trailing newline
  });

  test("no DEFAULT_VERSION line at all is refused, naming what is missing", () => {
    const r = parseAdvertisedTag(installer());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no DEFAULT_VERSION/);
    expect(parseAdvertisedTag("").ok).toBe(false);
  });

  test("two lines are refused: the installer must name exactly one release", () => {
    const r = parseAdvertisedTag(installer('DEFAULT_VERSION="v0.2.0-pre.11"', 'DEFAULT_VERSION="v0.2.0-pre.12"'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2 DEFAULT_VERSION lines/);
  });

  test("a line that is not a release tag is refused as malformed, and is never half-read", () => {
    const bad = [
      'DEFAULT_VERSION="latest"', 'DEFAULT_VERSION=v0.2.0', "DEFAULT_VERSION='v0.2.0'", 'DEFAULT_VERSION="v0.2"', 'DEFAULT_VERSION="0.2.0"',
      'DEFAULT_VERSION="v0.2.0-"', 'DEFAULT_VERSION="v0.2.0 "', 'DEFAULT_VERSION="v0.2.0/../x"', 'DEFAULT_VERSION="v0.2.0-pre.11"; rm -rf ~',
      'DEFAULT_VERSION="v0.2.0-pre.11" # note', ' DEFAULT_VERSION="v0.2.0-pre.11"', 'DEFAULT_VERSION=""', 'DEFAULT_VERSION="v0.2.0-pre.11"\r',
    ];
    for (const line of bad) {
      const r = parseAdvertisedTag(installer(line));
      expect(r.ok, line).toBe(false);
      if (!r.ok) expect(r.reason, line).toMatch(/not a release tag|no DEFAULT_VERSION/);
    }
    // a comment that mentions it, or a use of it, is not a DEFAULT_VERSION line
    expect(parseAdvertisedTag(installer('# DEFAULT_VERSION="v0.2.0"', 'echo "DEFAULT_VERSION=v0.2.0"')).ok).toBe(false);
  });

  test("one valid line next to a malformed one still reads as that one line, like site/build.py", () => {
    expect(parseAdvertisedTag(installer('DEFAULT_VERSION="latest"', 'DEFAULT_VERSION="v0.2.0-pre.11"'))).toEqual({ ok: true, tag: "v0.2.0-pre.11" });
  });

  test("a tag the installer's pattern lets through but no release could have is refused as not a release tag, whatever its size", () => {
    const absurd: Array<[string, string]> = [
      ["a 900,000-character pre-release part", `v1.0.0-${"x".repeat(900_000)}`],
      ["a 900,000-digit version number", `v${"1".repeat(900_000)}.0.0`],
      ["a pre-release part one character past the 40 a release tag may have", `v0.2.0-${"a".repeat(41)}`],
      ["empty pre-release identifiers", "v1.0.0-.."],
      ["a trailing empty identifier", "v1.0.0-rc."],
      ["a leading empty identifier", "v1.0.0-.rc"],
    ];
    for (const [name, tag] of absurd) {
      expect(DEFAULT_VERSION_LINE.test(`DEFAULT_VERSION="${tag}"`), `${name} fits site/build.py's pattern`).toBe(true);
      const r = parseAdvertisedTag(installer(`DEFAULT_VERSION="${tag}"`));
      expect(r.ok, name).toBe(false);
      if (r.ok) continue;
      expect(r.reason, name).toMatch(/not a release tag/);
      expect(r.reason.length, name).toBeLessThan(200); // a short excerpt, never the whole tag
    }
  });

  test("every real shape of tag still passes, up to the 40 characters a pre-release part may have", () => {
    for (const tag of ["v0.2.0-pre.11", "v0.2.0-pre.10.1", "v0.2.0-pre.9.1", "v0.3.0", "v1.2.3", "v10.20.30-rc.1.2", "v0.2.0-rc-1", `v0.2.0-${"a".repeat(40)}`]) {
      expect(parseAdvertisedTag(installer(`DEFAULT_VERSION="${tag}"`)), tag).toEqual({ ok: true, tag });
    }
  });

  test("a malformed line is shown to the terminal without its control characters, and cut short", () => {
    const r = parseAdvertisedTag(installer(`DEFAULT_VERSION="\u001b[31m${"x".repeat(500)}"`));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain("\u001b");
      expect(r.reason.length).toBeLessThan(200);
    }
  });
});

describe("the contract with site/build.py and the installer", () => {
  test("the pattern is exactly the one site/build.py uses", () => {
    const py = readFileSync(repo("site", "build.py"), "utf8");
    const m = /^DEFAULT_VERSION = re\.compile\(r'(.+)', re\.MULTILINE\)$/m.exec(py);
    expect(m).not.toBeNull();
    expect(DEFAULT_VERSION_LINE.source).toBe(m?.[1] as string);
  });

  test("the installer in the repo, and the copy the site serves, each name exactly one release tag", () => {
    for (const file of [repo("scripts", "install.sh"), repo("site", "install.sh")]) {
      const text = readFileSync(file, "utf8");
      const r = parseAdvertisedTag(text);
      expect(r.ok, file).toBe(true);
      if (!r.ok) continue;
      expect(RELEASE_TAG_RE.test(r.tag), `${file}: ${r.tag}`).toBe(true);
      expect(text.split("\n").filter((l) => l.startsWith("DEFAULT_VERSION=")).length, file).toBe(1);
    }
  });
});
