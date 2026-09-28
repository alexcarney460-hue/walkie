// Seats round 9 (docs/audits/2026-09-26-*-seats-r9.md), unit level: an access check that fails (not a denial) never
// lets a sweep call itself verified (Codex r9 MEDIUM 3).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FsatError } from "../../src/daemon/seats/fsat.ts";
import { fakeOwned } from "../../src/daemon/seats/runner-sweep.ts";
import { sweepVerified } from "../../src/daemon/seats/sweep.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const tmp = () => { const d = mkdtempSync("/tmp/walkie-r9-"); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

describe("Codex r9 MEDIUM 3: the sweep's access check", () => {
  // A shared root holding another owner's directory, inside which the seat left a file.
  const world = () => {
    const root = tmp();
    mkdirSync(join(root, "other-shared"));
    writeFileSync(join(root, "other-shared", "seat-left"), "x");
    return { root, owned: fakeOwned("seat", process.getuid?.() ?? -1) };
  };

  test("a check that fails for another reason than a denial is a problem: not verified, nothing skipped silently", () => {
    const { root, owned } = world();
    const r = sweepVerified([{ path: root }], owned, { canWrite: () => { throw new FsatError("EIO", "faccessat"); } });
    expect(r.verified).toBe(false);
    expect(r.problems.join(" ")).toMatch(/other-shared: EIO/);
    expect(existsSync(join(root, "other-shared", "seat-left"))).toBe(true);
  });

  test("a denial skips the directory (the seat couldn't have written there); an allowed one is walked and cleaned", () => {
    const denied = world();
    expect(sweepVerified([{ path: denied.root }], denied.owned, { canWrite: () => false })).toMatchObject({ verified: true, problems: [] });
    const allowed = world();
    const r = sweepVerified([{ path: allowed.root }], allowed.owned, { canWrite: () => true });
    expect(r.verified).toBe(true);
    expect(existsSync(join(allowed.root, "other-shared", "seat-left"))).toBe(false);
  });

  test("the real check (faccessat) lets a directory this process may write be walked", () => {
    const { root, owned } = world();
    // The default canWriteAt (faccessat): this process may write its own temporary directory.
    const r = sweepVerified([{ path: root }], owned);
    expect(r.verified).toBe(true);
    expect(existsSync(join(root, "other-shared", "seat-left"))).toBe(false);
  });
});
