import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetName, checkSignedVersion, checksumFor, compareVersions, newer, sameVersion, swapBinary } from "../../src/cli/commands/update.ts";

// Release gate 2026-09-26 (Codex 3 / Fable 3): a signed prerelease is not the advertised stable release, and
// update eligibility orders prereleases before their release (0.2.0-rc.1 < 0.2.0).
test("compareVersions orders prereleases before the release and by identifier (semver §11); build metadata is ignored", () => {
  expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
  expect(compareVersions("v0.2.0", "0.2.0-rc.1")).toBe(1);
  expect(compareVersions("0.2.0-rc.1", "0.2.0-rc.2")).toBe(-1);
  expect(compareVersions("0.2.0-rc.10", "0.2.0-rc.9")).toBe(1);
  expect(compareVersions("0.2.0-alpha", "0.2.0-beta")).toBe(-1);
  expect(compareVersions("0.2.0-alpha", "0.2.0-alpha.1")).toBe(-1);
  expect(compareVersions("0.2.0-1", "0.2.0-alpha")).toBe(-1); // numeric identifiers sort before alphanumeric ones
  expect(compareVersions("0.2.0+build.7", "0.2.0")).toBe(0);
  expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
  expect(compareVersions("0.1.9", "0.2.0-rc.1")).toBe(-1);
  expect(newer("0.2.0", "0.2.0-rc.1")).toBe(true);
  expect(newer("0.2.0-rc.1", "0.2.0")).toBe(false);
  expect(newer("0.2.0-rc.1", "0.2.0-rc.1")).toBe(false);
});

test("sameVersion is exact (a leading v aside): a prerelease never equals its release", () => {
  expect(sameVersion("v0.2.0", "0.2.0")).toBe(true);
  expect(sameVersion("v0.2.0-rc.1", "0.2.0-rc.1")).toBe(true);
  expect(sameVersion("0.2.0-rc.1", "0.2.0")).toBe(false);
  expect(sameVersion("v0.2.0", "v0.2.0-rc.1")).toBe(false);
});

test("checkSignedVersion: a signed prerelease served for an advertised stable tag is refused; a stable release updates an installed prerelease", () => {
  const sums = (v: string) => `version ${v}\n${"a".repeat(64)}  walkie-darwin-arm64\n`;
  // v0.2.0 advertised, the host serves the previously signed v0.2.0-rc.1: not the release asked for
  expect(checkSignedVersion(sums("v0.2.0-rc.1"), { tag: "v0.2.0", installed: "0.1.0", allowDowngrade: false })).toMatchObject({ ok: false, reason: expect.stringContaining("v0.2.0-rc.1") });
  // 0.2.0-rc.1 installed, stable v0.2.0 released: an update, not "up to date"
  expect(checkSignedVersion(sums("v0.2.0"), { tag: "v0.2.0", installed: "0.2.0-rc.1", allowDowngrade: false })).toEqual({ ok: true, version: "v0.2.0" });
  expect(checkSignedVersion(sums("v0.2.0"), { tag: null, installed: "0.2.0-rc.1", allowDowngrade: false })).toEqual({ ok: true, version: "v0.2.0" });
  // the same prerelease again: up to date
  expect(checkSignedVersion(sums("v0.2.0-rc.1"), { tag: null, installed: "0.2.0-rc.1", allowDowngrade: false })).toMatchObject({ ok: false, reason: "up_to_date" });
  // 0.2.0 installed, a mirror serving the signed rc: a downgrade
  expect(checkSignedVersion(sums("v0.2.0-rc.1"), { tag: null, installed: "0.2.0", allowDowngrade: false })).toMatchObject({ ok: false, reason: expect.stringContaining("downgrade") });
});

test("semver comparison", () => {
  expect(newer("v0.2.0", "0.1.9")).toBe(true);
  expect(newer("0.1.10", "0.1.9")).toBe(true);
  expect(newer("v0.1.0", "0.1.0")).toBe(false);
  expect(newer("0.1.0-rc1", "0.1.0")).toBe(false);
  expect(newer("1.0.0", "0.99.99")).toBe(true);
});

test("asset names match the release build matrix", () => {
  expect(assetName("darwin", "arm64")).toBe("walkie-darwin-arm64");
  expect(assetName("linux", "x64")).toBe("walkie-linux-x86_64");
  expect(() => assetName("win32", "x64")).toThrow();
});

test("checksum lookup is exact and rejects malformed lines", () => {
  const sums = `version v0.1.0\n${"a".repeat(64)}  walkie-darwin-arm64\n${"b".repeat(64)}  walkie-darwin-arm64.sig\nzz  walkie-linux-x86_64\n`;
  expect(checksumFor(sums, "walkie-darwin-arm64")).toBe("a".repeat(64));
  expect(checksumFor(sums, "walkie-linux-x86_64")).toBeNull();
  expect(checksumFor(sums, "walkie-linux-arm64")).toBeNull();
});

// FINAL-2 Codex 5 + Fable 2: the signed version line binds the artifacts to the release asked for.
test("checkSignedVersion: the signed version must match the requested tag and be newer than the installed one", () => {
  const sums = (v: string) => `version ${v}\n${"a".repeat(64)}  walkie-darwin-arm64\n`;
  expect(checkSignedVersion(sums("v0.2.0"), { tag: "v0.2.0", installed: "0.1.0", allowDowngrade: false })).toEqual({ ok: true, version: "v0.2.0" });
  // a newer tag advertised, an older signed release served back
  expect(checkSignedVersion(sums("v0.1.0"), { tag: "v0.2.0", installed: "0.1.0", allowDowngrade: false })).toMatchObject({ ok: false, reason: expect.stringContaining("v0.1.0") });
  // no version line at all (a pre-binding release): refused
  expect(checkSignedVersion(`${"a".repeat(64)}  walkie-darwin-arm64\n`, { tag: "v0.2.0", installed: "0.1.0", allowDowngrade: false })).toMatchObject({ ok: false, reason: expect.stringContaining("version") });
  // a mirror (no tag): the signed version rules, but never a downgrade unless asked for
  expect(checkSignedVersion(sums("v0.2.0"), { tag: null, installed: "0.1.0", allowDowngrade: false })).toEqual({ ok: true, version: "v0.2.0" });
  expect(checkSignedVersion(sums("v0.0.9"), { tag: null, installed: "0.1.0", allowDowngrade: false })).toMatchObject({ ok: false, reason: expect.stringContaining("downgrade") });
  expect(checkSignedVersion(sums("v0.0.9"), { tag: null, installed: "0.1.0", allowDowngrade: true })).toEqual({ ok: true, version: "v0.0.9" });
  expect(checkSignedVersion(sums("v0.1.0"), { tag: null, installed: "0.1.0", allowDowngrade: false })).toMatchObject({ ok: false, reason: "up_to_date" });
  // an explicit tag that is a downgrade needs --allow-downgrade too
  expect(checkSignedVersion(sums("v0.0.9"), { tag: "v0.0.9", installed: "0.1.0", allowDowngrade: false })).toMatchObject({ ok: false, reason: expect.stringContaining("downgrade") });
});

// After the swap the new binary must report the signed version, or the kept copy of the old one comes back.
test("swapBinary: a binary that reports another version is rolled back from the kept copy; a matching one stays", async () => {
  const dir = mkdtempSync("/tmp/walkie-swap-");
  try {
    const target = join(dir, "walkie");
    const script = (v: string) => `#!/bin/sh\n[ "$1" = version ] && echo "walkie ${v}"\n`;
    writeFileSync(target, script("0.1.0"), { mode: 0o755 });
    chmodSync(target, 0o755);
    const wrong = await swapBinary(target, new TextEncoder().encode(script("0.0.1")), "v0.2.0");
    expect(wrong.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(script("0.1.0")); // restored
    expect(existsSync(join(dir, ".walkie-prev"))).toBe(false); // the kept copy is gone
    const right = await swapBinary(target, new TextEncoder().encode(script("0.2.0")), "v0.2.0");
    expect(right.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(script("0.2.0"));
    expect(existsSync(join(dir, ".walkie-prev"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
